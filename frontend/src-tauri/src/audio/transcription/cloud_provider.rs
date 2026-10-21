use super::provider::{TranscriptionError, TranscriptionProvider, TranscriptResult};
use async_trait::async_trait;
use bytes::Bytes;
use reqwest::multipart::{Form, Part};
use reqwest::{Body, Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const SAMPLE_RATE: u32 = 16_000;
const MAX_RETRIES: u32 = 2;
const MAX_RETRY_WAIT_SECS: u64 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudSpeechService {
    OpenAI,
    OpenRouter,
}

impl CloudSpeechService {
    pub fn from_provider(provider: &str) -> Option<Self> {
        match provider {
            "openai-speech" => Some(Self::OpenAI),
            "openrouter-speech" => Some(Self::OpenRouter),
            _ => None,
        }
    }

    pub fn key_provider(self) -> &'static str {
        match self {
            Self::OpenAI => "openai",
            Self::OpenRouter => "openrouter",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::OpenAI => "OpenAI",
            Self::OpenRouter => "OpenRouter",
        }
    }

    fn base_url(self) -> &'static str {
        match self {
            Self::OpenAI => "https://api.openai.com/v1",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
        }
    }

    fn preferred_model(self) -> &'static str {
        match self {
            Self::OpenAI => "gpt-transcribe",
            Self::OpenRouter => "openai/gpt-transcribe",
        }
    }
}

pub struct CloudSpeechProvider {
    service: CloudSpeechService,
    base_url: String,
    api_key: String,
    model: String,
    client: Client,
    key_rejected: AtomicBool,
}

enum Failure {
    Retry(String, Option<Duration>),
    Final(String),
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

impl CloudSpeechProvider {
    pub fn new(service: CloudSpeechService, api_key: String, model: String) -> Self {
        Self::with_base_url(service, service.base_url().to_string(), api_key, model)
    }

    fn with_base_url(service: CloudSpeechService, base_url: String, api_key: String, model: String) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self { service, base_url, api_key, model, client, key_rejected: AtomicBool::new(false) }
    }

    fn rejected_key(&self) -> String {
        format!("{} rejected the API key. Check it in Settings > Models.", self.service.label())
    }

    fn form(&self, wav: Bytes, language: Option<&str>) -> Form {
        let file = Part::stream(Body::from(wav))
            .file_name("speech.wav")
            .mime_str("audio/wav")
            .expect("audio/wav is a valid mime type");
        let form = Form::new().text("model", self.model.clone()).part("file", file);
        match language {
            Some(language) if self.service == CloudSpeechService::OpenAI && self.model.starts_with("gpt-transcribe") => {
                form.text("languages[]", language.to_string())
            }
            Some(language) => form.text("language", language.to_string()),
            None => form,
        }
    }

    async fn send(&self, wav: &Bytes, seconds: f64, language: Option<&str>) -> Result<String, Failure> {
        let label = self.service.label();
        let response = self
            .client
            .post(format!("{}/audio/transcriptions", self.base_url))
            .bearer_auth(&self.api_key)
            .timeout(request_timeout(seconds))
            .multipart(self.form(wav.clone(), language))
            .send()
            .await
            .map_err(|error| {
                let message = format!("Could not reach {}: {}", label, error);
                if error.is_timeout() { Failure::Final(message) } else { Failure::Retry(message, None) }
            })?;

        let status = response.status();
        if status.is_success() {
            return response
                .json::<TranscriptionResponse>()
                .await
                .map(|body| body.text)
                .map_err(|error| Failure::Final(format!("{} sent a reply that could not be read: {}", label, error)));
        }

        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok())
            .map(|secs| Duration::from_secs(secs.min(MAX_RETRY_WAIT_SECS)));
        let body = response.text().await.unwrap_or_default();
        let detail = crate::assistant::service::provider_message(&body).unwrap_or_else(|| body.chars().take(200).collect());

        match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                self.key_rejected.store(true, Ordering::Relaxed);
                Err(Failure::Final(self.rejected_key()))
            }
            StatusCode::TOO_MANY_REQUESTS if body.contains("insufficient_quota") => {
                Err(Failure::Final(format!("{} account is out of credit: {}", label, detail)))
            }
            StatusCode::TOO_MANY_REQUESTS => Err(Failure::Retry(format!("{} is busy: {}", label, detail), retry_after)),
            status if status.is_server_error() => Err(Failure::Retry(format!("{} had a server error (HTTP {}): {}", label, status.as_u16(), detail), retry_after)),
            status => Err(Failure::Final(format!("{} could not transcribe this audio (HTTP {}): {}", label, status.as_u16(), detail))),
        }
    }
}

#[async_trait]
impl TranscriptionProvider for CloudSpeechProvider {
    async fn transcribe(
        &self,
        audio: Vec<f32>,
        language: Option<String>,
    ) -> std::result::Result<TranscriptResult, TranscriptionError> {
        if self.key_rejected.load(Ordering::Relaxed) {
            return Err(TranscriptionError::EngineFailed(self.rejected_key()));
        }
        let seconds = audio.len() as f64 / SAMPLE_RATE as f64;
        let wav = Bytes::from(encode_wav(&audio));
        drop(audio);
        let language = spoken_language(language.as_deref());
        let mut attempt = 0;
        loop {
            match self.send(&wav, seconds, language).await {
                Ok(text) => {
                    return Ok(TranscriptResult {
                        text: text.trim().to_string(),
                        confidence: None,
                        is_partial: false,
                    })
                }
                Err(Failure::Retry(_, wait)) if attempt < MAX_RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(wait.unwrap_or(Duration::from_secs(1 << (2 * (attempt - 1))))).await;
                }
                Err(Failure::Retry(message, _)) | Err(Failure::Final(message)) => {
                    return Err(TranscriptionError::EngineFailed(message))
                }
            }
        }
    }

    async fn is_model_loaded(&self) -> bool {
        true
    }

    async fn get_current_model(&self) -> Option<String> {
        Some(self.model.clone())
    }

    fn provider_name(&self) -> &'static str {
        self.service.label()
    }
}

fn request_timeout(seconds: f64) -> Duration {
    Duration::from_secs_f64((15.0 + seconds / 2.0).min(30.0))
}

fn spoken_language(language: Option<&str>) -> Option<&str> {
    match language.map(str::trim) {
        None | Some("") | Some("auto") | Some("auto-translate") | Some("haw") => None,
        Some("jw") => Some("jv"),
        other => other,
    }
}

fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        wav.extend_from_slice(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes());
    }
    wav
}

#[derive(Deserialize, Serialize)]
pub struct ListedModel {
    id: String,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<ListedModel>,
}

fn is_file_transcription_model(id: &str) -> bool {
    id.contains("transcribe") && !["diarize", "realtime", "live"].iter().any(|word| id.contains(word))
}

fn speech_models(service: CloudSpeechService, ids: Vec<String>) -> Vec<ListedModel> {
    let mut ids: Vec<String> = ids
        .into_iter()
        .filter(|id| service == CloudSpeechService::OpenRouter || is_file_transcription_model(id))
        .collect();
    let preferred = service.preferred_model();
    ids.sort_by(|a, b| (a != preferred).cmp(&(b != preferred)).then_with(|| a.cmp(b)));
    ids.into_iter().map(|id| ListedModel { id }).collect()
}

#[tauri::command]
pub async fn get_cloud_speech_models(provider: String, api_key: Option<String>) -> Result<Vec<ListedModel>, String> {
    let service = CloudSpeechService::from_provider(&provider).ok_or_else(|| format!("Unknown speech service: {}", provider))?;
    let api_key = api_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .ok_or("API key is required")?;
    let ids = match service {
        CloudSpeechService::OpenAI => crate::openai::openai::list_model_ids(&api_key).await?,
        CloudSpeechService::OpenRouter => openrouter_speech_models(&api_key).await?,
    };
    Ok(speech_models(service, ids))
}

async fn openrouter_speech_models(api_key: &str) -> Result<Vec<String>, String> {
    let client = Client::new();
    crate::openrouter::openrouter::check_key(&client, api_key).await?;
    let response = client
        .get("https://openrouter.ai/api/v1/models?output_modalities=transcription")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenRouter: {}", error))?;
    if !response.status().is_success() {
        return Err(format!("OpenRouter rejected the request (HTTP {})", response.status()));
    }
    let list: ModelList = response
        .json()
        .await
        .map_err(|error| format!("Could not read the OpenRouter model list: {}", error))?;
    Ok(list.data.into_iter().map(|model| model.id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(replies: Vec<&'static str>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for reply in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let read = socket.read(&mut buffer).await.unwrap();
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8_lossy(&request).to_string());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            requests
        });
        (address, handle)
    }

    fn reply(status: &str, body: &str) -> &'static str {
        Box::leak(format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nRetry-After: 0\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body).into_boxed_str())
    }

    #[tokio::test]
    async fn sends_wav_audio_with_model_and_language_and_returns_the_text() {
        let (address, server) = serve(vec![reply("200 OK", r#"{"text":" Budget review moves to Friday. "}"#)]).await;
        let provider = CloudSpeechProvider::with_base_url(CloudSpeechService::OpenAI, address, "sk-test".into(), "gpt-transcribe".into());

        let result = provider.transcribe(vec![0.1; 16_000], Some("de".into())).await.unwrap();

        assert_eq!(result.text, "Budget review moves to Friday.");
        let request = &server.await.unwrap()[0];
        assert!(request.starts_with("POST /audio/transcriptions"));
        assert!(request.contains("authorization: Bearer sk-test") || request.contains("Authorization: Bearer sk-test"));
        assert!(request.contains("name=\"model\"\r\n\r\ngpt-transcribe"));
        assert!(request.contains("name=\"languages[]\"\r\n\r\nde"));
        assert!(request.contains("filename=\"speech.wav\""));
        assert!(request.contains("RIFF"));
    }

    #[tokio::test]
    async fn openrouter_gets_the_plain_language_field_and_auto_sends_none() {
        let (address, server) = serve(vec![
            reply("200 OK", r#"{"text":"hola"}"#),
            reply("200 OK", r#"{"text":"hello"}"#),
        ]).await;
        let provider = CloudSpeechProvider::with_base_url(CloudSpeechService::OpenRouter, address, "key".into(), "openai/gpt-transcribe".into());

        provider.transcribe(vec![0.0; 8_000], Some("es".into())).await.unwrap();
        provider.transcribe(vec![0.0; 8_000], Some("auto".into())).await.unwrap();

        let requests = server.await.unwrap();
        assert!(requests[0].contains("name=\"language\"\r\n\r\nes"));
        assert!(!requests[1].contains("name=\"language"));
    }

    #[tokio::test]
    async fn retries_busy_replies_then_succeeds() {
        let (address, server) = serve(vec![
            reply("429 Too Many Requests", r#"{"error":{"message":"slow down"}}"#),
            reply("503 Service Unavailable", "{}"),
            reply("200 OK", r#"{"text":"made it"}"#),
        ]).await;
        let provider = CloudSpeechProvider::with_base_url(CloudSpeechService::OpenAI, address, "k".into(), "gpt-transcribe".into());

        let result = provider.transcribe(vec![0.0; 1_600], None).await.unwrap();

        assert_eq!(result.text, "made it");
        assert_eq!(server.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_rejected_key_fails_at_once_with_a_clear_message() {
        let (address, server) = serve(vec![reply("401 Unauthorized", r#"{"error":{"message":"bad key"}}"#)]).await;
        let provider = CloudSpeechProvider::with_base_url(CloudSpeechService::OpenAI, address, "k".into(), "gpt-transcribe".into());

        let error = provider.transcribe(vec![0.0; 1_600], None).await.unwrap_err();

        assert!(error.to_string().contains("OpenAI rejected the API key"));
        let again = provider.transcribe(vec![0.0; 1_600], None).await.unwrap_err();
        assert!(again.to_string().contains("OpenAI rejected the API key"));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_empty_account_is_not_retried() {
        let (address, server) = serve(vec![reply("429 Too Many Requests", r#"{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}"#)]).await;
        let provider = CloudSpeechProvider::with_base_url(CloudSpeechService::OpenAI, address, "k".into(), "gpt-transcribe".into());

        let error = provider.transcribe(vec![0.0; 1_600], None).await.unwrap_err();

        assert!(error.to_string().contains("out of credit"));
        assert_eq!(server.await.unwrap().len(), 1);
    }

    #[test]
    fn wav_header_describes_16khz_mono_pcm() {
        let wav = encode_wav(&[0.0, 1.0, -1.0]);
        assert_eq!(wav.len(), 50);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(i16::from_le_bytes(wav[46..48].try_into().unwrap()), i16::MAX);
    }

    #[test]
    fn speech_model_lists_put_gpt_transcribe_first_and_drop_other_audio_models() {
        let ids = |service, listed: &[&str]| -> Vec<String> {
            speech_models(service, listed.iter().map(|id| id.to_string()).collect()).into_iter().map(|model| model.id).collect()
        };
        assert_eq!(
            ids(CloudSpeechService::OpenAI, &["gpt-5", "gpt-4o-transcribe", "gpt-transcribe", "gpt-4o-transcribe-diarize", "gpt-live-transcribe", "whisper-1"]),
            vec!["gpt-transcribe", "gpt-4o-transcribe"]
        );
        assert_eq!(
            ids(CloudSpeechService::OpenRouter, &["google/chirp-3", "openai/gpt-transcribe"]),
            vec!["openai/gpt-transcribe", "google/chirp-3"]
        );
    }
}

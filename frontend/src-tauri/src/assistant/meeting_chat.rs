use log::warn;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime};
use tokio_util::sync::CancellationToken;

use super::prompt::{self, ChatMessage, ChatRole};
use super::service::{self, truncate_to_tokens, ChatContext, RequestPlan};
use crate::audio::recording_saver::TranscriptSegment;
use crate::database::repositories::chat::MeetingChatRepository;
use crate::database::repositories::meeting::MeetingsRepository;
use crate::database::repositories::summary::SummaryProcessesRepository;
use crate::summary::llm_client::LLMProvider;
use crate::summary::processor::{clean_llm_markdown_detailed, plain_key_terms};
use crate::summary::service::{key_terms_from_result, stored_summary_result};

const LARGE_CONTEXT_INPUT_TOKENS: usize = 24000;
const ANSWER_TOKENS: u32 = 1000;
const MIN_INPUT_TOKENS: usize = 512;

static IN_FLIGHT: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(Default::default);

struct InFlight(String);

impl InFlight {
    fn claim(meeting_id: &str) -> Option<Self> {
        let mut guard = IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(meeting_id.to_string()).then(|| Self(meeting_id.to_string()))
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&self.0);
    }
}

pub fn is_answering(meeting_id: &str) -> bool {
    IN_FLIGHT.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(meeting_id)
}

#[derive(serde::Serialize)]
pub struct MeetingChat {
    messages: Vec<ChatMessage>,
    answering: bool,
    context: Option<ChatContext>,
}

fn message(role: ChatRole, text: String, error: bool) -> ChatMessage {
    ChatMessage { id: String::new(), role, text, error, cards_note: false }
}

pub async fn load<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) -> Result<MeetingChat, String> {
    let answering = is_answering(meeting_id);
    if !answering {
        add_recap(app, meeting_id).await?;
    }
    let budget = match service::resolve_request(app).await {
        Ok(plan) => Some(budget(&plan).await),
        Err(_) => None,
    };
    respond(app, meeting_id, answering, budget).await
}

pub async fn edit_key_terms<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, key_terms: &str) -> Result<String, String> {
    let key_terms = plain_key_terms(key_terms).ok_or_else(|| "Key terms cannot be empty".to_string())?;
    let pool = service::db_pool(app)?;
    if !MeetingChatRepository::set_key_terms(&pool, meeting_id, &key_terms).await.map_err(|e| e.to_string())? {
        return Err("This meeting has no key terms yet".to_string());
    }
    SummaryProcessesRepository::set_key_terms(&pool, meeting_id, &key_terms)
        .await
        .map_err(|e| e.to_string())?;
    Ok(key_terms)
}

pub async fn dismiss_error<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, message_id: &str) -> Result<(), String> {
    let position = message_id
        .strip_prefix('c')
        .and_then(|position| position.parse::<i64>().ok())
        .ok_or_else(|| format!("Unknown chat message: {}", message_id))?;
    let pool = service::db_pool(app)?;
    MeetingChatRepository::delete_error(&pool, meeting_id, position)
        .await
        .map_err(|e| e.to_string())
}

async fn respond<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, answering: bool, budget: Option<usize>) -> Result<MeetingChat, String> {
    let pool = service::db_pool(app)?;
    let messages = MeetingChatRepository::get_for_meeting(&pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    let context = budget.map(|budget| service::chat_context(&messages, budget));
    Ok(MeetingChat { messages, answering, context })
}

pub async fn ask<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, question: String) -> Result<MeetingChat, String> {
    let question = service::checked_question(question)?;
    turn(app, meeting_id, Some(question), ChatRole::Assistant, |plan, budget| answer(app, meeting_id, plan, budget)).await
}

pub async fn compact<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) -> Result<MeetingChat, String> {
    turn(app, meeting_id, None, ChatRole::Summary, |plan, budget| async move {
        let pool = service::db_pool(app)?;
        let chat = MeetingChatRepository::get_for_meeting(&pool, meeting_id)
            .await
            .map_err(|e| e.to_string())?;
        service::compact_chat(app, &plan, &chat, budget, &CancellationToken::new()).await
    })
    .await
}

async fn turn<R, F, Fut>(
    app: &AppHandle<R>,
    meeting_id: &str,
    question: Option<String>,
    role: ChatRole,
    work: F,
) -> Result<MeetingChat, String>
where
    R: Runtime,
    F: FnOnce(RequestPlan, usize) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let claim = InFlight::claim(meeting_id).ok_or_else(|| "Wait for the current answer".to_string())?;
    let pool = service::db_pool(app)?;
    if let Some(question) = question {
        MeetingChatRepository::append(&pool, meeting_id, &[message(ChatRole::User, question, false)])
            .await
            .map_err(|e| e.to_string())?;
    }
    let (result, budget) = match service::resolve_request(app).await {
        Ok(plan) => {
            let budget = budget(&plan).await;
            (work(plan, budget).await, Some(budget))
        }
        Err(error) => (Err(error), None),
    };
    let reply = match result {
        Ok(text) => message(role, text, false),
        Err(error) if role == ChatRole::Summary => return Err(service::short_error(&error)),
        Err(error) => {
            let error = service::short_error(&error);
            warn!("Meeting chat failed: {}", error);
            message(ChatRole::Assistant, error, true)
        }
    };
    MeetingChatRepository::append(&pool, meeting_id, &[reply])
        .await
        .map_err(|e| e.to_string())?;
    drop(claim);
    respond(app, meeting_id, is_answering(meeting_id), budget).await
}

async fn budget(plan: &RequestPlan) -> usize {
    match plan.provider_settings.provider {
        LLMProvider::OpenAI
        | LLMProvider::Claude
        | LLMProvider::OpenRouter
        | LLMProvider::ClaudeCode
        | LLMProvider::Codex => LARGE_CONTEXT_INPUT_TOKENS,
        LLMProvider::Ollama => service::input_budget(&plan.provider_settings, &plan.model)
            .await
            .saturating_sub(ANSWER_TOKENS as usize)
            .max(MIN_INPUT_TOKENS),
        _ => service::input_budget(&plan.provider_settings, &plan.model).await,
    }
}

async fn add_recap<R: Runtime>(app: &AppHandle<R>, meeting_id: &str) -> Result<(), String> {
    let pool = service::db_pool(app)?;
    if MeetingChatRepository::has_recap(&pool, meeting_id).await.map_err(|e| e.to_string())? {
        return Ok(());
    }
    let result = stored_result(&pool, meeting_id).await?;
    let summary = summary_markdown(result.as_ref());
    if summary.trim().is_empty() {
        return Ok(());
    }
    let key_terms = result.as_ref().and_then(key_terms_from_result);
    MeetingChatRepository::append_recap_once(&pool, meeting_id, key_terms.as_deref(), summary.trim())
        .await
        .map_err(|e| e.to_string())
}

async fn stored_result(pool: &sqlx::SqlitePool, meeting_id: &str) -> Result<Option<serde_json::Value>, String> {
    stored_summary_result(pool, meeting_id).await.map_err(|e| e.to_string())
}

async fn stored_summary(pool: &sqlx::SqlitePool, meeting_id: &str) -> Result<String, String> {
    Ok(summary_markdown(stored_result(pool, meeting_id).await?.as_ref()))
}

fn summary_markdown(result: Option<&serde_json::Value>) -> String {
    result
        .and_then(|value| value.get("markdown").and_then(|m| m.as_str()).map(|m| clean_llm_markdown_detailed(m).markdown))
        .unwrap_or_default()
}

async fn answer<R: Runtime>(app: &AppHandle<R>, meeting_id: &str, plan: RequestPlan, budget: usize) -> Result<String, String> {
    let pool = service::db_pool(app)?;
    let meeting = MeetingsRepository::get_meeting_metadata(&pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Meeting not found".to_string())?;
    let (transcripts, _) = MeetingsRepository::get_meeting_transcripts_paginated(&pool, meeting_id, i64::MAX, 0)
        .await
        .map_err(|e| e.to_string())?;
    let segments: Vec<TranscriptSegment> = transcripts
        .into_iter()
        .enumerate()
        .map(|(index, t)| {
            let start = t.audio_start_time.unwrap_or(0.0);
            TranscriptSegment {
                id: t.id,
                text: t.transcript,
                audio_start_time: start,
                audio_end_time: t.audio_end_time.unwrap_or(start),
                duration: t.duration.unwrap_or(0.0),
                display_time: t.timestamp,
                confidence: 1.0,
                sequence_id: index as u64,
            }
        })
        .collect();
    if segments.is_empty() {
        return Err("This meeting has no transcript yet".to_string());
    }
    let summary = stored_summary(&pool, meeting_id).await?;
    let chat = MeetingChatRepository::get_for_meeting(&pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;

    let request = service::ChatRequest {
        system_prompt: prompt::MEETING_CHAT_SYSTEM_PROMPT,
        prefix: prompt::build_meeting_prefix(&meeting.title, &truncate_to_tokens(&summary, budget / 4)),
        segments: &segments,
        chat: &chat,
        budget,
        max_tokens: ANSWER_TOKENS,
    };
    service::answer_question(app, &plan, request, &CancellationToken::new()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_markdown_reads_only_markdown_summaries() {
        let parsed = |raw: &str| serde_json::from_str::<serde_json::Value>(raw).ok();
        assert_eq!(summary_markdown(parsed(r##"{"markdown":"# Notes","MeetingName":"x"}"##).as_ref()), "# Notes");
        assert_eq!(summary_markdown(parsed(r##"{"markdown":"<think>plan</think># Notes"}"##).as_ref()), "# Notes");
        assert_eq!(summary_markdown(parsed(r#"{"summary_json":[]}"#).as_ref()), "");
        assert_eq!(summary_markdown(parsed("not json").as_ref()), "");
        assert_eq!(summary_markdown(None), "");
    }

    #[test]
    fn one_answer_per_meeting_at_a_time() {
        let first = InFlight::claim("m-test").expect("first claim");
        assert!(InFlight::claim("m-test").is_none());
        assert!(is_answering("m-test"));
        drop(first);
        assert!(!is_answering("m-test"));
        assert!(InFlight::claim("m-test").is_some());
    }
}

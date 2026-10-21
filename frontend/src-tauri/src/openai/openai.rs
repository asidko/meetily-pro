use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use std::time::{Duration, Instant};
use tauri::command;

/// OpenAI model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenAIModel {
    pub id: String,
}

/// API response model from OpenAI
#[derive(Debug, Deserialize)]
struct OpenAIApiModel {
    id: String,
    #[allow(dead_code)]
    object: String,
    #[allow(dead_code)]
    owned_by: String,
}

/// API response wrapper from OpenAI
#[derive(Debug, Deserialize)]
struct OpenAIApiResponse {
    data: Vec<OpenAIApiModel>,
}

/// Cache entry for models
struct CacheEntry {
    api_key: String,
    ids: Vec<String>,
    fetched_at: Instant,
}

/// Global cache for OpenAI models (5 minute TTL)
static MODELS_CACHE: RwLock<Option<CacheEntry>> = RwLock::new(None);

/// Cache TTL in seconds
const CACHE_TTL_SECS: u64 = 300;

/// Check if model is a chat-capable model (filter out embedding, tts, etc.)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    // Include gpt-*, o1-*, o3-*, o4-* models
    // Exclude embedding, tts, whisper, dall-e, babbage, davinci (non-chat models)
    (id.starts_with("gpt-")
        || id.starts_with("o1-")
        || id.starts_with("o3-")
        || id.starts_with("o4-")
        || id.starts_with("chatgpt-"))
        && !id.contains("embedding")
        && !id.contains("tts")
        && !id.contains("whisper")
        && !id.contains("dall-e")
        && !id.contains("babbage")
        && !id.contains("davinci")
        && !id.contains("instruct")
        && !id.contains("realtime")
        && !id.contains("audio")
        && !id.contains("transcribe")
}

/// Fetch OpenAI models from API
///
/// # Arguments
/// * `api_key` - OpenAI API key
///
/// # Returns
/// Vector of available chat models, or an error when the key is missing or the request fails
#[command]
pub async fn get_openai_models(api_key: Option<String>) -> Result<Vec<OpenAIModel>, String> {
    let api_key = match api_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => return Err("API key is required".to_string()),
    };

    Ok(list_model_ids(&api_key)
        .await?
        .into_iter()
        .filter(|id| is_chat_model(id))
        .map(|id| OpenAIModel { id })
        .collect())
}

pub async fn list_model_ids(api_key: &str) -> Result<Vec<String>, String> {
    {
        let cache = MODELS_CACHE.read().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.as_ref() {
            if entry.api_key == api_key && entry.fetched_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                return Ok(entry.ids.clone());
            }
        }
    }

    // Fetch from API
    log::info!("Fetching OpenAI models from API...");
    let client = reqwest::Client::new();

    let response = match client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .timeout(Duration::from_secs(5))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => return Err(format!("Could not reach OpenAI: {}", e)),
    };

    if !response.status().is_success() {
        return Err(format!("OpenAI rejected the request (HTTP {})", response.status()));
    }

    let api_response: OpenAIApiResponse = match response.json().await {
        Ok(data) => data,
        Err(e) => return Err(format!("Could not read the OpenAI model list: {}", e)),
    };

    let ids: Vec<String> = api_response.data.into_iter().map(|m| m.id).collect();

    log::info!("Fetched {} OpenAI models from API", ids.len());

    // Update cache
    {
        let mut cache = MODELS_CACHE.write().map_err(|e| e.to_string())?;
        *cache = Some(CacheEntry {
            api_key: api_key.to_string(),
            ids: ids.clone(),
            fetched_at: Instant::now(),
        });
    }

    Ok(ids)
}

/// Clear the models cache (useful when API key changes)
pub fn clear_cache() {
    if let Ok(mut cache) = MODELS_CACHE.write() {
        *cache = None;
        log::info!("OpenAI models cache cleared");
    }
}

use serde::{Deserialize, Serialize};
use tauri::command;
use reqwest::Client;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct OpenRouterModel {
    pub id: String,
    pub name: String,
    pub context_length: Option<u32>,
    pub prompt_price: Option<String>,
    pub completion_price: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterApiModel {
    id: String,
    name: Option<String>,
    context_length: Option<u32>,
    #[serde(default)]
    top_provider: Option<TopProvider>,
    #[serde(default)]
    pricing: Option<Pricing>,
}

#[derive(Debug, Deserialize, Default)]
struct TopProvider {
    context_length: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
struct Pricing {
    prompt: Option<String>,
    completion: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterResponse {
    data: Vec<OpenRouterApiModel>,
}

pub async fn check_key(client: &Client, api_key: &str) -> Result<(), String> {
    let key_check = client
        .get("https://openrouter.ai/api/v1/key")
        .bearer_auth(api_key)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {}", e))?;
    if !key_check.status().is_success() {
        return Err(format!("OpenRouter rejected the request (HTTP {})", key_check.status()));
    }
    Ok(())
}

#[command]
pub async fn get_openrouter_models(api_key: Option<String>) -> Result<Vec<OpenRouterModel>, String> {
    let api_key = match api_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => return Err("API key is required".to_string()),
    };
    let client = Client::new();
    check_key(&client, &api_key).await?;

    let response = client
        .get("https://openrouter.ai/api/v1/models")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP request failed with status: {}", response.status()));
    }

    let api_response: OpenRouterResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {}", e))?;

    let models = api_response
        .data
        .into_iter()
        .map(|m| OpenRouterModel {
            id: m.id,
            name: m.name.unwrap_or_else(|| "Unknown".to_string()),
            context_length: m.top_provider
                .as_ref()
                .and_then(|tp| tp.context_length)
                .or(m.context_length),
            prompt_price: m.pricing.as_ref().and_then(|p| p.prompt.clone()),
            completion_price: m.pricing.as_ref().and_then(|p| p.completion.clone()),
        })
        .collect();

    Ok(models)
}

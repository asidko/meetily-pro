use tauri::{AppHandle, Runtime};

use super::meeting_chat::{self, MeetingChat};
use super::prompt::{ChatMessage, Suggestion};
use super::service::{self, LiveAssistantState};
use super::settings::{self, AssistantSettings};
use crate::database::repositories::chat::MeetingChatRepository;
use crate::database::repositories::suggestion::MeetingSuggestionsRepository;
use crate::state::AppState;

#[tauri::command]
pub async fn start_live_assistant<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    service::start(&app)
}

#[tauri::command]
pub async fn refresh_live_assistant<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    service::refresh(&app)
}

#[tauri::command]
pub async fn pause_live_assistant<R: Runtime>(app: AppHandle<R>, paused: bool) -> Result<(), String> {
    service::set_paused(&app, paused)
}

#[tauri::command]
pub async fn update_live_suggestion<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    pinned: Option<bool>,
    dismissed: Option<bool>,
) -> Result<(), String> {
    service::update_suggestion(&app, &id, pinned, dismissed)
}

#[tauri::command]
pub async fn ask_live_assistant<R: Runtime>(app: AppHandle<R>, question: String) -> Result<(), String> {
    service::ask(&app, question).await
}

#[tauri::command]
pub async fn compact_live_assistant<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    service::compact(&app).await
}

#[tauri::command]
pub async fn get_live_assistant_state<R: Runtime>(app: AppHandle<R>) -> Result<LiveAssistantState, String> {
    Ok(service::snapshot(&app))
}

#[tauri::command]
pub async fn api_get_assistant_settings<R: Runtime>(app: AppHandle<R>) -> Result<AssistantSettings, String> {
    Ok(settings::load(&app))
}

#[tauri::command]
pub async fn api_save_assistant_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: AssistantSettings,
) -> Result<(), String> {
    settings::save(&app, &settings)?;
    if !settings.enabled {
        service::stop(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn api_get_meeting_suggestions(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<Suggestion>, String> {
    MeetingSuggestionsRepository::get_for_meeting(state.db_manager.pool(), &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_dismiss_meeting_suggestion(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    id: String,
) -> Result<(), String> {
    MeetingSuggestionsRepository::dismiss(state.db_manager.pool(), &meeting_id, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_get_meeting_chat<R: Runtime>(app: AppHandle<R>, meeting_id: String) -> Result<MeetingChat, String> {
    meeting_chat::load(&app, &meeting_id).await
}

#[tauri::command]
pub async fn api_ask_meeting_assistant<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    question: String,
) -> Result<MeetingChat, String> {
    meeting_chat::ask(&app, &meeting_id, question).await
}

#[tauri::command]
pub async fn api_compact_meeting_chat<R: Runtime>(app: AppHandle<R>, meeting_id: String) -> Result<MeetingChat, String> {
    meeting_chat::compact(&app, &meeting_id).await
}

#[tauri::command]
pub async fn api_dismiss_meeting_chat_error<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    message_id: String,
) -> Result<(), String> {
    meeting_chat::dismiss_error(&app, &meeting_id, &message_id).await
}

async fn store_session(
    state: &AppState,
    meeting_id: &str,
    suggestions: &[Suggestion],
    chat: &[ChatMessage],
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    if !suggestions.is_empty() {
        MeetingSuggestionsRepository::replace_for_meeting(pool, meeting_id, suggestions)
            .await
            .map_err(|e| e.to_string())?;
    }
    if !chat.is_empty() {
        MeetingChatRepository::replace_for_meeting(pool, meeting_id, chat)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn api_import_assistant_snapshot(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    folder: String,
) -> Result<(), String> {
    let (suggestions, chat) = service::read_snapshot(std::path::Path::new(&folder));
    store_session(&state, &meeting_id, &suggestions, &chat).await
}

#[tauri::command]
pub async fn api_save_meeting_assistant<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<(), String> {
    let (suggestions, chat) = service::last_session(&app);
    store_session(&state, &meeting_id, &suggestions, &chat).await?;
    service::on_meeting_saved(&app);
    Ok(())
}

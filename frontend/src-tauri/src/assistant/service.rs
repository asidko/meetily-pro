use chrono::{DateTime, Utc};
use log::{debug, info, warn};
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::prompt::{self, ChatMessage, ChatRole, ModelOutput, PromptContext, Suggestion};
use super::settings;
use crate::audio::recording_commands::{live_transcript_progress, live_transcript_snapshot, LiveTranscriptSnapshot};
use crate::audio::recording_saver::TranscriptSegment;
use crate::audio::transcription::hold_transcription;
use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::summary::language_detection::detect_summary_language;
use crate::summary::llm_client::{complete, CompletionOptions, LLMProvider};
use crate::summary::processor::{clean_llm_markdown_detailed, language_name_from_code, require_visible_markdown, rough_token_count};
use crate::summary::service::{resolve_provider_settings, ProviderSettings, METADATA_CACHE};
use crate::summary::summary_engine::client::is_sidecar_busy;

const LOOP_INTERVAL: Duration = Duration::from_secs(1);
const MIN_NEW_WORDS: usize = 120;
const SLOW_TICK_AFTER: Duration = Duration::from_secs(90);
const SLOW_TICK_MIN_WORDS: usize = 30;
const SPEECH_GAP: Duration = Duration::from_millis(2500);
const MAX_GAP_WAIT: Duration = Duration::from_secs(10);
const FLOOR_CLOUD: Duration = Duration::from_secs(45);
const FLOOR_BUILTIN: Duration = Duration::from_secs(90);
const MANUAL_DEBOUNCE: Duration = Duration::from_secs(5);
const MAX_CONSECUTIVE_FAILURES: u32 = 3;
const OUTPUT_TOKENS: u32 = 1024;
const BUILTIN_INPUT_TOKENS: usize = 2000;
const CLOUD_INPUT_TOKENS: usize = 8000;
const OLLAMA_HEADROOM_TOKENS: usize = 800;
const OLLAMA_FALLBACK_CONTEXT: usize = 4096;
const MAX_ERROR_CHARS: usize = 240;
const MAX_DISMISSED_IN_PROMPT: usize = 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CHAT_OUTPUT_TOKENS: u32 = 500;
const COMPACT_TOKENS: u32 = 1000;
const SNAPSHOT_FILE: &str = "suggestions.json";

static HTTP_CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(reqwest::Client::new);

static PROVIDER_STATUS: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?s)failed with status (\d{3}[^:]*):?(.*)").unwrap());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssistantStatus {
    Idle,
    Waiting,
    Generating,
    Paused,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveAssistantState {
    pub active: bool,
    pub status: AssistantStatus,
    pub provider: String,
    pub model: String,
    pub is_cloud: bool,
    pub last_tick_at: Option<String>,
    pub error: Option<String>,
    pub tick_no: u32,
    pub progress: u8,
    pub state: String,
    pub suggestions: Vec<Suggestion>,
    pub chat: Vec<ChatMessage>,
    pub chat_pending: bool,
    pub chat_context: Option<ChatContext>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChatContext {
    pub used: usize,
    pub limit: usize,
}

pub struct TriggerInput {
    pub manual: bool,
    pub pending: bool,
    pub paused: bool,
    pub new_words: usize,
    pub has_ticked: bool,
    pub since_last_tick: Duration,
    pub since_last_segment: Duration,
    pub waited_since_due: Option<Duration>,
    pub floor: Duration,
}

pub fn content_due(input: &TriggerInput) -> bool {
    input.new_words >= MIN_NEW_WORDS
        || (input.since_last_tick >= SLOW_TICK_AFTER && input.new_words >= SLOW_TICK_MIN_WORDS)
}

pub fn next_tick_progress(input: &TriggerInput) -> u8 {
    let content = if input.pending {
        1.0
    } else {
        let words = input.new_words as f32;
        let by_words = words / MIN_NEW_WORDS as f32;
        let slow = (words / SLOW_TICK_MIN_WORDS as f32)
            .min(input.since_last_tick.as_secs_f32() / SLOW_TICK_AFTER.as_secs_f32());
        by_words.max(slow)
    };
    let floor = if input.has_ticked && !input.floor.is_zero() {
        input.since_last_tick.as_secs_f32() / input.floor.as_secs_f32()
    } else {
        1.0
    };
    (content.min(floor).clamp(0.0, 1.0) * 100.0).floor() as u8
}

pub fn tick_due(input: &TriggerInput) -> bool {
    if input.manual {
        return true;
    }
    if input.paused {
        return false;
    }
    if !(input.pending || content_due(input)) {
        return false;
    }
    if input.has_ticked && input.since_last_tick < input.floor {
        return false;
    }
    input.since_last_segment >= SPEECH_GAP
        || input.waited_since_due.is_some_and(|waited| waited >= MAX_GAP_WAIT)
}

pub fn tick_floor(builtin: bool, last_duration: Duration, failures: u32) -> Duration {
    let base = if builtin { FLOOR_BUILTIN } else { FLOOR_CLOUD };
    let floor = base.max(last_duration * 2);
    floor * 2u32.pow(failures.min(2))
}

struct SessionData {
    state_text: String,
    suggestions: Vec<Suggestion>,
    next_id: u64,
    chat: Vec<ChatMessage>,
    chat_pending: bool,
    chat_inflight: Option<CancellationToken>,
    tick_no: u32,
    progress: u8,
    status: AssistantStatus,
    paused: bool,
    manual_requested: bool,
    pending: bool,
    failures: u32,
    error: Option<String>,
    provider: String,
    model: String,
    is_cloud: bool,
    builtin: bool,
    started_at: Instant,
    last_tick_started: Option<Instant>,
    last_tick_at: Option<DateTime<Utc>>,
    last_duration: Duration,
    last_tick_seq: Option<u64>,
    last_seen_seq: Option<u64>,
    last_seen_change: Instant,
    due_since: Option<Instant>,
    last_manual: Option<Instant>,
    meeting_folder: Option<PathBuf>,
    inflight: Option<CancellationToken>,
    input_budget: usize,
}

impl SessionData {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            state_text: String::new(),
            suggestions: Vec::new(),
            next_id: 0,
            chat: Vec::new(),
            chat_pending: false,
            chat_inflight: None,
            tick_no: 0,
            progress: 0,
            status: AssistantStatus::Waiting,
            paused: false,
            manual_requested: false,
            pending: false,
            failures: 0,
            error: None,
            provider: String::new(),
            model: String::new(),
            is_cloud: false,
            builtin: false,
            started_at: now,
            last_tick_started: None,
            last_tick_at: None,
            last_duration: Duration::ZERO,
            last_tick_seq: None,
            last_seen_seq: None,
            last_seen_change: now,
            due_since: None,
            last_manual: None,
            meeting_folder: None,
            inflight: None,
            input_budget: 0,
        }
    }

    fn push_chat(&mut self, role: ChatRole, text: String, error: bool) {
        let id = format!("c{}", self.chat.len() + 1);
        self.chat.push(ChatMessage { id, role, text, error });
    }

    fn fail_setup(&mut self, error: &str) {
        self.status = AssistantStatus::Error;
        self.paused = true;
        self.error = Some(short_error(error));
        self.pending = false;
    }

    fn settle_status(&mut self) {
        self.status = if self.paused { AssistantStatus::Paused } else { AssistantStatus::Waiting };
    }

    fn snapshot(&self, active: bool) -> LiveAssistantState {
        LiveAssistantState {
            active,
            status: self.status,
            provider: self.provider.clone(),
            model: self.model.clone(),
            is_cloud: self.is_cloud,
            last_tick_at: self.last_tick_at.map(|t| t.to_rfc3339()),
            error: self.error.clone(),
            tick_no: self.tick_no,
            progress: self.progress,
            state: self.state_text.clone(),
            suggestions: self.suggestions.clone(),
            chat: self.chat.clone(),
            chat_pending: self.chat_pending,
            chat_context: (self.input_budget > 0).then(|| chat_context(&self.chat, self.input_budget)),
        }
    }
}

struct Session {
    data: Arc<Mutex<SessionData>>,
    token: CancellationToken,
    notify: Arc<Notify>,
}

#[derive(Default)]
struct AssistantInner {
    session: Option<Session>,
    last_suggestions: Vec<Suggestion>,
    last_chat: Vec<ChatMessage>,
    last_state_text: String,
}

#[derive(Default)]
pub struct AssistantState {
    inner: Mutex<AssistantInner>,
}

fn lock_data(data: &Arc<Mutex<SessionData>>) -> std::sync::MutexGuard<'_, SessionData> {
    data.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_inner(state: &AssistantState) -> std::sync::MutexGuard<'_, AssistantInner> {
    state.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_session<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&Session) -> T,
) -> Option<T> {
    let state = app.try_state::<AssistantState>()?;
    let inner = lock_inner(&state);
    inner.session.as_ref().map(f)
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, data: &SessionData, active: bool) {
    let _ = app.emit("assistant-status", data.snapshot(active));
}

pub fn start<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<AssistantState>()
        .ok_or_else(|| "Live assistant state is not initialised".to_string())?;
    let mut inner = lock_inner(&state);
    if inner.session.is_some() {
        return Ok(());
    }
    let mut resumed = SessionData::new();
    resumed.suggestions = inner.last_suggestions.clone();
    resumed.state_text = inner.last_state_text.clone();
    resumed.chat = inner.last_chat.clone();
    resumed.next_id = resumed
        .suggestions
        .iter()
        .filter_map(|s| s.id.strip_prefix('s')?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let data = Arc::new(Mutex::new(resumed));
    let token = CancellationToken::new();
    let notify = Arc::new(Notify::new());
    let session = Session { data: data.clone(), token: token.clone(), notify: notify.clone() };
    inner.session = Some(session);
    drop(inner);

    emit_status(app, &lock_data(&data), true);
    let app_for_loop = app.clone();
    tauri::async_runtime::spawn(async move {
        run_loop(app_for_loop, data, token, notify).await;
    });
    info!("Live assistant session started");
    Ok(())
}

fn forget_last_session<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<AssistantState>() {
        let mut inner = lock_inner(&state);
        inner.last_suggestions.clear();
        inner.last_chat.clear();
        inner.last_state_text.clear();
    }
}

pub fn on_meeting_saved<R: Runtime>(app: &AppHandle<R>) {
    if with_session(app, |_| ()).is_some() {
        return;
    }
    forget_last_session(app);
    let _ = app.emit("assistant-status", snapshot(app));
}

pub fn on_recording_started<R: Runtime>(app: &AppHandle<R>) {
    forget_last_session(app);
    let settings = settings::load(app);
    if !settings.enabled {
        return;
    }
    if let Err(error) = start(app) {
        warn!("Live assistant autostart failed: {}", error);
    }
}

pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    close_session(app, None);
}

fn close_session<R: Runtime>(app: &AppHandle<R>, only: Option<&Arc<Mutex<SessionData>>>) {
    let Some(state) = app.try_state::<AssistantState>() else {
        return;
    };
    let mut inner = lock_inner(&state);
    if let (Some(session), Some(data)) = (inner.session.as_ref(), only) {
        if !Arc::ptr_eq(&session.data, data) {
            return;
        }
    }
    let Some(session) = inner.session.take() else {
        return;
    };
    session.token.cancel();
    session.notify.notify_one();
    let mut data = lock_data(&session.data);
    data.status = AssistantStatus::Idle;
    data.chat_pending = false;
    inner.last_suggestions = data.suggestions.clone();
    inner.last_chat = data.chat.clone();
    inner.last_state_text = data.state_text.clone();
    emit_status(app, &data, false);
    info!("Live assistant session stopped after {} ticks", data.tick_no);
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    with_session(app, |session| {
        let mut data = lock_data(&session.data);
        let now = Instant::now();
        if data.last_manual.is_some_and(|last| now.duration_since(last) < MANUAL_DEBOUNCE) {
            return;
        }
        data.last_manual = Some(now);
        data.manual_requested = true;
        session.notify.notify_one();
    })
    .ok_or_else(|| "Live assistant is not running".to_string())
}

pub fn set_paused<R: Runtime>(app: &AppHandle<R>, paused: bool) -> Result<(), String> {
    with_session(app, |session| {
        let mut data = lock_data(&session.data);
        data.paused = paused;
        if paused {
            data.status = AssistantStatus::Paused;
            if let Some(inflight) = data.inflight.take() {
                inflight.cancel();
            }
            if let Some(chat) = data.chat_inflight.take() {
                chat.cancel();
            }
        } else {
            data.failures = 0;
            data.error = None;
            data.status = AssistantStatus::Waiting;
        }
        emit_status(app, &data, true);
    })
    .ok_or_else(|| "Live assistant is not running".to_string())
}

pub fn update_suggestion<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    pinned: Option<bool>,
    dismissed: Option<bool>,
) -> Result<(), String> {
    with_session(app, |session| {
        let mut data = lock_data(&session.data);
        let item = data
            .suggestions
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| format!("Unknown suggestion {}", id))?;
        if let Some(pinned) = pinned {
            item.pinned = pinned;
            if pinned {
                item.dismissed = false;
            }
        }
        if let Some(dismissed) = dismissed {
            item.dismissed = dismissed;
            if dismissed {
                item.pinned = false;
            }
        }
        emit_status(app, &data, true);
        if let Some(folder) = data.meeting_folder.clone() {
            persist_snapshot(&folder, &data);
        }
        Ok(())
    })
    .unwrap_or_else(|| Err("Live assistant is not running".to_string()))
}

pub fn last_session<R: Runtime>(app: &AppHandle<R>) -> (Vec<Suggestion>, Vec<ChatMessage>) {
    app.try_state::<AssistantState>()
        .map(|state| {
            let inner = lock_inner(&state);
            (inner.last_suggestions.clone(), inner.last_chat.clone())
        })
        .unwrap_or_default()
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> LiveAssistantState {
    if let Some(state) = with_session(app, |session| lock_data(&session.data).snapshot(true)) {
        return state;
    }
    let (suggestions, chat) = last_session(app);
    LiveAssistantState {
        active: false,
        status: AssistantStatus::Idle,
        provider: String::new(),
        model: String::new(),
        is_cloud: false,
        last_tick_at: None,
        error: None,
        tick_no: 0,
        progress: 0,
        state: String::new(),
        suggestions,
        chat,
        chat_pending: false,
        chat_context: None,
    }
}

pub(super) fn db_pool<R: Runtime>(app: &AppHandle<R>) -> Result<SqlitePool, String> {
    app.try_state::<AppState>()
        .map(|state| state.db_manager.pool().clone())
        .ok_or_else(|| "Database is not ready yet".to_string())
}

async fn resolve_target(pool: &SqlitePool) -> Result<(String, String), String> {
    match SettingsRepository::get_model_config(pool).await {
        Ok(Some(config)) if !config.model.trim().is_empty() => Ok((config.provider, config.model)),
        Ok(_) => Err("Pick an AI model in Settings, Models".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn is_local_endpoint(endpoint: &str) -> bool {
    let Ok(parsed) = url::Url::parse(endpoint.trim()) else {
        return false;
    };
    match parsed.host_str() {
        Some(host) => {
            let host = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
            host == "localhost"
                || host == "127.0.0.1"
                || host == "::1"
                || host == "0.0.0.0"
                || host.ends_with(".localhost")
        }
        None => false,
    }
}

pub fn is_cloud(provider: &LLMProvider, ollama_endpoint: Option<&str>) -> bool {
    match provider {
        LLMProvider::BuiltInAI => false,
        LLMProvider::Ollama => !is_local_endpoint(ollama_endpoint.unwrap_or("http://localhost:11434")),
        _ => true,
    }
}

pub(super) async fn input_budget(settings: &ProviderSettings, model: &str) -> usize {
    match settings.provider {
        LLMProvider::BuiltInAI => BUILTIN_INPUT_TOKENS,
        LLMProvider::Ollama => {
            let context = METADATA_CACHE
                .get_or_fetch(model, settings.ollama_endpoint.as_deref())
                .await
                .map(|metadata| metadata.context_size)
                .unwrap_or(OLLAMA_FALLBACK_CONTEXT);
            context
                .saturating_sub(OLLAMA_HEADROOM_TOKENS)
                .clamp(512, CLOUD_INPUT_TOKENS)
        }
        _ => CLOUD_INPUT_TOKENS,
    }
}

fn language_name(window: &[TranscriptSegment]) -> String {
    let texts: Vec<String> = window.iter().map(|s| s.text.clone()).collect();
    detect_summary_language(&texts)
        .language
        .as_deref()
        .and_then(language_name_from_code)
        .map(str::to_string)
        .unwrap_or_else(|| "the transcript's language".to_string())
}

pub(super) fn short_error(error: &str) -> String {
    let message = match PROVIDER_STATUS.captures(error) {
        Some(captures) => match provider_message(&captures[2]) {
            Some(reason) => format!("Provider returned {}: {}", captures[1].trim(), reason),
            None => format!("Provider returned {}", captures[1].trim()),
        },
        None => error.to_string(),
    };
    let single_line: String = message.split_whitespace().collect::<Vec<_>>().join(" ");
    single_line.chars().take(MAX_ERROR_CHARS).collect()
}

pub(crate) fn provider_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    value["error"]["message"].as_str().map(str::to_string)
}

fn persist_snapshot(folder: &Path, data: &SessionData) {
    let payload = serde_json::json!({
        "state": data.state_text,
        "suggestions": data.suggestions,
        "chat": data.chat,
        "updated_at": Utc::now().to_rfc3339(),
    });
    let Ok(serialized) = serde_json::to_string_pretty(&payload) else {
        return;
    };
    let final_path = folder.join(SNAPSHOT_FILE);
    let temp_path = folder.join(format!(".{}.tmp", SNAPSHOT_FILE));
    if std::fs::write(&temp_path, serialized).is_ok() {
        if let Err(error) = std::fs::rename(&temp_path, &final_path) {
            warn!("Failed to persist live assistant snapshot: {}", error);
        }
    }
}

pub fn read_snapshot(folder: &Path) -> (Vec<Suggestion>, Vec<ChatMessage>) {
    let value: Option<serde_json::Value> = std::fs::read_to_string(folder.join(SNAPSHOT_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    let field = |key: &str| value.as_ref().and_then(|v| v.get(key)).cloned();
    (
        field("suggestions").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
        field("chat").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default(),
    )
}

pub(super) struct RequestPlan {
    pub(super) provider_settings: ProviderSettings,
    cloud: bool,
    provider_label: String,
    pub(super) model: String,
}

pub(super) async fn resolve_request<R: Runtime>(app: &AppHandle<R>) -> Result<RequestPlan, String> {
    let pool = db_pool(app)?;
    let (provider_label, model) = resolve_target(&pool).await?;
    let provider_settings = resolve_provider_settings(&pool, &provider_label).await?;
    let cloud = is_cloud(&provider_settings.provider, provider_settings.ollama_endpoint.as_deref());
    Ok(RequestPlan { provider_settings, cloud, provider_label, model })
}

async fn resolve_plan<R: Runtime>(app: &AppHandle<R>, data: &Arc<Mutex<SessionData>>) -> Result<RequestPlan, String> {
    let plan = resolve_request(app).await?;
    let budget = input_budget(&plan.provider_settings, &plan.model).await;
    let mut guard = lock_data(data);
    guard.input_budget = budget;
    guard.provider = plan.provider_label.clone();
    guard.model = plan.model.clone();
    guard.is_cloud = plan.cloud;
    guard.builtin = plan.provider_settings.provider == LLMProvider::BuiltInAI;
    Ok(plan)
}

async fn call_model<R: Runtime>(
    app: &AppHandle<R>,
    plan: &RequestPlan,
    system_prompt: &str,
    user_prompt: &str,
    token: &CancellationToken,
    options: CompletionOptions,
) -> Result<String, String> {
    let settings = &plan.provider_settings;
    let app_data_dir = app.path().app_data_dir().ok();
    let _transcription_hold = (!plan.cloud).then(hold_transcription);
    let mut request = std::pin::pin!(complete(
        &HTTP_CLIENT,
        &settings.provider,
        &plan.model,
        &settings.api_key,
        system_prompt,
        user_prompt,
        settings.ollama_endpoint.as_deref(),
        settings.custom_openai_endpoint.as_deref(),
        settings.custom_max_tokens,
        settings.custom_temperature,
        settings.custom_top_p,
        app_data_dir.as_ref(),
        Some(token),
        options,
    ));
    tokio::select! {
        result = &mut request => result.map(|completion| completion.content),
        _ = tokio::time::sleep(REQUEST_TIMEOUT) => {
            token.cancel();
            let _ = request.await;
            Err("Model did not answer within two minutes".to_string())
        }
    }
}

async fn run_tick<R: Runtime>(
    app: &AppHandle<R>,
    data: &Arc<Mutex<SessionData>>,
    plan: &RequestPlan,
    snapshot: &LiveTranscriptSnapshot,
    token: &CancellationToken,
    on_demand: bool,
) -> Result<(ModelOutput, Option<u64>), String> {
    let segments = &snapshot.segments;
    if segments.is_empty() {
        return Err("No transcript yet".to_string());
    }
    let budget = lock_data(data).input_budget;
    let language = language_name(prompt::select_window(segments, budget));
    let prefix = {
        let guard = lock_data(data);
        let dismissed: Vec<String> = guard
            .suggestions
            .iter()
            .filter(|s| s.dismissed)
            .rev()
            .take(MAX_DISMISSED_IN_PROMPT)
            .map(|s| s.text.clone())
            .collect();
        prompt::build_prefix(&PromptContext {
            title: snapshot.meeting_name.as_deref().unwrap_or(""),
            language_name: &language,
            state: &guard.state_text,
            open: &guard.suggestions,
            dismissed_texts: &dismissed,
            user_messages: &user_messages(&guard.chat, budget / 6),
        })
    };
    let window_budget = budget.saturating_sub(rough_token_count(&prefix)).max(200);
    let window = prompt::select_window(segments, window_budget);
    let user_prompt = prompt::build_user_prompt(prefix, window, on_demand);
    let through_seq = window.last().map(|s| s.sequence_id);
    let options = CompletionOptions { json_mode: true, max_tokens: Some(OUTPUT_TOKENS), json_schema: Some(prompt::SUGGESTIONS_SCHEMA) };
    let content = call_model(app, plan, prompt::SYSTEM_PROMPT, &user_prompt, token, options).await?;
    let output = prompt::parse_model_output(&content).inspect_err(|_| {
        warn!("Unreadable assistant output ({} chars)", content.len());
        debug!("Unreadable assistant output: {}", content.chars().take(300).collect::<String>());
    })?;
    Ok((output, through_seq))
}

pub(super) fn checked_question(question: String) -> Result<String, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("Type a question first".to_string());
    }
    Ok(question)
}

pub async fn ask<R: Runtime>(app: &AppHandle<R>, question: String) -> Result<(), String> {
    let question = checked_question(question)?;
    chat_turn(app, Some(question), ChatRole::Assistant, |data, token| async move {
        answer_chat(app, &data, &token).await
    })
    .await
}

pub async fn compact<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    chat_turn(app, None, ChatRole::Summary, |data, token| async move {
        let plan = resolve_plan(app, &data).await?;
        let (chat, budget) = {
            let guard = lock_data(&data);
            (guard.chat.clone(), guard.input_budget)
        };
        compact_chat(app, &plan, &chat, budget, &token).await
    })
    .await
}

async fn chat_turn<R, F, Fut>(app: &AppHandle<R>, question: Option<String>, role: ChatRole, work: F) -> Result<(), String>
where
    R: Runtime,
    F: FnOnce(Arc<Mutex<SessionData>>, CancellationToken) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let (data, token) = with_session(app, |session| (session.data.clone(), session.token.clone()))
        .ok_or_else(|| "Chat works while a recording is running".to_string())?;
    let chat_token = token.child_token();
    {
        let mut guard = lock_data(&data);
        if guard.chat_pending {
            return Err("Wait for the current answer".to_string());
        }
        guard.chat_pending = true;
        guard.chat_inflight = Some(chat_token.clone());
        if let Some(question) = question {
            guard.push_chat(ChatRole::User, question, false);
        }
        emit_status(app, &guard, true);
    }
    let answer = work(data.clone(), chat_token).await;
    if token.is_cancelled() {
        return Ok(());
    }
    let mut guard = lock_data(&data);
    guard.chat_pending = false;
    let paused_mid_answer = guard.chat_inflight.take().is_none();
    let outcome = match answer {
        Ok(text) => {
            guard.push_chat(role, text, false);
            Ok(())
        }
        Err(error) if role == ChatRole::Summary => Err(short_error(&error)),
        Err(_) if paused_mid_answer => {
            guard.push_chat(ChatRole::Assistant, "Stopped because the assistant was paused".to_string(), true);
            Ok(())
        }
        Err(error) => {
            let error = short_error(&error);
            warn!("Live assistant chat failed: {}", error);
            guard.push_chat(ChatRole::Assistant, error, true);
            Ok(())
        }
    };
    emit_status(app, &guard, true);
    if let Some(folder) = guard.meeting_folder.clone() {
        persist_snapshot(&folder, &guard);
    }
    outcome
}

async fn answer_chat<R: Runtime>(
    app: &AppHandle<R>,
    data: &Arc<Mutex<SessionData>>,
    chat_token: &CancellationToken,
) -> Result<String, String> {
    let plan = resolve_plan(app, data).await?;
    let snapshot = live_transcript_snapshot().ok_or_else(|| "No active recording".to_string())?;
    let (prefix, chat, budget) = {
        let guard = lock_data(data);
        let prefix = prompt::build_prefix(&PromptContext {
            title: snapshot.meeting_name.as_deref().unwrap_or(""),
            language_name: prompt::CHAT_LANGUAGE,
            state: &guard.state_text,
            open: &guard.suggestions,
            dismissed_texts: &[],
            user_messages: &[],
        });
        (prefix, guard.chat.clone(), guard.input_budget)
    };
    let request = ChatRequest {
        system_prompt: prompt::CHAT_SYSTEM_PROMPT,
        prefix,
        segments: &snapshot.segments,
        chat: &chat,
        budget,
        max_tokens: CHAT_OUTPUT_TOKENS,
    };
    answer_question(app, &plan, request, chat_token).await
}

pub(super) struct ChatRequest<'a> {
    pub(super) system_prompt: &'static str,
    pub(super) prefix: String,
    pub(super) segments: &'a [TranscriptSegment],
    pub(super) chat: &'a [ChatMessage],
    pub(super) budget: usize,
    pub(super) max_tokens: u32,
}

pub(super) async fn answer_question<R: Runtime>(
    app: &AppHandle<R>,
    plan: &RequestPlan,
    request: ChatRequest<'_>,
    token: &CancellationToken,
) -> Result<String, String> {
    let history = recent_chat(request.chat, chat_budget(request.budget));
    let history_tokens: usize = history.iter().map(|m| rough_token_count(&m.text)).sum();
    let window_budget = request
        .budget
        .saturating_sub(rough_token_count(&request.prefix) + history_tokens)
        .max(200);
    let window = prompt::select_window(request.segments, window_budget);
    let user_prompt = prompt::build_chat_prompt(request.prefix, window, &history);
    info!("Assistant chat via {}/{}", plan.provider_label, plan.model);
    let options = CompletionOptions { json_mode: false, max_tokens: Some(request.max_tokens), json_schema: None };
    let content = call_model(app, plan, request.system_prompt, &user_prompt, token, options).await?;
    visible_chat_answer(&content, request.segments)
}

fn visible_chat_answer(content: &str, segments: &[TranscriptSegment]) -> Result<String, String> {
    let cleaned = clean_llm_markdown_detailed(content);
    require_visible_markdown("Chat answer", &cleaned)?;
    Ok(prompt::unlink_unknown_citations(&cleaned.markdown, segments))
}

fn chat_memory(chat: &[ChatMessage]) -> impl Iterator<Item = &ChatMessage> {
    let start = chat
        .iter()
        .rposition(|m| m.role == ChatRole::Summary && !m.error)
        .unwrap_or(0);
    chat[start..].iter().filter(|m| !m.error && !matches!(m.role, ChatRole::Recap | ChatRole::KeyTerms))
}

fn chat_budget(input_budget: usize) -> usize {
    input_budget / 3
}

pub(super) fn chat_context(chat: &[ChatMessage], input_budget: usize) -> ChatContext {
    ChatContext {
        used: chat_memory(chat).map(|m| rough_token_count(&m.text)).sum(),
        limit: chat_budget(input_budget),
    }
}

fn recent_chat(chat: &[ChatMessage], budget_tokens: usize) -> Vec<ChatMessage> {
    let memory: Vec<&ChatMessage> = chat_memory(chat).collect();
    prompt::newest_within_budget(&memory, budget_tokens, |m| rough_token_count(&m.text))
        .iter()
        .map(|m| (*m).clone())
        .collect()
}

fn user_messages(chat: &[ChatMessage], budget_tokens: usize) -> Vec<ChatMessage> {
    let own: Vec<&ChatMessage> = chat_memory(chat).filter(|m| matches!(m.role, ChatRole::User | ChatRole::Summary)).collect();
    prompt::newest_within_budget(&own, budget_tokens, |m| rough_token_count(&m.text).min(budget_tokens))
        .iter()
        .map(|m| ChatMessage { text: truncate_to_tokens(&m.text, budget_tokens), ..(*m).clone() })
        .collect()
}

pub(super) fn truncate_to_tokens(text: &str, tokens: usize) -> String {
    if rough_token_count(text) <= tokens {
        return text.to_string();
    }
    let chars = text.chars().count() * tokens / rough_token_count(text).max(1);
    text.chars().take(chars).collect()
}

fn compaction_input(memory: &[ChatMessage], input_budget: usize) -> Vec<ChatMessage> {
    let cost = |m: &ChatMessage| rough_token_count(&m.text);
    let (summary, rest) = match memory.split_first() {
        Some((first, rest)) if first.role == ChatRole::Summary => (Some(first), rest),
        _ => (None, memory),
    };
    let rest_budget = input_budget.saturating_sub(summary.map_or(0, cost));
    summary
        .into_iter()
        .chain(prompt::newest_within_budget(rest, rest_budget, cost))
        .cloned()
        .collect()
}

pub(super) async fn compact_chat<R: Runtime>(
    app: &AppHandle<R>,
    plan: &RequestPlan,
    chat: &[ChatMessage],
    input_budget: usize,
    token: &CancellationToken,
) -> Result<String, String> {
    let memory: Vec<ChatMessage> = chat_memory(chat).cloned().collect();
    if memory.len() < 2 {
        return Err("Nothing to compact yet".to_string());
    }
    let kept = compaction_input(&memory, input_budget);
    let words = (chat_budget(input_budget) / 4).clamp(60, 300);
    let user_prompt = format!("Chat:\n{}\nWrite the summary in under {} words.", prompt::format_chat(&kept), words);
    info!("Compacting assistant chat via {}/{}", plan.provider_label, plan.model);
    let options = CompletionOptions { json_mode: false, max_tokens: Some(COMPACT_TOKENS), json_schema: None };
    let content = call_model(app, plan, prompt::COMPACT_SYSTEM_PROMPT, &user_prompt, token, options).await?;
    let cleaned = clean_llm_markdown_detailed(&content);
    require_visible_markdown("Chat summary", &cleaned)?;
    Ok(cleaned.markdown)
}

fn defer_for_busy_sidecar<R: Runtime>(app: &AppHandle<R>, data: &Arc<Mutex<SessionData>>, manual: bool) {
    let mut guard = lock_data(data);
    if manual {
        guard.manual_requested = true;
    }
    if guard.pending && guard.status == AssistantStatus::Waiting {
        return;
    }
    guard.pending = true;
    guard.status = AssistantStatus::Waiting;
    emit_status(app, &guard, true);
}

async fn run_loop<R: Runtime>(
    app: AppHandle<R>,
    data: Arc<Mutex<SessionData>>,
    token: CancellationToken,
    notify: Arc<Notify>,
) {
    let initial = resolve_plan(&app, &data).await;
    if !token.is_cancelled() {
        let mut guard = lock_data(&data);
        if let Err(error) = initial {
            guard.fail_setup(&error);
        }
        emit_status(&app, &guard, true);
    }
    loop {
        tokio::select! {
            _ = token.cancelled() => break,
            _ = tokio::time::sleep(LOOP_INTERVAL) => {},
            _ = notify.notified() => {},
        }
        if token.is_cancelled() {
            break;
        }
        let last_tick_seq = lock_data(&data).last_tick_seq;
        let Some(progress) = live_transcript_progress(last_tick_seq) else {
            info!("Live assistant loop ending: no active recording");
            break;
        };

        let (due, manual) = {
            let mut guard = lock_data(&data);
            let now = Instant::now();
            guard.meeting_folder = progress.meeting_folder;
            if progress.newest_seq != guard.last_seen_seq {
                guard.last_seen_seq = progress.newest_seq;
                guard.last_seen_change = now;
            }
            let since_last_tick = guard
                .last_tick_started
                .map(|started| now.duration_since(started))
                .unwrap_or_else(|| now.duration_since(guard.started_at));
            let floor = tick_floor(guard.builtin, guard.last_duration, guard.failures);
            let manual = guard.manual_requested;
            let input = TriggerInput {
                manual,
                pending: guard.pending,
                paused: guard.paused || progress.is_paused,
                new_words: progress.new_words,
                has_ticked: guard.last_tick_started.is_some(),
                since_last_tick,
                since_last_segment: now.duration_since(guard.last_seen_change),
                waited_since_due: guard.due_since.map(|since| now.duration_since(since)),
                floor,
            };
            if content_due(&input) || input.pending {
                if guard.due_since.is_none() {
                    guard.due_since = Some(now);
                }
            } else {
                guard.due_since = None;
            }
            let progress = if input.paused { guard.progress } else { next_tick_progress(&input) };
            if progress != guard.progress {
                guard.progress = progress;
                let _ = app.emit("assistant-progress", serde_json::json!({ "progress": progress }));
            }
            let due = tick_due(&input);
            if due {
                guard.manual_requested = false;
                guard.due_since = None;
            }
            (due, manual)
        };
        if !due {
            continue;
        }

        let planned = resolve_plan(&app, &data).await;
        if token.is_cancelled() {
            break;
        }
        let plan = match planned {
            Ok(plan) => plan,
            Err(error) => {
                let mut guard = lock_data(&data);
                guard.fail_setup(&error);
                emit_status(&app, &guard, true);
                let _ = app.emit("assistant-error", serde_json::json!({ "message": guard.error }));
                continue;
            }
        };

        if plan.provider_settings.provider == LLMProvider::BuiltInAI && is_sidecar_busy().await {
            if token.is_cancelled() {
                break;
            }
            defer_for_busy_sidecar(&app, &data, manual);
            continue;
        }

        let Some(snapshot) = live_transcript_snapshot() else {
            info!("Live assistant loop ending: no active recording");
            break;
        };

        let started = Instant::now();
        let tick_token = token.child_token();
        {
            let mut guard = lock_data(&data);
            if guard.paused && !manual {
                continue;
            }
            guard.pending = false;
            guard.status = AssistantStatus::Generating;
            guard.last_tick_started = Some(started);
            guard.inflight = Some(tick_token.clone());
            emit_status(&app, &guard, true);
        }
        info!(
            "Live assistant tick via {}/{} ({} segments, manual={})",
            plan.provider_label,
            plan.model,
            snapshot.segments.len(),
            manual
        );

        let result = run_tick(&app, &data, &plan, &snapshot, &tick_token, manual).await;
        if token.is_cancelled() {
            break;
        }
        let mut guard = lock_data(&data);
        let paused_mid_run = guard.inflight.take().is_none();
        guard.last_duration = started.elapsed();
        if paused_mid_run {
            guard.settle_status();
            emit_status(&app, &guard, true);
            continue;
        }
        match result {
            Ok((output, through_seq)) => {
                let mut outcome = prompt::reconcile(guard.suggestions.clone(), output, &snapshot.segments, guard.next_id);
                let chat_len = guard.chat.len();
                for item in outcome.open.iter_mut().filter(|item| item.after_chat.is_none()) {
                    item.after_chat = Some(chat_len);
                }
                guard.tick_no += 1;
                guard.progress = 0;
                guard.suggestions = outcome.open;
                if !outcome.state.trim().is_empty() {
                    guard.state_text = outcome.state;
                }
                guard.next_id = outcome.next_id;
                guard.last_tick_seq = through_seq;
                guard.last_tick_at = Some(Utc::now());
                guard.failures = 0;
                guard.error = None;
                guard.settle_status();
                info!(
                    "Live assistant tick {} done in {:?}: {} added, {} uncited dropped, {} open",
                    guard.tick_no,
                    guard.last_duration,
                    outcome.added,
                    outcome.dropped_uncited,
                    guard.suggestions.iter().filter(|s| !s.dismissed).count()
                );
                emit_status(&app, &guard, true);
                if let Some(folder) = guard.meeting_folder.clone() {
                    persist_snapshot(&folder, &guard);
                }
            }
            Err(error) => {
                guard.failures += 1;
                guard.error = Some(short_error(&error));
                warn!(
                    "Live assistant tick failed ({} consecutive): {}",
                    guard.failures,
                    guard.error.as_deref().unwrap_or("")
                );
                if guard.failures >= MAX_CONSECUTIVE_FAILURES {
                    guard.paused = true;
                    guard.status = AssistantStatus::Error;
                    let _ = app.emit("assistant-error", serde_json::json!({ "message": guard.error }));
                } else {
                    guard.settle_status();
                }
                emit_status(&app, &guard, true);
            }
        }
    }
    close_session(&app, Some(&data));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> TriggerInput {
        TriggerInput {
            manual: false,
            pending: false,
            paused: false,
            new_words: 0,
            has_ticked: true,
            since_last_tick: Duration::from_secs(60),
            since_last_segment: Duration::from_secs(3),
            waited_since_due: None,
            floor: FLOOR_CLOUD,
        }
    }

    #[test]
    fn manual_refresh_always_fires() {
        let mut i = input();
        i.manual = true;
        i.paused = true;
        assert!(tick_due(&i));
    }

    #[test]
    fn paused_never_fires_without_manual() {
        let mut i = input();
        i.paused = true;
        i.new_words = 500;
        assert!(!tick_due(&i));
    }

    #[test]
    fn needs_enough_new_words_or_slow_tick() {
        let mut i = input();
        i.new_words = 50;
        assert!(!tick_due(&i));
        i.new_words = 120;
        assert!(tick_due(&i));
        i.new_words = 30;
        i.since_last_tick = Duration::from_secs(95);
        assert!(tick_due(&i));
    }

    #[test]
    fn respects_floor_only_after_first_tick() {
        let mut i = input();
        i.new_words = 200;
        i.since_last_tick = Duration::from_secs(10);
        assert!(!tick_due(&i));
        i.has_ticked = false;
        assert!(tick_due(&i));
    }

    #[test]
    fn waits_for_speech_gap_up_to_ten_seconds() {
        let mut i = input();
        i.new_words = 200;
        i.since_last_segment = Duration::from_millis(500);
        assert!(!tick_due(&i));
        i.waited_since_due = Some(Duration::from_secs(11));
        assert!(tick_due(&i));
    }

    #[test]
    fn pending_tick_fires_once_floor_passes() {
        let mut i = input();
        i.pending = true;
        i.since_last_tick = Duration::from_secs(10);
        assert!(!tick_due(&i));
        i.since_last_tick = Duration::from_secs(50);
        assert!(tick_due(&i));
    }

    #[test]
    fn progress_tracks_words_then_floor_and_matches_due() {
        let mut i = input();
        i.has_ticked = false;
        i.since_last_tick = Duration::ZERO;
        i.new_words = 60;
        assert_eq!(next_tick_progress(&i), 50);
        i.new_words = 119;
        assert_eq!(next_tick_progress(&i), 99);
        assert!(!content_due(&i));
        i.new_words = 120;
        assert_eq!(next_tick_progress(&i), 100);
        assert!(tick_due(&i));
        i.has_ticked = true;
        i.since_last_tick = Duration::from_secs(9);
        assert_eq!(next_tick_progress(&i), 20);
        assert!(!tick_due(&i));
    }

    #[test]
    fn progress_follows_slow_tick_path() {
        let mut i = input();
        i.new_words = 30;
        i.since_last_tick = Duration::from_secs(45);
        assert_eq!(next_tick_progress(&i), 50);
        i.since_last_tick = Duration::from_secs(90);
        assert_eq!(next_tick_progress(&i), 100);
        assert!(tick_due(&i));
        i.pending = true;
        i.new_words = 0;
        assert_eq!(next_tick_progress(&i), 100);
    }

    #[test]
    fn chat_history_keeps_newest_turns_within_budget() {
        let message = |id: &str, words: usize| ChatMessage {
            id: id.to_string(),
            role: ChatRole::User,
            text: "word ".repeat(words),
            error: false,
        };
        let chat = vec![message("c1", 400), message("c2", 10), message("c3", 10)];
        let ids = |history: Vec<ChatMessage>| history.into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids(recent_chat(&chat, 100)), vec!["c2", "c3"]);
        let mut failed = message("c4", 1);
        failed.error = true;
        let with_failure = vec![message("c1", 1), failed, message("c5", 1)];
        assert_eq!(ids(recent_chat(&with_failure, 10_000)), vec!["c1", "c5"]);
        assert_eq!(ids(recent_chat(&chat, 10_000)), vec!["c1", "c2", "c3"]);
        assert_eq!(ids(recent_chat(&chat[..1], 5)), vec!["c1"]);
        let long: Vec<ChatMessage> = (0..20).map(|i| message(&format!("c{}", i), 1)).collect();
        assert_eq!(recent_chat(&long, 10_000).len(), 20);
    }

    #[test]
    fn compacted_chat_starts_from_its_summary() {
        let message = |id: &str, role: ChatRole, text: &str| ChatMessage { id: id.to_string(), role, text: text.to_string(), error: false };
        let chat = vec![
            message("c1", ChatRole::User, &"old ".repeat(300)),
            message("c2", ChatRole::Assistant, &"answer ".repeat(300)),
            message("c3", ChatRole::Summary, "Asked who owns the rollout"),
            message("c4", ChatRole::User, "And the budget?"),
            message("c5", ChatRole::Assistant, "Not discussed yet"),
        ];
        let ids: Vec<String> = recent_chat(&chat, 10_000).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["c3", "c4", "c5"]);
        let context = chat_context(&chat, 3000);
        assert_eq!(context.limit, 1000);
        assert_eq!(context.used, ["Asked who owns the rollout", "And the budget?", "Not discussed yet"].iter().map(|t| rough_token_count(t)).sum::<usize>());
        let own: Vec<String> = user_messages(&chat, 10_000).into_iter().map(|m| m.id).collect();
        assert_eq!(own, vec!["c3", "c4"]);
    }

    #[test]
    fn compaction_keeps_the_earlier_summary_when_the_chat_overflows() {
        let message = |id: &str, role: ChatRole, words: usize| ChatMessage { id: id.to_string(), role, text: "word ".repeat(words), error: false };
        let memory = vec![
            message("c1", ChatRole::Summary, 10),
            message("c2", ChatRole::User, 400),
            message("c3", ChatRole::User, 10),
            message("c4", ChatRole::Assistant, 10),
        ];
        let ids: Vec<String> = compaction_input(&memory, 100).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["c1", "c3", "c4"]);
        let ids: Vec<String> = compaction_input(&memory[1..], 100).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["c3", "c4"]);
    }

    #[test]
    fn a_long_pasted_message_is_cut_for_suggestions_only() {
        let pasted = "word ".repeat(5000);
        assert_eq!(checked_question(pasted.clone()).unwrap(), pasted.trim());
        let chat = vec![ChatMessage { id: "c1".to_string(), role: ChatRole::User, text: pasted, error: false }];
        let own = user_messages(&chat, 100);
        assert_eq!(own.len(), 1);
        assert!(rough_token_count(&own[0].text) <= 110);
        assert_eq!(recent_chat(&chat, 100)[0].text, chat[0].text);
    }

    #[test]
    fn the_meeting_recap_stays_out_of_chat_memory() {
        let message = |id: &str, role: ChatRole, text: &str| ChatMessage { id: id.to_string(), role, text: text.to_string(), error: false };
        let chat = vec![
            message("c1", ChatRole::KeyTerms, "Rollout with Anya, etcd and S3"),
            message("c2", ChatRole::Recap, "The meeting covered the rollout"),
            message("c3", ChatRole::User, "Who owns it?"),
        ];
        let ids: Vec<String> = recent_chat(&chat, 10_000).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["c3"]);
        assert_eq!(chat_context(&chat, 3000).used, rough_token_count("Who owns it?"));
    }

    #[test]
    fn truncation_keeps_short_text_and_cuts_long_text() {
        assert_eq!(truncate_to_tokens("short", 100), "short");
        let long = "word ".repeat(2000);
        let cut = truncate_to_tokens(&long, 100);
        assert!(rough_token_count(&cut) <= 110);
        assert!(long.starts_with(&cut));
    }

    #[test]
    fn chat_answer_drops_model_reasoning() {
        assert_eq!(
            visible_chat_answer("<think>secret reasoning</think>Nobody owns it yet.", &[]).unwrap(),
            "Nobody owns it yet."
        );
        assert!(visible_chat_answer("<think>only reasoning</think>", &[]).is_err());
        assert!(visible_chat_answer("<think>cut off mid thought", &[]).is_err());
    }

    #[test]
    fn floor_scales_with_duration_and_failures() {
        assert_eq!(tick_floor(false, Duration::ZERO, 0), Duration::from_secs(45));
        assert_eq!(tick_floor(true, Duration::ZERO, 0), Duration::from_secs(90));
        assert_eq!(tick_floor(false, Duration::from_secs(40), 0), Duration::from_secs(80));
        assert_eq!(tick_floor(false, Duration::ZERO, 1), Duration::from_secs(90));
        assert_eq!(tick_floor(false, Duration::ZERO, 5), Duration::from_secs(180));
    }

    #[test]
    fn local_endpoint_detection() {
        assert!(is_local_endpoint("http://localhost:11434"));
        assert!(is_local_endpoint("http://127.0.0.1:11434/"));
        assert!(is_local_endpoint("http://[::1]:11434"));
        assert!(!is_local_endpoint("https://ollama.example.com"));
        assert!(!is_local_endpoint("not a url"));
        assert!(is_cloud(&LLMProvider::Ollama, Some("http://10.0.0.5:11434")));
        assert!(!is_cloud(&LLMProvider::Ollama, None));
        assert!(!is_cloud(&LLMProvider::BuiltInAI, None));
        assert!(is_cloud(&LLMProvider::OpenAI, None));
    }

    #[test]
    fn short_error_hides_provider_response_bodies() {
        let error = "LLM API request failed with status 401 Unauthorized: {\"error\":\"echo of the transcript text\"}";
        assert_eq!(short_error(error), "Provider returned 401 Unauthorized");
        assert_eq!(short_error("LLM API request failed with status 500 Internal Server Error: echo"), "Provider returned 500 Internal Server Error");
    }

    #[test]
    fn short_error_keeps_the_providers_own_reason() {
        let error = "LLM API request failed with status 404 Not Found: {\"error\":{\"message\":\"Model blocked\\nby guardrail\",\"code\":404}}";
        assert_eq!(short_error(error), "Provider returned 404 Not Found: Model blocked by guardrail");
    }

    #[test]
    fn short_error_strips_newlines_and_truncates() {
        let long = "a\nb ".repeat(200);
        let short = short_error(&long);
        assert!(!short.contains('\n'));
        assert!(short.chars().count() <= MAX_ERROR_CHARS);
    }
}

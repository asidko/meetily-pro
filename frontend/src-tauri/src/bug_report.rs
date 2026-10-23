use crate::database::repositories::setting::SettingsRepository;
use crate::state::AppState;
use crate::release_check::REPO;
use tauri::{AppHandle, Manager, Runtime};

struct Environment {
    app_version: String,
    os: String,
    arch: String,
    voice_model: Option<String>,
    ai_model: Option<String>,
}

fn os_name() -> String {
    let detected = if cfg!(target_os = "linux") {
        sysinfo::System::name().map(|name| match sysinfo::System::os_version() {
            Some(version) => format!("{} {}", name, version),
            None => name,
        })
    } else {
        sysinfo::System::long_os_version()
    };
    detected.unwrap_or_else(|| std::env::consts::OS.to_string())
}

fn model_label(provider: &str, model: &str) -> Option<String> {
    match (provider.trim(), model.trim()) {
        ("", _) => None,
        (provider, "") => Some(provider.to_string()),
        (provider, model) => Some(format!("{} / {}", provider, model)),
    }
}

fn issue_body(env: &Environment) -> String {
    let mut lines = vec![
        "**What happened**".to_string(),
        String::new(),
        String::new(),
        "**What you expected**".to_string(),
        String::new(),
        String::new(),
        "**Steps to reproduce**".to_string(),
        "1. ".to_string(),
        String::new(),
        "**Environment**".to_string(),
        format!("- App: Meetily Pro {}", env.app_version),
        format!("- OS: {} ({})", env.os, env.arch),
    ];
    if let Some(voice) = &env.voice_model {
        lines.push(format!("- Voice model: {}", voice));
    }
    if let Some(ai) = &env.ai_model {
        lines.push(format!("- AI model: {}", ai));
    }
    lines.join("\n")
}

fn issue_url(env: &Environment) -> String {
    let new_issue = format!("https://github.com/{}/issues/new", REPO);
    reqwest::Url::parse_with_params(&new_issue, &[("template", "bug_report.md"), ("body", issue_body(env).as_str())])
        .map(String::from)
        .unwrap_or(new_issue)
}

#[tauri::command]
pub async fn bug_report_url<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let (mut voice_model, mut ai_model) = (None, None);
    if let Some(state) = app.try_state::<AppState>() {
        let pool = state.db_manager.pool();
        if let Ok(Some(setting)) = SettingsRepository::get_transcript_config(pool).await {
            voice_model = model_label(&setting.provider, &setting.model);
        }
        if let Ok(Some(setting)) = SettingsRepository::get_model_config(pool).await {
            ai_model = model_label(&setting.provider, &setting.model);
        }
    }
    Ok(issue_url(&Environment {
        app_version: app.package_info().version.to_string(),
        os: os_name(),
        arch: std::env::consts::ARCH.to_string(),
        voice_model,
        ai_model,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn environment() -> Environment {
        Environment {
            app_version: "1.9.0".to_string(),
            os: "macOS 15.1".to_string(),
            arch: "aarch64".to_string(),
            voice_model: model_label("openai-speech", "gpt-transcribe"),
            ai_model: model_label("", ""),
        }
    }

    #[test]
    fn the_report_lists_the_app_os_and_models_in_use() {
        let body = issue_body(&environment());
        assert!(body.contains("- App: Meetily Pro 1.9.0"));
        assert!(body.contains("- OS: macOS 15.1 (aarch64)"));
        assert!(body.contains("- Voice model: openai-speech / gpt-transcribe"));
        assert!(!body.contains("AI model"));
    }

    #[test]
    fn the_link_opens_a_prefilled_bug_issue_on_the_fork() {
        let url = reqwest::Url::parse(&issue_url(&environment())).unwrap();
        assert_eq!(url.as_str().split('?').next(), Some("https://github.com/asidko/meetily-pro/issues/new"));
        let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(params.get("template").map(String::as_str), Some("bug_report.md"));
        assert!(params["body"].contains("- OS: macOS 15.1 (aarch64)"));
    }
}

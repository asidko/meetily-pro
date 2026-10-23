use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const REPO: &str = "asidko/meetily-pro";
const RATE_LIMITED: &str = "GitHub limits how often it can be asked. Try again in an hour.";

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ReleaseCheck {
    pub available: bool,
    pub current_version: String,
    pub version: String,
    pub url: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or_default()
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let (mut latest, mut current) = (version_parts(latest), version_parts(current));
    let width = latest.len().max(current.len());
    latest.resize(width, 0);
    current.resize(width, 0);
    latest > current
}

fn compare(release: GithubRelease, current_version: &str) -> ReleaseCheck {
    let version = release.tag_name.trim_start_matches('v').to_string();
    ReleaseCheck {
        available: is_newer(&version, current_version),
        current_version: current_version.to_string(),
        version,
        url: release.html_url,
        date: release.published_at,
        notes: release.body.filter(|body| !body.trim().is_empty()),
    }
}

#[tauri::command]
pub async fn check_latest_release() -> Result<ReleaseCheck, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Meetily-Pro/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("https://api.github.com/repos/{}/releases/latest", REPO))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        let rate_limited = response
            .headers()
            .get("x-ratelimit-remaining")
            .is_some_and(|remaining| remaining == "0");
        return Err(match status {
            reqwest::StatusCode::NOT_FOUND => "No release has been published yet".to_string(),
            reqwest::StatusCode::TOO_MANY_REQUESTS => RATE_LIMITED.to_string(),
            _ if rate_limited => RATE_LIMITED.to_string(),
            _ => format!("GitHub answered {}", status),
        });
    }
    let release: GithubRelease = response
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from GitHub: {}", e))?;
    Ok(compare(release, env!("CARGO_PKG_VERSION")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            html_url: format!("https://github.com/asidko/meetily-pro/releases/tag/{}", tag),
            published_at: Some("2026-10-22T00:00:00Z".to_string()),
            body: Some(" ".to_string()),
        }
    }

    #[test]
    fn compares_versions_by_number_not_text() {
        assert!(is_newer("1.10.0", "1.9.0"));
        assert!(is_newer("v2.0", "1.99.99"));
        assert!(!is_newer("1.8.0", "1.8.0"));
        assert!(!is_newer("1.7.9", "1.8.0"));
        assert!(!is_newer("1.8.0-beta", "1.8.0"));
    }

    #[test]
    fn reports_a_newer_release_with_its_page() {
        let check = compare(release("v1.9.0"), "1.8.0");
        assert!(check.available);
        assert_eq!(check.version, "1.9.0");
        assert_eq!(check.url, "https://github.com/asidko/meetily-pro/releases/tag/v1.9.0");
        assert_eq!(check.notes, None);
    }

    #[test]
    fn the_running_release_is_up_to_date() {
        assert!(!compare(release("v1.8.0"), "1.8.0").available);
    }
}

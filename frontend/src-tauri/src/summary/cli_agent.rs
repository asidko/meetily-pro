use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use super::llm_client::{await_or_cancel, provider_name, LLMProvider, REQUEST_TIMEOUT_DURATION};

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_MODEL: &str = "default";
const CLAUDE_CODE_MODELS: [&str; 3] = ["sonnet", "opus", "haiku"];
const CLAUDE_CODE_SETTINGS: &str = r#"{"disableAllHooks":true}"#;
const CODEX_SCRUBBED_ENV: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];
const CODEX_DISABLED_FEATURES: [&str; 16] = [
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "remote_plugin",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "multi_agent",
    "view_image",
    "hooks",
    "skill_search",
    "tool_suggest",
    "goals",
];
const SCHEMA_FILE: &str = "schema.json";
const ENV_MARKER: &str = "__MEETILY_ENV__";
const SHELL_ONLY_VARS: [&str; 5] = ["PATH", "PWD", "OLDPWD", "SHLVL", "_"];

static LOGIN_ENV: OnceCell<LoginEnv> = OnceCell::const_new();

struct LoginEnv {
    path: OsString,
    vars: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAgent {
    ClaudeCode,
    Codex,
}

impl CliAgent {
    pub fn of(provider: &LLMProvider) -> Option<Self> {
        match provider {
            LLMProvider::ClaudeCode => Some(Self::ClaudeCode),
            LLMProvider::Codex => Some(Self::Codex),
            _ => None,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
        }
    }

    fn label(self) -> &'static str {
        provider_name(match self {
            Self::ClaudeCode => &LLMProvider::ClaudeCode,
            Self::Codex => &LLMProvider::Codex,
        })
    }

    fn sign_in_args(self) -> [&'static str; 2] {
        match self {
            Self::ClaudeCode => ["auth", "status"],
            Self::Codex => ["login", "status"],
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub signed_in: bool,
    pub models: Vec<String>,
}

fn unique_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen = Vec::new();
    for dir in dirs {
        if !dir.as_os_str().is_empty() && !seen.contains(&dir) {
            seen.push(dir);
        }
    }
    seen
}

fn build_search_path(login_path: Option<&str>, process_path: Option<&OsStr>, home: Option<&Path>) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = login_path {
        dirs.extend(std::env::split_paths(path));
    }
    if let Some(path) = process_path {
        dirs.extend(std::env::split_paths(path));
    }
    if let Some(home) = home {
        for relative in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
            dirs.push(home.join(relative));
        }
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    std::env::join_paths(unique_dirs(dirs)).unwrap_or_default()
}

fn extract_marked(stdout: &str) -> Option<&str> {
    let mut parts = stdout.split(ENV_MARKER);
    parts.next()?;
    let marked = parts.next()?;
    parts.next()?;
    (!marked.trim().is_empty()).then_some(marked)
}

fn parse_env(listing: &str) -> Vec<(String, String)> {
    let entries: Vec<&str> = if listing.contains('\0') { listing.split('\0').collect() } else { listing.lines().collect() };
    entries
        .into_iter()
        .filter_map(|entry| entry.split_once('='))
        .filter(|(name, _)| {
            name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

#[cfg(unix)]
async fn login_shell_env() -> Vec<(String, String)> {
    let Some(shell) = std::env::var("SHELL").ok().filter(|shell| !shell.is_empty()) else {
        return Vec::new();
    };
    let script = format!("printf '{marker}'; env -0 2>/dev/null || env; printf '{marker}'", marker = ENV_MARKER);
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .process_group(0);
    let Ok(output) = run(command, "", SHELL_TIMEOUT, None).await else {
        return Vec::new();
    };
    extract_marked(&String::from_utf8_lossy(&output.stdout)).map(parse_env).unwrap_or_default()
}

#[cfg(not(unix))]
async fn login_shell_env() -> Vec<(String, String)> {
    Vec::new()
}

async fn login_env() -> &'static LoginEnv {
    LOGIN_ENV
        .get_or_init(|| async {
            let vars = login_shell_env().await;
            let login_path = vars.iter().find(|(name, _)| name == "PATH").map(|(_, value)| value.as_str());
            let path = build_search_path(login_path, std::env::var_os("PATH").as_deref(), dirs::home_dir().as_deref());
            let vars = vars.into_iter().filter(|(name, _)| !SHELL_ONLY_VARS.contains(&name.as_str())).collect();
            LoginEnv { path, vars }
        })
        .await
}

#[cfg(unix)]
fn locate(agent: CliAgent, path: &OsStr) -> Option<PathBuf> {
    which::which_in(agent.binary(), Some(path), std::env::temp_dir()).ok()
}

#[cfg(not(unix))]
fn locate(_agent: CliAgent, _path: &OsStr) -> Option<PathBuf> {
    None
}

fn command(agent: CliAgent, binary: &Path, env: &LoginEnv) -> Command {
    let mut command = Command::new(binary);
    command
        .envs(env.vars.iter().map(|(name, value)| (name, value)))
        .env("PATH", &env.path)
        .env_remove("RUST_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match agent {
        CliAgent::ClaudeCode => {
            command.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
            command.env("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1");
        }
        CliAgent::Codex => {
            for name in CODEX_SCRUBBED_ENV {
                command.env_remove(name);
            }
        }
    }
    #[cfg(unix)]
    command.process_group(0);
    command
}

#[cfg_attr(not(unix), allow(dead_code))]
struct ProcessGroup(Option<u32>);

impl ProcessGroup {
    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| i32::try_from(pid).ok()) {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

async fn run(mut command: Command, input: &str, limit: Duration, token: Option<&CancellationToken>) -> Result<Output, String> {
    let mut child = command.spawn().map_err(|e| format!("Could not start: {}", e))?;
    let mut group = ProcessGroup(child.id());
    if let Some(mut stdin) = child.stdin.take() {
        let input = input.to_owned();
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
        });
    }
    let finished = await_or_cancel(tokio::time::timeout(limit, child.wait_with_output()), token).await?;
    let output = finished
        .map_err(|_| format!("No answer within {} seconds", limit.as_secs()))?
        .map_err(|e| e.to_string())?;
    group.disarm();
    Ok(output)
}

async fn probe(agent: CliAgent, binary: &Path, env: &LoginEnv, args: &[&str]) -> Option<Output> {
    let mut command = command(agent, binary, env);
    command.args(args).current_dir(std::env::temp_dir());
    run(command, "", PROBE_TIMEOUT, None).await.ok()
}

fn nonempty_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn short_version(line: &str) -> String {
    line.split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()) && word.contains('.'))
        .map(|number| format!("v{}", number))
        .unwrap_or_else(|| line.to_string())
}

fn parse_codex_models(stdout: &[u8]) -> Vec<String> {
    let Ok(catalog) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let mut listed: Vec<(i64, String)> = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["visibility"].as_str() == Some("list"))
        .filter_map(|model| {
            let slug = model["slug"].as_str()?.to_string();
            Some((model["priority"].as_i64().unwrap_or(i64::MAX), slug))
        })
        .collect();
    listed.sort();
    listed.into_iter().map(|(_, slug)| slug).collect()
}

async fn models(agent: CliAgent, binary: &Path, env: &LoginEnv) -> Vec<String> {
    let listed = match agent {
        CliAgent::ClaudeCode => CLAUDE_CODE_MODELS.map(str::to_string).to_vec(),
        CliAgent::Codex => probe(agent, binary, env, &["debug", "models"])
            .await
            .filter(|output| output.status.success())
            .map(|output| parse_codex_models(&output.stdout))
            .unwrap_or_default(),
    };
    if listed.is_empty() {
        vec![DEFAULT_MODEL.to_string()]
    } else {
        listed
    }
}

pub async fn status(agent: CliAgent) -> CliAgentStatus {
    let env = login_env().await;
    let Some(binary) = locate(agent, &env.path) else {
        return CliAgentStatus { installed: false, version: None, signed_in: false, models: Vec::new() };
    };
    let sign_in_args = agent.sign_in_args();
    let (version, sign_in) = tokio::join!(
        probe(agent, &binary, env, &["--version"]),
        probe(agent, &binary, env, &sign_in_args)
    );
    let signed_in = sign_in.is_some_and(|output| output.status.success());
    CliAgentStatus {
        installed: true,
        version: version.and_then(|output| nonempty_lines(&output.stdout).into_iter().next()).map(|line| short_version(&line)),
        signed_in,
        models: if signed_in { models(agent, &binary, env).await } else { Vec::new() },
    }
}

fn claude_code_args<'a>(model: &'a str, system_prompt: &'a str, json_schema: Option<&'a str>) -> Vec<&'a str> {
    let mut args = vec![
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--setting-sources",
        "user",
        "--settings",
        CLAUDE_CODE_SETTINGS,
        "--disable-slash-commands",
        "--model",
        model,
        "--system-prompt",
        system_prompt,
    ];
    if let Some(schema) = json_schema {
        args.extend(["--json-schema", schema]);
    }
    args
}

fn codex_credentials_store(config: &str) -> Option<String> {
    config
        .lines()
        .map(str::trim)
        .take_while(|line| !line.starts_with('['))
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            (key.trim() == "cli_auth_credentials_store" && value.chars().all(|c| c.is_ascii_alphabetic()))
                .then(|| value.to_string())
        })
}

fn user_codex_credentials_store(env: &LoginEnv) -> Option<String> {
    let home = env
        .vars
        .iter()
        .find(|(name, _)| name == "CODEX_HOME")
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| std::env::var_os("CODEX_HOME").map(PathBuf::from))
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    codex_credentials_store(&std::fs::read_to_string(home.join("config.toml")).ok()?)
}

fn codex_args(model: &str, schema_file: Option<&str>, credentials_store: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = [
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "-c",
        "web_search=\"disabled\"",
    ]
    .map(str::to_string)
    .to_vec();
    for feature in CODEX_DISABLED_FEATURES {
        args.extend(["-c".to_string(), format!("features.{}=false", feature)]);
    }
    if let Some(store) = credentials_store {
        args.extend(["-c".to_string(), format!("cli_auth_credentials_store=\"{}\"", store)]);
    }
    if let Some(file) = schema_file {
        args.extend(["--output-schema".to_string(), file.to_string()]);
    }
    if model != DEFAULT_MODEL {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    args
}

fn stderr_reason(output: &Output) -> String {
    let lines = nonempty_lines(&output.stderr);
    let reported = lines.iter().rev().find_map(|line| line.strip_prefix("ERROR:").map(str::trim));
    match reported {
        Some(error) => crate::assistant::service::provider_message(error).unwrap_or_else(|| error.to_string()),
        None => lines.last().cloned().unwrap_or_else(|| format!("exited with {}", output.status)),
    }
}

fn parse_claude_code_output(output: &Output) -> Result<String, String> {
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| stderr_reason(output))?;
    let result = match &envelope["structured_output"] {
        serde_json::Value::Null => envelope["result"].as_str().unwrap_or_default().trim().to_string(),
        structured => structured.to_string(),
    };
    if envelope["is_error"].as_bool() == Some(true) || !output.status.success() {
        return Err(if result.is_empty() { stderr_reason(output) } else { result });
    }
    Ok(result)
}

fn parse_codex_output(output: &Output) -> Result<String, String> {
    if !output.status.success() {
        return Err(stderr_reason(output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn nonempty_answer(answer: String) -> Result<String, String> {
    if answer.is_empty() {
        Err("returned an empty answer".to_string())
    } else {
        Ok(answer)
    }
}

fn write_schema(workdir: &TempDir, schema: &str) -> Result<String, String> {
    let file = workdir.path().join(SCHEMA_FILE);
    std::fs::write(&file, schema).map_err(|e| format!("Could not write the answer format: {}", e))?;
    Ok(file.to_string_lossy().into_owned())
}

pub async fn complete(
    agent: CliAgent,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
    json_schema: Option<&str>,
    token: Option<&CancellationToken>,
) -> Result<String, String> {
    let env = login_env().await;
    let binary = locate(agent, &env.path).ok_or_else(|| format!("{} is not installed", agent.label()))?;
    let workdir = tempfile::tempdir().map_err(|e| format!("Could not create a working folder: {}", e))?;
    let mut command = command(agent, &binary, env);
    command.current_dir(workdir.path());
    let input = match agent {
        CliAgent::ClaudeCode => {
            command.args(claude_code_args(model, system_prompt, json_schema));
            user_prompt.to_string()
        }
        CliAgent::Codex => {
            let schema_file = json_schema.map(|schema| write_schema(&workdir, schema)).transpose()?;
            command.args(codex_args(model, schema_file.as_deref(), user_codex_credentials_store(env).as_deref()));
            format!("{}\n\n{}", system_prompt, user_prompt)
        }
    };
    run(command, &input, REQUEST_TIMEOUT_DURATION, token)
        .await
        .and_then(|output| match agent {
            CliAgent::ClaudeCode => parse_claude_code_output(&output),
            CliAgent::Codex => parse_codex_output(&output),
        })
        .and_then(nonempty_answer)
        .map_err(|e| format!("{}: {}", agent.label(), e))
}

#[tauri::command]
pub async fn cli_agent_status(agent: String) -> Result<CliAgentStatus, String> {
    let agent = LLMProvider::from_str(&agent)
        .ok()
        .and_then(|provider| CliAgent::of(&provider))
        .ok_or_else(|| format!("Unknown agent: {}", agent))?;
    Ok(status(agent).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn output(code: i32, stdout: &str, stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn maps_only_cli_providers() {
        assert_eq!(CliAgent::of(&LLMProvider::ClaudeCode), Some(CliAgent::ClaudeCode));
        assert_eq!(CliAgent::of(&LLMProvider::Codex), Some(CliAgent::Codex));
        assert_eq!(CliAgent::of(&LLMProvider::Claude), None);
        assert_eq!(CliAgent::ClaudeCode.label(), "Claude Code");
    }

    #[test]
    fn extracts_env_between_markers_and_ignores_shell_noise() {
        let stdout = format!("welcome banner\n{m}PATH=/usr/bin:/opt/bin\n{m}", m = ENV_MARKER);
        assert_eq!(extract_marked(&stdout), Some("PATH=/usr/bin:/opt/bin\n"));
        assert_eq!(extract_marked("no markers here"), None);
        assert_eq!(extract_marked(&format!("{m}{m}", m = ENV_MARKER)), None);
    }

    #[test]
    fn reads_nul_separated_login_env_with_multiline_values() {
        let listing = "ANTHROPIC_CUSTOM_HEADERS=X-A: 1\nX-B: 2\0HOME=/home/u\0";
        assert_eq!(
            parse_env(listing),
            vec![
                ("ANTHROPIC_CUSTOM_HEADERS".to_string(), "X-A: 1\nX-B: 2".to_string()),
                ("HOME".to_string(), "/home/u".to_string()),
            ]
        );
    }

    #[test]
    fn reads_login_env_and_skips_shell_functions() {
        let listing = "CLAUDE_CONFIG_DIR=/home/u/.claude-work\nBASH_FUNC_f%%=() {  a=1\n}\n  local b=2\nTOKEN=a=b\n";
        assert_eq!(
            parse_env(listing),
            vec![
                ("CLAUDE_CONFIG_DIR".to_string(), "/home/u/.claude-work".to_string()),
                ("TOKEN".to_string(), "a=b".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn search_path_puts_login_path_first_and_drops_duplicates() {
        let path = build_search_path(Some("/login/bin:/usr/bin"), Some(OsStr::new("/usr/bin:/bin")), Some(Path::new("/home/u")));
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert_eq!(dirs[0], PathBuf::from("/login/bin"));
        assert_eq!(dirs.iter().filter(|dir| dir.as_path() == Path::new("/usr/bin")).count(), 1);
        assert!(dirs.contains(&PathBuf::from("/home/u/.local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn lists_only_pickable_codex_models_by_priority() {
        let catalog = r#"{"models":[
            {"slug":"b","visibility":"list","priority":5},
            {"slug":"hidden","visibility":"hide","priority":1},
            {"slug":"a","visibility":"list","priority":2}
        ]}"#;
        assert_eq!(parse_codex_models(catalog.as_bytes()), vec!["a", "b"]);
        assert!(parse_codex_models(b"not json").is_empty());
    }

    #[test]
    fn claude_code_runs_with_user_auth_but_without_tools_sessions_or_hooks() {
        let args = claude_code_args("haiku", "sys", None);
        let after = |flag: &str| args[args.iter().position(|arg| *arg == flag).unwrap() + 1];
        assert_eq!(after("--tools"), "");
        assert_eq!(after("--setting-sources"), "user");
        assert_eq!(after("--settings"), CLAUDE_CODE_SETTINGS);
        assert_eq!(after("--model"), "haiku");
        assert_eq!(after("--system-prompt"), "sys");
        assert!(args.contains(&"--no-session-persistence"));
        assert!(args.contains(&"--strict-mcp-config"));
        assert!(!args.contains(&"--json-schema"));
        let with_schema = claude_code_args("haiku", "sys", Some("{}"));
        assert!(with_schema.windows(2).any(|pair| pair == ["--json-schema", "{}"]));
    }

    #[test]
    fn codex_runs_read_only_and_ephemeral_without_shell_or_web() {
        let args = codex_args(DEFAULT_MODEL, None, None);
        let has_pair = |args: &[String], a: &str, b: &str| args.windows(2).any(|pair| pair[0] == a && pair[1] == b);
        assert!(has_pair(&args, "--sandbox", "read-only"));
        assert!(has_pair(&args, "-c", "features.shell_tool=false"));
        assert!(has_pair(&args, "-c", "features.unified_exec=false"));
        assert!(has_pair(&args, "-c", "web_search=\"disabled\""));
        assert!(args.iter().any(|arg| arg == "--ephemeral"));
        assert!(args.iter().any(|arg| arg == "--ignore-user-config"));
        assert!(!args.iter().any(|arg| arg == "--model" || arg == "--output-schema"));
        let picked = codex_args("gpt-x", Some("/tmp/s.json"), Some("keyring"));
        assert!(has_pair(&picked, "--model", "gpt-x"));
        assert!(has_pair(&picked, "--output-schema", "/tmp/s.json"));
        assert!(has_pair(&picked, "-c", "cli_auth_credentials_store=\"keyring\""));
    }

    #[test]
    fn keeps_the_users_codex_credential_store() {
        assert_eq!(codex_credentials_store("model = \"x\"\ncli_auth_credentials_store = \"keyring\"\n"), Some("keyring".to_string()));
        assert_eq!(codex_credentials_store("[profiles.a]\ncli_auth_credentials_store = \"file\"\n"), None);
        assert_eq!(codex_credentials_store("cli_auth_credentials_store = \"x; y\"\n"), None);
        assert_eq!(codex_credentials_store(""), None);
    }

    #[test]
    fn shortens_versions() {
        assert_eq!(short_version("2.1.299 (Claude Code)"), "v2.1.299");
        assert_eq!(short_version("codex-cli 0.154.0"), "v0.154.0");
        assert_eq!(short_version("dev build"), "dev build");
    }

    #[cfg(unix)]
    #[test]
    fn reads_claude_code_envelope() {
        let ok = output(0, r#"{"is_error":false,"result":" Answer. "}"#, "");
        assert_eq!(parse_claude_code_output(&ok), Ok("Answer.".to_string()));
        let structured = output(0, r#"{"is_error":false,"result":"done","structured_output":{"new":[]}}"#, "");
        assert_eq!(parse_claude_code_output(&structured), Ok(r#"{"new":[]}"#.to_string()));
        let failed = output(1, r#"{"is_error":true,"result":"Not logged in"}"#, "");
        assert_eq!(parse_claude_code_output(&failed), Err("Not logged in".to_string()));
        let garbage = output(1, "", "boom\n");
        assert_eq!(parse_claude_code_output(&garbage), Err("boom".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn reads_codex_final_message() {
        assert_eq!(parse_codex_output(&output(0, "{\"ok\":true}\n", "")), Ok("{\"ok\":true}".to_string()));
        assert_eq!(parse_codex_output(&output(1, "", "warn\nNot logged in\n")), Err("Not logged in".to_string()));
        let failed = "user\nSay hi\nERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"message\":\"The 'x' model is not supported\"}}\n2026-10-22T03:35:23Z  INFO codex_core: shutdown\n";
        assert_eq!(parse_codex_output(&output(1, "", failed)), Err("The 'x' model is not supported".to_string()));
        assert_eq!(parse_codex_output(&output(1, "", "ERROR: stream disconnected\n")), Err("stream disconnected".to_string()));
        assert_eq!(parse_codex_output(&output(0, "  ", "")), Ok(String::new()));
        assert!(nonempty_answer(String::new()).is_err());
        assert_eq!(nonempty_answer("ok".to_string()), Ok("ok".to_string()));
    }
}

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::session_manager::providers::cursor::{self, CursorSessionRecord};
use crate::session_manager::resume::{
    apply_decision, resume_decision_for_session, LiveProcessView, ResumeDecision,
    ResumeLaunchResult,
};
use crate::settings::{CursorOfficialAuthMode, CursorOfficialSettings};

const OFFICIAL_ENV_REMOVALS: [&str; 5] = [
    "CURSOR_API_ENDPOINT",
    "CURSOR_LOCAL_AGENT_BASE_URL",
    "CURSOR_LOCAL_AGENT_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
];
const CURSOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(not(target_os = "windows"))]
const CURSOR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const CURSOR_CAPTURE_MAX_BYTES: usize = 64 * 1024;
const CURSOR_VERSION_MAX_CHARS: usize = 120;
const CURSOR_ACCOUNT_FIELD_MAX_CHARS: usize = 160;
const CURSOR_ERROR_MAX_CHARS: usize = 240;
const CURSOR_LAUNCHER_PREFIX: &str = "cc-switch-cursor-launcher-";
const CURSOR_LAUNCHER_FILE_NAME: &str = "cursor-launcher.sh";
const CURSOR_LAUNCHER_HEADER: &str = "#!/bin/sh\n# CC Switch Cursor launcher v1\n";
const CURSOR_LAUNCHER_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "workspaceState", rename_all = "camelCase")]
pub enum CursorResumeContext {
    Ready { workspace: String },
    WorkspaceRequired,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CursorLaunchResult {
    Launched,
    WorkspaceRequired,
    Focused { app: String },
    Occupied { holder: String },
}

/// In-app PTY spawn result for Cursor. Same live-session Focus/Occupied
/// semantics as external launch; `Launched` always includes a new `ptyId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CursorPtySpawnResult {
    Launched {
        #[serde(rename = "ptyId")]
        pty_id: String,
    },
    WorkspaceRequired,
    Focused {
        app: String,
    },
    Occupied {
        holder: String,
    },
}

pub fn cursor_launch_result_from_resume(result: ResumeLaunchResult) -> CursorLaunchResult {
    match result {
        ResumeLaunchResult::Launched => CursorLaunchResult::Launched,
        ResumeLaunchResult::Focused { app } => CursorLaunchResult::Focused { app },
        ResumeLaunchResult::Occupied { holder } => CursorLaunchResult::Occupied { holder },
    }
}

fn reuse_live_session(
    session_id: &str,
    source_path: Option<&Path>,
) -> Result<Option<CursorLaunchResult>, String> {
    let decision = resume_decision_for_session(session_id, source_path, None, &LiveProcessView);
    if matches!(decision, ResumeDecision::LaunchNew) {
        return Ok(None);
    }
    apply_decision(decision).map(|result| Some(cursor_launch_result_from_resume(result)))
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CursorOfficialRuntimeState {
    Ready,
    NeedsLogin,
    NeedsApiKey,
    CliMissing,
    StatusUnavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorOfficialAccount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorOfficialStatus {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub auth_mode: CursorOfficialAuthMode,
    pub has_user_api_key: bool,
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<CursorOfficialAccount>,
    pub state: CursorOfficialRuntimeState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct OfficialEnvPolicy {
    remove: BTreeSet<String>,
    set: BTreeMap<String, String>,
}

impl std::fmt::Debug for OfficialEnvPolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OfficialEnvPolicy")
            .field("remove", &self.remove)
            .field(
                "set",
                &self
                    .set
                    .keys()
                    .map(|key| (key, "[REDACTED]"))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct CursorCommandSpec {
    executable: PathBuf,
    args: Vec<String>,
    env: OfficialEnvPolicy,
}

impl std::fmt::Debug for CursorCommandSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CursorCommandSpec")
            .field("executable", &self.executable)
            .field("args", &self.args)
            .field("env", &self.env)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CursorCommandOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CursorResolveError {
    NotFound,
    #[cfg(not(target_os = "windows"))]
    Other(String),
}

trait CursorCommandRunner {
    fn resolve_agent(&self) -> Result<PathBuf, CursorResolveError>;
    fn run(&self, spec: &CursorCommandSpec) -> Result<CursorCommandOutput, String>;
}

struct SystemCursorCommandRunner;

impl CursorCommandRunner for SystemCursorCommandRunner {
    fn resolve_agent(&self) -> Result<PathBuf, CursorResolveError> {
        resolve_agent_executable()
    }

    fn run(&self, spec: &CursorCommandSpec) -> Result<CursorCommandOutput, String> {
        let mut command = Command::new(&spec.executable);
        command.args(&spec.args);
        for name in &spec.env.remove {
            command.env_remove(name);
        }
        for (name, value) in &spec.env.set {
            command.env(name, value);
        }
        if let Some(effective_path) = effective_command_path(&spec.executable) {
            command.env("PATH", effective_path);
        }
        command.current_dir(crate::config::get_home_dir());
        run_command_bounded(&mut command, CURSOR_COMMAND_TIMEOUT)
    }
}

trait CursorSessionLookup {
    fn find_session(&self, session_id: &str) -> Result<CursorSessionRecord, String>;
}

struct SystemCursorSessionLookup;

impl CursorSessionLookup for SystemCursorSessionLookup {
    fn find_session(&self, session_id: &str) -> Result<CursorSessionRecord, String> {
        cursor::find_session(session_id)
    }
}

trait CursorTerminalLauncher {
    fn launch(&self, launcher_path: &Path, workspace: &Path) -> Result<(), String>;
}

struct SystemCursorTerminalLauncher;

impl CursorTerminalLauncher for SystemCursorTerminalLauncher {
    fn launch(&self, launcher_path: &Path, workspace: &Path) -> Result<(), String> {
        crate::session_manager::terminal::launch_cursor_launcher(launcher_path, workspace)
    }
}

fn official_env(
    auth_mode: CursorOfficialAuthMode,
    user_api_key: Option<&str>,
) -> OfficialEnvPolicy {
    let mut remove = OFFICIAL_ENV_REMOVALS
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    remove.insert("CURSOR_API_KEY".to_string());

    let mut set = BTreeMap::new();
    if auth_mode == CursorOfficialAuthMode::UserApiKey {
        if let Some(key) = user_api_key {
            set.insert("CURSOR_API_KEY".to_string(), key.to_string());
        }
    }
    OfficialEnvPolicy { remove, set }
}

fn build_version_args() -> Vec<String> {
    vec!["--version".to_string()]
}

fn build_status_args() -> Vec<String> {
    vec![
        "status".to_string(),
        "--format".to_string(),
        "json".to_string(),
    ]
}

fn build_command_spec(
    executable: &Path,
    args: Vec<String>,
    env: OfficialEnvPolicy,
) -> CursorCommandSpec {
    CursorCommandSpec {
        executable: executable.to_path_buf(),
        args,
        env,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCursorStatus {
    is_authenticated: Option<bool>,
    #[serde(default)]
    user_info: Option<RawCursorUserInfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCursorUserInfo {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
}

struct ParsedCursorStatus {
    authenticated: bool,
    account: Option<CursorOfficialAccount>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_status_json(raw: &str) -> Result<ParsedCursorStatus, String> {
    let parsed: RawCursorStatus = serde_json::from_str(raw)
        .map_err(|error| format!("Invalid Cursor status JSON: {error}"))?;
    let authenticated = parsed
        .is_authenticated
        .ok_or_else(|| "Invalid Cursor status JSON: missing isAuthenticated".to_string())?;
    let account = parsed.user_info.and_then(|user| {
        let account = CursorOfficialAccount {
            email: non_empty(user.email),
            first_name: non_empty(user.first_name),
            last_name: non_empty(user.last_name),
        };
        (account.email.is_some() || account.first_name.is_some() || account.last_name.is_some())
            .then_some(account)
    });

    Ok(ParsedCursorStatus {
        authenticated,
        account,
    })
}

fn bound_chars(raw: &str, max_chars: usize) -> String {
    if raw.chars().count() <= max_chars {
        return raw.to_string();
    }
    let mut bounded = raw.chars().take(max_chars).collect::<String>();
    bounded.push_str("...");
    bounded
}

fn sanitize_cursor_display_field(
    raw: &str,
    known_secrets: &[String],
    max_chars: usize,
) -> Option<String> {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return None;
    }

    Some(bound_chars(
        &crate::redact_known_secrets_strict(&compact, known_secrets),
        max_chars,
    ))
}

fn sanitize_cursor_account(
    account: CursorOfficialAccount,
    known_secrets: &[String],
) -> Option<CursorOfficialAccount> {
    let account = CursorOfficialAccount {
        email: account.email.and_then(|value| {
            sanitize_cursor_display_field(&value, known_secrets, CURSOR_ACCOUNT_FIELD_MAX_CHARS)
        }),
        first_name: account.first_name.and_then(|value| {
            sanitize_cursor_display_field(&value, known_secrets, CURSOR_ACCOUNT_FIELD_MAX_CHARS)
        }),
        last_name: account.last_name.and_then(|value| {
            sanitize_cursor_display_field(&value, known_secrets, CURSOR_ACCOUNT_FIELD_MAX_CHARS)
        }),
    };

    (account.email.is_some() || account.first_name.is_some() || account.last_name.is_some())
        .then_some(account)
}

fn sanitize_cursor_error(raw: &str, known_secrets: &[String]) -> String {
    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = if compact.is_empty() {
        "Cursor command failed".to_string()
    } else {
        compact
    };
    bound_chars(
        &crate::redact_known_secrets_strict(&compact, known_secrets),
        CURSOR_ERROR_MAX_CHARS,
    )
}

fn first_non_empty_line(raw: &str) -> Option<String> {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn output_error(output: &CursorCommandOutput) -> String {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    if detail.is_empty() {
        format!("Cursor command failed (exit code: {:?})", output.code)
    } else {
        detail.to_string()
    }
}

fn status_shell(
    settings: &CursorOfficialSettings,
    installed: bool,
    version: Option<String>,
    state: CursorOfficialRuntimeState,
    authenticated: bool,
    account: Option<CursorOfficialAccount>,
    error: Option<String>,
) -> CursorOfficialStatus {
    let known_secrets = configured_user_api_key(settings)
        .map(str::to_string)
        .into_iter()
        .collect::<Vec<_>>();
    CursorOfficialStatus {
        installed,
        version: version.and_then(|value| {
            sanitize_cursor_display_field(&value, &known_secrets, CURSOR_VERSION_MAX_CHARS)
        }),
        auth_mode: settings.auth_mode,
        has_user_api_key: configured_user_api_key(settings).is_some(),
        authenticated,
        account: account.and_then(|account| sanitize_cursor_account(account, &known_secrets)),
        state,
        error: error.map(|error| sanitize_cursor_error(&error, &known_secrets)),
    }
}

fn configured_user_api_key(settings: &CursorOfficialSettings) -> Option<&str> {
    settings
        .user_api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
}

fn remediation_state(auth_mode: CursorOfficialAuthMode) -> CursorOfficialRuntimeState {
    match auth_mode {
        CursorOfficialAuthMode::Login => CursorOfficialRuntimeState::NeedsLogin,
        CursorOfficialAuthMode::UserApiKey => CursorOfficialRuntimeState::NeedsApiKey,
    }
}

fn get_status_with_runner<R: CursorCommandRunner>(
    runner: &R,
    settings: &CursorOfficialSettings,
) -> CursorOfficialStatus {
    let configured_key = configured_user_api_key(settings);
    let known_secrets = configured_key
        .map(str::to_string)
        .into_iter()
        .collect::<Vec<_>>();
    let executable = match runner.resolve_agent() {
        Ok(executable) => executable,
        Err(CursorResolveError::NotFound) => {
            return status_shell(
                settings,
                false,
                None,
                CursorOfficialRuntimeState::CliMissing,
                false,
                None,
                None,
            );
        }
        #[cfg(not(target_os = "windows"))]
        Err(CursorResolveError::Other(error)) => {
            return status_shell(
                settings,
                false,
                None,
                CursorOfficialRuntimeState::StatusUnavailable,
                false,
                None,
                Some(sanitize_cursor_error(&error, &known_secrets)),
            );
        }
    };

    let version_spec = build_command_spec(
        &executable,
        build_version_args(),
        official_env(CursorOfficialAuthMode::Login, None),
    );
    let version_output = match runner.run(&version_spec) {
        Ok(output) => output,
        Err(error) => {
            return status_shell(
                settings,
                true,
                None,
                CursorOfficialRuntimeState::StatusUnavailable,
                false,
                None,
                Some(sanitize_cursor_error(&error, &known_secrets)),
            );
        }
    };
    if !version_output.success {
        return status_shell(
            settings,
            true,
            None,
            CursorOfficialRuntimeState::StatusUnavailable,
            false,
            None,
            Some(sanitize_cursor_error(
                &output_error(&version_output),
                &known_secrets,
            )),
        );
    }
    let version = first_non_empty_line(&version_output.stdout)
        .or_else(|| first_non_empty_line(&version_output.stderr));

    if settings.auth_mode == CursorOfficialAuthMode::UserApiKey && configured_key.is_none() {
        return status_shell(
            settings,
            true,
            version,
            CursorOfficialRuntimeState::NeedsApiKey,
            false,
            None,
            None,
        );
    }

    let status_spec = build_command_spec(
        &executable,
        build_status_args(),
        official_env(settings.auth_mode, configured_key),
    );
    let status_output = match runner.run(&status_spec) {
        Ok(output) => output,
        Err(error) => {
            return status_shell(
                settings,
                true,
                version,
                CursorOfficialRuntimeState::StatusUnavailable,
                false,
                None,
                Some(sanitize_cursor_error(&error, &known_secrets)),
            );
        }
    };
    if !status_output.success {
        return status_shell(
            settings,
            true,
            version,
            remediation_state(settings.auth_mode),
            false,
            None,
            Some(sanitize_cursor_error(
                &output_error(&status_output),
                &known_secrets,
            )),
        );
    }

    let parsed = match parse_status_json(&status_output.stdout) {
        Ok(parsed) => parsed,
        Err(error) => {
            return status_shell(
                settings,
                true,
                version,
                CursorOfficialRuntimeState::StatusUnavailable,
                false,
                None,
                Some(sanitize_cursor_error(&error, &known_secrets)),
            );
        }
    };
    let state = if parsed.authenticated {
        CursorOfficialRuntimeState::Ready
    } else {
        remediation_state(settings.auth_mode)
    };
    status_shell(
        settings,
        true,
        version,
        state,
        parsed.authenticated,
        parsed.account,
        None,
    )
}

pub fn get_status() -> CursorOfficialStatus {
    get_status_with_runner(
        &SystemCursorCommandRunner,
        &crate::settings::get_cursor_official_settings(),
    )
}

fn validate_chat_id(session_id: &str) -> Result<(), String> {
    Uuid::parse_str(session_id)
        .map(|_| ())
        .map_err(|_| "Invalid Cursor chat ID".to_string())
}

fn canonical_metadata_workspace(raw: Option<&str>) -> Option<PathBuf> {
    let raw = raw.map(str::trim).filter(|value| !value.is_empty())?;
    let path = Path::new(raw);
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    fs::metadata(&canonical)
        .is_ok_and(|metadata| metadata.is_dir())
        .then_some(canonical)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MissingWorkspaceOverridePolicy {
    Reject,
    WorkspaceRequired,
}

fn missing_workspace_override(
    policy: MissingWorkspaceOverridePolicy,
) -> Result<Option<PathBuf>, String> {
    match policy {
        MissingWorkspaceOverridePolicy::Reject => {
            Err("Cursor workspace override must be an existing directory".to_string())
        }
        MissingWorkspaceOverridePolicy::WorkspaceRequired => Ok(None),
    }
}

fn canonical_workspace_override(
    raw: Option<&str>,
    missing_policy: MissingWorkspaceOverridePolicy,
) -> Result<Option<PathBuf>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Cursor workspace override must be an existing directory".to_string());
    }
    let path = Path::new(raw);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return missing_workspace_override(missing_policy);
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect Cursor workspace override: {error}"
            ));
        }
    };
    if !metadata.is_dir() {
        return Err("Cursor workspace override must be an existing directory".to_string());
    }
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return missing_workspace_override(missing_policy);
        }
        Err(error) => {
            return Err(format!(
                "Failed to canonicalize Cursor workspace override: {error}"
            ));
        }
    };
    if !fs::metadata(&canonical).is_ok_and(|metadata| metadata.is_dir()) {
        return missing_workspace_override(missing_policy);
    }
    Ok(Some(canonical))
}

fn resolve_workspace(
    record: &CursorSessionRecord,
    workspace_override: Option<&str>,
    missing_policy: MissingWorkspaceOverridePolicy,
) -> Result<Option<PathBuf>, String> {
    if let Some(workspace) = canonical_metadata_workspace(record.cwd.as_deref()) {
        return Ok(Some(workspace));
    }
    canonical_workspace_override(workspace_override, missing_policy)
}

fn workspace_string(workspace: &Path) -> Result<String, String> {
    workspace
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Cursor workspace path must be valid UTF-8".to_string())
}

fn get_resume_context_with_lookup<L: CursorSessionLookup>(
    lookup: &L,
    session_id: &str,
    workspace_override: Option<&str>,
) -> Result<CursorResumeContext, String> {
    validate_chat_id(session_id)?;
    let record = lookup.find_session(session_id)?;
    match resolve_workspace(
        &record,
        workspace_override,
        MissingWorkspaceOverridePolicy::Reject,
    )? {
        Some(workspace) => Ok(CursorResumeContext::Ready {
            workspace: workspace_string(&workspace)?,
        }),
        None => Ok(CursorResumeContext::WorkspaceRequired),
    }
}

pub fn get_resume_context(
    session_id: &str,
    workspace_override: Option<&str>,
) -> Result<CursorResumeContext, String> {
    get_resume_context_with_lookup(&SystemCursorSessionLookup, session_id, workspace_override)
}

fn resume_argv(workspace: &Path, session_id: &str) -> Vec<String> {
    vec![
        "--workspace".to_string(),
        workspace.to_string_lossy().into_owned(),
        "--resume".to_string(),
        session_id.to_string(),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CursorLauncherAction {
    Login,
    Resume { workspace: PathBuf, chat_id: String },
    LoginAndResume { workspace: PathBuf, chat_id: String },
}

#[derive(Clone, PartialEq, Eq)]
struct CursorLauncherSpec {
    executable: PathBuf,
    auth_mode: CursorOfficialAuthMode,
    user_api_key: Option<String>,
    action: CursorLauncherAction,
}

impl std::fmt::Debug for CursorLauncherSpec {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CursorLauncherSpec")
            .field("executable", &self.executable)
            .field("auth_mode", &self.auth_mode)
            .field("has_user_api_key", &self.user_api_key.is_some())
            .field("action", &self.action)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedCursorLauncher {
    path: PathBuf,
    directory: PathBuf,
}

fn shell_command(executable: &Path, args: &[String]) -> Result<String, String> {
    let executable = executable
        .to_str()
        .ok_or_else(|| "Cursor executable path must be valid UTF-8".to_string())?;
    let mut words = Vec::with_capacity(args.len() + 1);
    words.push(crate::session_manager::terminal::shell_escape(executable));
    words.extend(
        args.iter()
            .map(|argument| crate::session_manager::terminal::shell_escape(argument)),
    );
    Ok(words.join(" "))
}

fn render_launcher_script(
    spec: &CursorLauncherSpec,
    launcher_dir: &Path,
) -> Result<String, String> {
    let mut script = String::from(CURSOR_LAUNCHER_HEADER);
    script.push_str("set +e\n");
    let configured_key = spec
        .user_api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty());
    if spec.auth_mode == CursorOfficialAuthMode::UserApiKey && configured_key.is_none() {
        return Err("Cursor User API Key is not configured".to_string());
    }
    let environment = official_env(spec.auth_mode, configured_key);
    for name in environment.remove {
        script.push_str("unset ");
        script.push_str(&name);
        script.push('\n');
    }
    for (name, value) in environment.set {
        script.push_str("export ");
        script.push_str(&name);
        script.push('=');
        script.push_str(&crate::session_manager::terminal::shell_escape(&value));
        script.push('\n');
    }

    let launcher_dir = launcher_dir
        .to_str()
        .ok_or_else(|| "Cursor launcher directory must be valid UTF-8".to_string())?;
    script.push_str("/bin/rm -- \"$0\"\n");
    script.push_str("/bin/rmdir -- ");
    script.push_str(&crate::session_manager::terminal::shell_escape(
        launcher_dir,
    ));
    script.push_str(" 2>/dev/null || true\n");

    match &spec.action {
        CursorLauncherAction::Login => {
            let login = shell_command(&spec.executable, &["login".to_string()])?;
            script.push_str("exec ");
            script.push_str(&login);
            script.push('\n');
        }
        CursorLauncherAction::Resume { workspace, chat_id } => {
            let resume = shell_command(&spec.executable, &resume_argv(workspace, chat_id))?;
            script.push_str("exec ");
            script.push_str(&resume);
            script.push('\n');
        }
        CursorLauncherAction::LoginAndResume { workspace, chat_id } => {
            let login = shell_command(&spec.executable, &["login".to_string()])?;
            let resume = shell_command(&spec.executable, &resume_argv(workspace, chat_id))?;
            script.push_str("if ");
            script.push_str(&login);
            script.push_str("; then\n  exec ");
            script.push_str(&resume);
            script.push_str("\nelse\n  login_status=$?\n  exit \"$login_status\"\nfi\n");
        }
    }
    Ok(script)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to secure Cursor launcher directory: {error}"))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_launcher_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Failed to secure Cursor launcher file: {error}"))
}

#[cfg(not(unix))]
fn set_private_launcher_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn create_launcher_in(
    launcher_root: &Path,
    spec: &CursorLauncherSpec,
) -> Result<PreparedCursorLauncher, String> {
    let temp_dir = tempfile::Builder::new()
        .prefix(CURSOR_LAUNCHER_PREFIX)
        .tempdir_in(launcher_root)
        .map_err(|error| format!("Failed to create Cursor launcher directory: {error}"))?;
    set_private_directory_permissions(temp_dir.path())?;
    let launcher_path = temp_dir.path().join(CURSOR_LAUNCHER_FILE_NAME);
    let script = render_launcher_script(spec, temp_dir.path())?;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o700);
    }
    let mut launcher = options
        .open(&launcher_path)
        .map_err(|error| format!("Failed to create Cursor launcher file: {error}"))?;
    launcher
        .write_all(script.as_bytes())
        .and_then(|_| launcher.sync_all())
        .map_err(|error| format!("Failed to write Cursor launcher file: {error}"))?;
    set_private_launcher_permissions(&launcher_path)?;

    let directory = temp_dir.keep();
    Ok(PreparedCursorLauncher {
        path: launcher_path,
        directory,
    })
}

fn cleanup_prepared_launcher(launcher: &PreparedCursorLauncher) -> Result<(), String> {
    match fs::remove_dir_all(&launcher.directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to clean Cursor launcher directory: {error}"
        )),
    }
}

#[cfg(unix)]
fn has_private_launcher_permissions(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o777 == 0o700)
}

#[cfg(not(unix))]
fn has_private_launcher_permissions(_path: &Path) -> bool {
    true
}

fn owned_launcher_file_in(directory: &Path) -> Option<PathBuf> {
    if !has_private_launcher_permissions(directory) {
        return None;
    }

    let mut entries = fs::read_dir(directory).ok()?;
    let entry = entries.next()?.ok()?;
    if entries.next().is_some()
        || entry.file_name() != CURSOR_LAUNCHER_FILE_NAME
        || !entry.file_type().ok()?.is_file()
        || !has_private_launcher_permissions(&entry.path())
    {
        return None;
    }

    let launcher_path = entry.path();
    let mut launcher = fs::File::open(&launcher_path).ok()?;
    let mut header = vec![0_u8; CURSOR_LAUNCHER_HEADER.len()];
    launcher.read_exact(&mut header).ok()?;
    (header == CURSOR_LAUNCHER_HEADER.as_bytes()).then_some(launcher_path)
}

fn remove_owned_launcher_directory(directory: &Path, launcher_path: &Path) -> Result<(), String> {
    match fs::remove_file(launcher_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to remove stale Cursor launcher file: {error}"
            ));
        }
    }

    match fs::remove_dir(directory) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(format!(
            "Failed to remove stale Cursor launcher directory: {error}"
        )),
    }
}

fn cleanup_stale_launchers_in_at(launcher_root: &Path, now: SystemTime) -> Result<(), String> {
    let entries = fs::read_dir(launcher_root)
        .map_err(|error| format!("Failed to inspect Cursor launcher directory: {error}"))?;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !name.starts_with(CURSOR_LAUNCHER_PREFIX)
            || !entry.file_type().is_ok_and(|file_type| file_type.is_dir())
        {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        let is_expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > CURSOR_LAUNCHER_MAX_AGE);
        if is_expired {
            let directory = entry.path();
            if let Some(launcher_path) = owned_launcher_file_in(&directory) {
                remove_owned_launcher_directory(&directory, &launcher_path)?;
            }
        }
    }
    Ok(())
}

fn cleanup_stale_launchers_in(launcher_root: &Path) -> Result<(), String> {
    cleanup_stale_launchers_in_at(launcher_root, SystemTime::now())
}

fn resolve_launch_executable<R: CursorCommandRunner>(
    runner: &R,
    known_secrets: &[String],
) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let _ = known_secrets;

    match runner.resolve_agent() {
        Ok(executable) => Ok(executable),
        Err(CursorResolveError::NotFound) => Err("Cursor Agent CLI is not installed".to_string()),
        #[cfg(not(target_os = "windows"))]
        Err(CursorResolveError::Other(error)) => Err(sanitize_cursor_error(&error, known_secrets)),
    }
}

fn launch_prepared<T: CursorTerminalLauncher>(
    terminal: &T,
    prepared: &PreparedCursorLauncher,
    workspace: &Path,
    known_secrets: &[String],
) -> Result<CursorLaunchResult, String> {
    match terminal.launch(&prepared.path, workspace) {
        Ok(()) => Ok(CursorLaunchResult::Launched),
        Err(error) => {
            let cleanup_error = cleanup_prepared_launcher(prepared).err();
            let mut error = sanitize_cursor_error(&error, known_secrets);
            if let Some(cleanup_error) = cleanup_error {
                error.push_str("; ");
                error.push_str(&sanitize_cursor_error(&cleanup_error, known_secrets));
            }
            Err(bound_chars(&error, CURSOR_ERROR_MAX_CHARS))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn launch_resume_with<L: CursorSessionLookup, R: CursorCommandRunner, T: CursorTerminalLauncher>(
    lookup: &L,
    runner: &R,
    terminal: &T,
    settings: &CursorOfficialSettings,
    launcher_root: &Path,
    session_id: &str,
    workspace_override: Option<&str>,
    login_first: bool,
) -> Result<CursorLaunchResult, String> {
    validate_chat_id(session_id)?;
    let record = lookup.find_session(session_id)?;
    let live_source = cursor::live_writer_source_path(&record.metadata_path);
    if let Some(result) = reuse_live_session(session_id, Some(&live_source))? {
        return Ok(result);
    }
    let Some(workspace) = resolve_workspace(
        &record,
        workspace_override,
        MissingWorkspaceOverridePolicy::WorkspaceRequired,
    )?
    else {
        return Ok(CursorLaunchResult::WorkspaceRequired);
    };
    workspace_string(&workspace)?;

    let configured_key = configured_user_api_key(settings);
    if !login_first
        && settings.auth_mode == CursorOfficialAuthMode::UserApiKey
        && configured_key.is_none()
    {
        return Err("Cursor User API Key is not configured".to_string());
    }
    let known_secrets = configured_key
        .map(str::to_string)
        .into_iter()
        .collect::<Vec<_>>();
    let executable = resolve_launch_executable(runner, &known_secrets)?;
    cleanup_stale_launchers_in(launcher_root)
        .map_err(|error| sanitize_cursor_error(&error, &known_secrets))?;

    let spec = CursorLauncherSpec {
        executable,
        auth_mode: if login_first {
            CursorOfficialAuthMode::Login
        } else {
            settings.auth_mode
        },
        user_api_key: if login_first {
            None
        } else {
            configured_key.map(str::to_string)
        },
        action: if login_first {
            CursorLauncherAction::LoginAndResume {
                workspace: workspace.clone(),
                chat_id: session_id.to_string(),
            }
        } else {
            CursorLauncherAction::Resume {
                workspace: workspace.clone(),
                chat_id: session_id.to_string(),
            }
        },
    };
    let prepared = create_launcher_in(launcher_root, &spec)
        .map_err(|error| sanitize_cursor_error(&error, &known_secrets))?;
    launch_prepared(terminal, &prepared, &workspace, &known_secrets)
}

fn launch_login_with<R: CursorCommandRunner, T: CursorTerminalLauncher>(
    runner: &R,
    terminal: &T,
    settings: &CursorOfficialSettings,
    launcher_root: &Path,
) -> Result<CursorLaunchResult, String> {
    let configured_key = configured_user_api_key(settings);
    let known_secrets = configured_key
        .map(str::to_string)
        .into_iter()
        .collect::<Vec<_>>();
    let executable = resolve_launch_executable(runner, &known_secrets)?;
    let workspace = crate::config::get_home_dir()
        .canonicalize()
        .map_err(|error| format!("Failed to resolve home directory for Cursor login: {error}"))?;
    cleanup_stale_launchers_in(launcher_root)
        .map_err(|error| sanitize_cursor_error(&error, &known_secrets))?;
    let spec = CursorLauncherSpec {
        executable,
        auth_mode: CursorOfficialAuthMode::Login,
        user_api_key: None,
        action: CursorLauncherAction::Login,
    };
    let prepared = create_launcher_in(launcher_root, &spec)
        .map_err(|error| sanitize_cursor_error(&error, &known_secrets))?;
    launch_prepared(terminal, &prepared, &workspace, &known_secrets)
}

pub fn launch_session(
    session_id: &str,
    workspace_override: Option<&str>,
) -> Result<CursorLaunchResult, String> {
    launch_resume_with(
        &SystemCursorSessionLookup,
        &SystemCursorCommandRunner,
        &SystemCursorTerminalLauncher,
        &crate::settings::get_cursor_official_settings(),
        &std::env::temp_dir(),
        session_id,
        workspace_override,
        false,
    )
}

/// Resume a Cursor session inside an in-app PTY (does not reattach a live tty).
pub fn launch_session_pty(
    app: tauri::AppHandle,
    session_id: &str,
    workspace_override: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<CursorPtySpawnResult, String> {
    struct PtyCursorTerminalLauncher {
        app: tauri::AppHandle,
        cols: u16,
        rows: u16,
        pty_id: std::sync::Mutex<Option<String>>,
    }

    impl CursorTerminalLauncher for PtyCursorTerminalLauncher {
        fn launch(&self, launcher_path: &Path, workspace: &Path) -> Result<(), String> {
            let pty_id = crate::session_manager::pty::spawn_executable(
                self.app.clone(),
                launcher_path,
                Some(workspace),
                self.cols,
                self.rows,
            )?;
            *self
                .pty_id
                .lock()
                .map_err(|_| "PTY id lock poisoned".to_string())? = Some(pty_id);
            Ok(())
        }
    }

    let launcher = PtyCursorTerminalLauncher {
        app,
        cols,
        rows,
        pty_id: std::sync::Mutex::new(None),
    };
    let result = launch_resume_with(
        &SystemCursorSessionLookup,
        &SystemCursorCommandRunner,
        &launcher,
        &crate::settings::get_cursor_official_settings(),
        &std::env::temp_dir(),
        session_id,
        workspace_override,
        false,
    )?;
    match result {
        CursorLaunchResult::Launched => {
            let pty_id = launcher
                .pty_id
                .lock()
                .map_err(|_| "PTY id lock poisoned".to_string())?
                .clone()
                .ok_or_else(|| "Cursor PTY launched without pty id".to_string())?;
            Ok(CursorPtySpawnResult::Launched { pty_id })
        }
        CursorLaunchResult::WorkspaceRequired => Ok(CursorPtySpawnResult::WorkspaceRequired),
        CursorLaunchResult::Focused { app } => Ok(CursorPtySpawnResult::Focused { app }),
        CursorLaunchResult::Occupied { holder } => Ok(CursorPtySpawnResult::Occupied { holder }),
    }
}

pub fn launch_login() -> Result<CursorLaunchResult, String> {
    launch_login_with(
        &SystemCursorCommandRunner,
        &SystemCursorTerminalLauncher,
        &crate::settings::get_cursor_official_settings(),
        &std::env::temp_dir(),
    )
}

pub fn launch_login_and_session(
    session_id: &str,
    workspace_override: Option<&str>,
) -> Result<CursorLaunchResult, String> {
    launch_resume_with(
        &SystemCursorSessionLookup,
        &SystemCursorCommandRunner,
        &SystemCursorTerminalLauncher,
        &crate::settings::get_cursor_official_settings(),
        &std::env::temp_dir(),
        session_id,
        workspace_override,
        true,
    )
}

fn effective_command_path(executable: &Path) -> Option<std::ffi::OsString> {
    let mut paths = Vec::new();
    if let Some(parent) = executable.parent() {
        paths.push(parent.to_path_buf());
    }
    if let Some(inherited) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&inherited) {
            if path.is_absolute() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    std::env::join_paths(paths).ok()
}

#[cfg(target_os = "windows")]
fn agent_candidate_names() -> &'static [&'static str] {
    &["agent.exe", "agent.cmd", "agent.bat", "agent"]
}

#[cfg(not(target_os = "windows"))]
fn agent_candidate_names() -> &'static [&'static str] {
    &["agent"]
}

fn is_runnable_candidate(path: &Path) -> bool {
    let Ok(metadata) = fs_metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn fs_metadata(path: &Path) -> std::io::Result<std::fs::Metadata> {
    std::fs::metadata(path)
}

fn resolve_agent_from_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        if !directory.is_absolute() {
            continue;
        }
        for name in agent_candidate_names() {
            let candidate = directory.join(name);
            if !is_runnable_candidate(&candidate) {
                continue;
            }
            if let Ok(canonical) = candidate.canonicalize() {
                return Some(canonical);
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn shell_flag(shell: &Path) -> &'static str {
    match shell.file_name().and_then(|name| name.to_str()) {
        Some("sh" | "dash") => "-c",
        Some("fish") => "-lc",
        _ => "-lic",
    }
}

#[cfg(not(target_os = "windows"))]
fn resolve_agent_from_login_shell() -> Result<Option<PathBuf>, String> {
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    let shell = configured
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let mut command = Command::new(&shell);
    command
        .arg(shell_flag(&shell))
        .arg("command -v agent")
        .current_dir(crate::config::get_home_dir());
    let output = run_command_bounded(&mut command, CURSOR_DISCOVERY_TIMEOUT)?;
    if !output.success {
        return Ok(None);
    }
    let Some(path) = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
    else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    if !is_runnable_candidate(&path) {
        return Ok(None);
    }
    Ok(path.canonicalize().ok())
}

fn resolve_agent_executable() -> Result<PathBuf, CursorResolveError> {
    if let Some(path) = resolve_agent_from_path() {
        return Ok(path);
    }

    #[cfg(not(target_os = "windows"))]
    match resolve_agent_from_login_shell() {
        Ok(Some(path)) => return Ok(path),
        Ok(None) => {}
        Err(error) => return Err(CursorResolveError::Other(error)),
    }

    Err(CursorResolveError::NotFound)
}

struct CapturedBytes {
    bytes: Vec<u8>,
    truncated: bool,
}

fn read_pipe_bounded<R: Read>(mut reader: R) -> CapturedBytes {
    let mut bytes = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = CURSOR_CAPTURE_MAX_BYTES.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&chunk[..retained]);
        truncated |= retained < read;
    }
    CapturedBytes { bytes, truncated }
}

fn decode_captured(captured: CapturedBytes) -> String {
    let mut decoded = String::from_utf8_lossy(&captured.bytes).into_owned();
    if captured.truncated {
        decoded.push_str("\n[output truncated]");
    }
    decoded
}

#[cfg(unix)]
fn isolate_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut std::process::Child) {
    let group = -(child.id() as libc::pid_t);
    let killed = unsafe { libc::kill(group, libc::SIGKILL) == 0 };
    if !killed {
        let _ = child.kill();
    }
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

fn remaining_until(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| "Cursor command timed out".to_string())
}

fn receive_captured_output(
    receiver: &std::sync::mpsc::Receiver<CapturedBytes>,
    deadline: Instant,
    child: &mut std::process::Child,
) -> Result<CapturedBytes, String> {
    let remaining = match remaining_until(deadline) {
        Ok(remaining) => remaining,
        Err(error) => {
            terminate_process_group(child);
            return Err(error);
        }
    };
    match receiver.recv_timeout(remaining) {
        Ok(captured) => Ok(captured),
        Err(_) => {
            terminate_process_group(child);
            Err("Cursor command output timed out".to_string())
        }
    }
}

fn run_command_bounded(
    command: &mut Command,
    timeout: Duration,
) -> Result<CursorCommandOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_process_group(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to run Cursor Agent CLI: {error}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (stdout_tx, stdout_rx) = std::sync::mpsc::channel();
    let (stderr_tx, stderr_rx) = std::sync::mpsc::channel();
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            let _ = stdout_tx.send(read_pipe_bounded(stdout));
        });
    }
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let _ = stderr_tx.send(read_pipe_bounded(stderr));
        });
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if remaining_until(deadline).is_err() {
                    terminate_process_group(&mut child);
                    let _ = child.wait();
                    return Err(format!(
                        "Cursor command timed out after {}s",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                terminate_process_group(&mut child);
                let _ = child.wait();
                return Err(format!("Failed to wait for Cursor Agent CLI: {error}"));
            }
        }
    };

    let stdout = receive_captured_output(&stdout_rx, deadline, &mut child)?;
    let stderr = receive_captured_output(&stderr_rx, deadline, &mut child)?;
    Ok(CursorCommandOutput {
        success: status.success(),
        code: status.code(),
        stdout: decode_captured(stdout),
        stderr: decode_captured(stderr),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_manager::providers::cursor::CursorSessionRecord;
    use crate::settings::{CursorOfficialAuthMode, CursorOfficialSettings};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::time::SystemTime;

    const CHAT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const FIXTURE_KEY: &str = "cursor-fixture-secret";

    struct FakeRunner {
        executable: Result<PathBuf, CursorResolveError>,
        outputs: RefCell<VecDeque<Result<CursorCommandOutput, String>>>,
        calls: RefCell<Vec<CursorCommandSpec>>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<CursorCommandOutput>) -> Self {
            Self {
                executable: Ok(PathBuf::from("/opt/cursor/bin/agent")),
                outputs: RefCell::new(outputs.into_iter().map(Ok).collect()),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl CursorCommandRunner for FakeRunner {
        fn resolve_agent(&self) -> Result<PathBuf, CursorResolveError> {
            self.executable.clone()
        }

        fn run(&self, spec: &CursorCommandSpec) -> Result<CursorCommandOutput, String> {
            self.calls.borrow_mut().push(spec.clone());
            self.outputs
                .borrow_mut()
                .pop_front()
                .expect("fake output for every command")
        }
    }

    fn success(stdout: &str) -> CursorCommandOutput {
        CursorCommandOutput {
            success: true,
            code: Some(0),
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }

    fn cursor_record(cwd: Option<&Path>) -> CursorSessionRecord {
        CursorSessionRecord {
            chat_id: CHAT_ID.to_string(),
            title: Some("Resume this work".to_string()),
            cwd: cwd.map(|path| path.to_string_lossy().into_owned()),
            created_at_ms: Some(10),
            updated_at_ms: Some(20),
            metadata_path: PathBuf::from("/private/cursor/meta.json"),
        }
    }

    struct FakeSessionLookup {
        records: RefCell<VecDeque<CursorSessionRecord>>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeSessionLookup {
        fn new(records: Vec<CursorSessionRecord>) -> Self {
            Self {
                records: RefCell::new(records.into()),
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl CursorSessionLookup for FakeSessionLookup {
        fn find_session(&self, session_id: &str) -> Result<CursorSessionRecord, String> {
            self.calls.borrow_mut().push(session_id.to_string());
            self.records
                .borrow_mut()
                .pop_front()
                .ok_or_else(|| "missing fake Cursor session".to_string())
        }
    }

    struct RecordingTerminal {
        result: Result<(), String>,
        calls: RefCell<Vec<(PathBuf, PathBuf)>>,
    }

    impl CursorTerminalLauncher for RecordingTerminal {
        fn launch(&self, launcher_path: &Path, workspace: &Path) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push((launcher_path.to_path_buf(), workspace.to_path_buf()));
            self.result.clone()
        }
    }

    #[cfg(unix)]
    fn write_fake_agent(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn us002_resolves_workspace_and_builds_fixed_resume_argv() {
        let temp = tempfile::tempdir().unwrap();
        let metadata_workspace = temp.path().join("metadata workspace");
        let override_workspace = temp.path().join("override workspace");
        std::fs::create_dir_all(&metadata_workspace).unwrap();
        std::fs::create_dir_all(&override_workspace).unwrap();
        let canonical_metadata = metadata_workspace.canonicalize().unwrap();
        let canonical_override = override_workspace.canonicalize().unwrap();

        let resolved = resolve_workspace(
            &cursor_record(Some(&metadata_workspace)),
            Some(override_workspace.to_string_lossy().as_ref()),
            MissingWorkspaceOverridePolicy::Reject,
        )
        .unwrap();
        assert_eq!(resolved.as_deref(), Some(canonical_metadata.as_path()));

        let resolved_override = resolve_workspace(
            &cursor_record(None),
            Some(override_workspace.to_string_lossy().as_ref()),
            MissingWorkspaceOverridePolicy::Reject,
        )
        .unwrap()
        .expect("valid override should resolve");
        assert_eq!(resolved_override, canonical_override);

        assert_eq!(
            resume_argv(&resolved_override, CHAT_ID),
            vec![
                "--workspace".to_string(),
                resolved_override.to_string_lossy().into_owned(),
                "--resume".to_string(),
                CHAT_ID.to_string(),
            ]
        );
    }

    #[test]
    fn us002_rejects_invalid_workspace_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("not-a-workspace.txt");
        std::fs::write(&file, b"not a directory").unwrap();
        let missing = temp.path().join("missing-workspace");

        assert_eq!(
            resolve_workspace(
                &cursor_record(None),
                None,
                MissingWorkspaceOverridePolicy::Reject,
            )
            .unwrap(),
            None
        );
        let missing_lookup = FakeSessionLookup::new(vec![cursor_record(None)]);
        let missing_error = get_resume_context_with_lookup(
            &missing_lookup,
            CHAT_ID,
            Some(missing.to_string_lossy().as_ref()),
        )
        .unwrap_err();
        assert!(missing_error.contains("existing directory"));

        let blank_lookup = FakeSessionLookup::new(vec![cursor_record(None)]);
        let blank_error =
            get_resume_context_with_lookup(&blank_lookup, CHAT_ID, Some("   ")).unwrap_err();
        assert!(blank_error.contains("existing directory"));

        let error = resolve_workspace(
            &cursor_record(None),
            Some(file.to_string_lossy().as_ref()),
            MissingWorkspaceOverridePolicy::Reject,
        )
        .unwrap_err();
        assert!(error.contains("directory"));
    }

    #[cfg(unix)]
    #[test]
    fn us002_private_launcher_self_deletes_and_never_exposes_key() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("project dir with ' quote");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let report = temp.path().join("agent-report.txt");
        let agent = temp.path().join("agent fixture");
        write_fake_agent(
            &agent,
            r#"#!/bin/sh
{
  printf '%s\n' "$#"
  for arg in "$@"; do printf '%s\n' "$arg"; done
  if [ "$CURSOR_API_KEY" = "cursor-fixture-secret" ]; then printf '%s\n' key-present; fi
  if [ -z "$CURSOR_API_ENDPOINT" ] && [ -z "$CURSOR_LOCAL_AGENT_BASE_URL" ] && [ -z "$CURSOR_LOCAL_AGENT_API_KEY" ] && [ -z "$ANTHROPIC_BASE_URL" ] && [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then printf '%s\n' official-env-clean; fi
  if [ ! -e "$CURSOR_TEST_LAUNCHER" ] && [ ! -d "$CURSOR_TEST_LAUNCHER_DIR" ]; then printf '%s\n' launcher-gone; fi
} > "$CURSOR_TEST_REPORT"
"#,
        );
        let agent = agent.canonicalize().unwrap();
        let spec = CursorLauncherSpec {
            executable: agent,
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some(FIXTURE_KEY.to_string()),
            action: CursorLauncherAction::Resume {
                workspace: workspace.clone(),
                chat_id: CHAT_ID.to_string(),
            },
        };

        let prepared = create_launcher_in(temp.path(), &spec).unwrap();
        assert_eq!(
            prepared.directory.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            prepared.path.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
        let terminal_command =
            crate::session_manager::terminal::cursor_launcher_command(&prepared.path).unwrap();
        assert_eq!(
            terminal_command,
            crate::session_manager::terminal::shell_escape(
                prepared.path.to_string_lossy().as_ref()
            )
        );
        assert!(!terminal_command.contains(FIXTURE_KEY));
        assert!(!format!("{spec:?}").contains(FIXTURE_KEY));
        assert!(!format!("{prepared:?}").contains(FIXTURE_KEY));

        let output = Command::new(&prepared.path)
            .env("CURSOR_TEST_REPORT", &report)
            .env("CURSOR_TEST_LAUNCHER", &prepared.path)
            .env("CURSOR_TEST_LAUNCHER_DIR", &prepared.directory)
            .env("CURSOR_API_ENDPOINT", "https://third-party.invalid")
            .env("CURSOR_LOCAL_AGENT_BASE_URL", "http://localhost.invalid")
            .env("CURSOR_LOCAL_AGENT_API_KEY", "local-secret")
            .env("ANTHROPIC_BASE_URL", "https://anthropic-proxy.invalid")
            .env("ANTHROPIC_AUTH_TOKEN", "anthropic-secret")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(!prepared.path.exists());
        assert!(!prepared.directory.exists());
        assert!(!String::from_utf8_lossy(&output.stdout).contains(FIXTURE_KEY));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(FIXTURE_KEY));
        assert_eq!(
            std::fs::read_to_string(&report).unwrap(),
            format!(
                "4\n--workspace\n{}\n--resume\n{}\nkey-present\nofficial-env-clean\nlauncher-gone\n",
                workspace.to_string_lossy(),
                CHAT_ID
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn login_and_resume_runs_resume_only_after_successful_login() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = workspace.canonicalize().unwrap();
        let report = temp.path().join("login-report.txt");
        let agent = temp.path().join("login-agent");
        write_fake_agent(
            &agent,
            r#"#!/bin/sh
printf '%s\n' "$*" >> "$CURSOR_TEST_REPORT"
if [ "$1" = "login" ]; then exit "${CURSOR_TEST_LOGIN_EXIT:-0}"; fi
"#,
        );
        let spec = CursorLauncherSpec {
            executable: agent.canonicalize().unwrap(),
            auth_mode: CursorOfficialAuthMode::Login,
            user_api_key: Some(FIXTURE_KEY.to_string()),
            action: CursorLauncherAction::LoginAndResume {
                workspace: workspace.clone(),
                chat_id: CHAT_ID.to_string(),
            },
        };

        let success_launcher = create_launcher_in(temp.path(), &spec).unwrap();
        let success = Command::new(&success_launcher.path)
            .env("CURSOR_TEST_REPORT", &report)
            .output()
            .unwrap();
        assert!(success.status.success());
        assert_eq!(
            std::fs::read_to_string(&report).unwrap(),
            format!(
                "login\n--workspace {} --resume {}\n",
                workspace.display(),
                CHAT_ID
            )
        );

        std::fs::write(&report, b"").unwrap();
        let failed_launcher = create_launcher_in(temp.path(), &spec).unwrap();
        let failed = Command::new(&failed_launcher.path)
            .env("CURSOR_TEST_REPORT", &report)
            .env("CURSOR_TEST_LOGIN_EXIT", "17")
            .output()
            .unwrap();
        assert_eq!(failed.status.code(), Some(17));
        assert_eq!(std::fs::read_to_string(&report).unwrap(), "login\n");
    }

    #[cfg(unix)]
    #[test]
    fn stale_cleanup_only_removes_expired_owned_launcher_directories() {
        use std::fs::FileTimes;

        let temp = tempfile::tempdir().unwrap();
        let spec = CursorLauncherSpec {
            executable: PathBuf::from("/opt/cursor/bin/agent"),
            auth_mode: CursorOfficialAuthMode::Login,
            user_api_key: None,
            action: CursorLauncherAction::Login,
        };
        let old_owned = create_launcher_in(temp.path(), &spec).unwrap();
        let fresh_owned = create_launcher_in(temp.path(), &spec).unwrap();
        let old_foreign = temp.path().join("foreign-launcher-old");
        std::fs::create_dir(&old_foreign).unwrap();
        std::fs::write(old_foreign.join("payload"), b"fixture").unwrap();
        let now = SystemTime::now();
        let expired = now - CURSOR_LAUNCHER_MAX_AGE - Duration::from_secs(1);
        std::fs::File::open(&old_owned.directory)
            .unwrap()
            .set_times(FileTimes::new().set_modified(expired))
            .unwrap();
        std::fs::File::open(&old_foreign)
            .unwrap()
            .set_times(FileTimes::new().set_modified(expired))
            .unwrap();

        cleanup_stale_launchers_in_at(temp.path(), now).unwrap();

        assert!(!old_owned.directory.exists());
        assert!(fresh_owned.directory.exists());
        assert!(old_foreign.exists());
    }

    #[cfg(unix)]
    #[test]
    fn stale_cleanup_preserves_spoofed_or_extended_same_prefix_directories() {
        use std::fs::FileTimes;
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let spec = CursorLauncherSpec {
            executable: PathBuf::from("/opt/cursor/bin/agent"),
            auth_mode: CursorOfficialAuthMode::Login,
            user_api_key: None,
            action: CursorLauncherAction::Login,
        };
        let extended_owned = create_launcher_in(temp.path(), &spec).unwrap();
        let unknown_file = extended_owned.directory.join("keep-me.txt");
        std::fs::write(&unknown_file, b"user-owned").unwrap();

        let spoofed = temp.path().join(format!("{CURSOR_LAUNCHER_PREFIX}spoofed"));
        std::fs::create_dir(&spoofed).unwrap();
        let spoofed_launcher = spoofed.join(CURSOR_LAUNCHER_FILE_NAME);
        std::fs::write(&spoofed_launcher, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&spoofed, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&spoofed_launcher, std::fs::Permissions::from_mode(0o700))
            .unwrap();

        let now = SystemTime::now();
        let expired = now - CURSOR_LAUNCHER_MAX_AGE - Duration::from_secs(1);
        for directory in [&extended_owned.directory, &spoofed] {
            std::fs::File::open(directory)
                .unwrap()
                .set_times(FileTimes::new().set_modified(expired))
                .unwrap();
        }

        cleanup_stale_launchers_in_at(temp.path(), now).unwrap();

        assert!(extended_owned.path.exists());
        assert!(unknown_file.exists());
        assert!(spoofed_launcher.exists());
    }

    #[cfg(unix)]
    #[test]
    fn us002_revalidates_workspace_and_cleans_failed_launch() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let lookup = FakeSessionLookup::new(vec![cursor_record(None), cursor_record(None)]);
        let workspace_override = workspace.to_string_lossy().into_owned();
        let ready =
            get_resume_context_with_lookup(&lookup, CHAT_ID, Some(&workspace_override)).unwrap();
        assert!(matches!(ready, CursorResumeContext::Ready { .. }));
        std::fs::remove_dir(&workspace).unwrap();

        let agent = temp.path().join("agent");
        write_fake_agent(&agent, "#!/bin/sh\nexit 0\n");
        let runner = FakeRunner {
            executable: Ok(agent.canonicalize().unwrap()),
            outputs: RefCell::new(VecDeque::new()),
            calls: RefCell::new(Vec::new()),
        };
        let terminal = RecordingTerminal {
            result: Ok(()),
            calls: RefCell::new(Vec::new()),
        };
        let result = launch_resume_with(
            &lookup,
            &runner,
            &terminal,
            &CursorOfficialSettings::default(),
            temp.path(),
            CHAT_ID,
            Some(&workspace_override),
            false,
        )
        .unwrap();
        assert_eq!(result, CursorLaunchResult::WorkspaceRequired);
        assert_eq!(lookup.calls.borrow().len(), 2);
        assert!(terminal.calls.borrow().is_empty());

        let workspace = temp.path().join("workspace-again");
        std::fs::create_dir_all(&workspace).unwrap();
        let failing_lookup = FakeSessionLookup::new(vec![cursor_record(Some(&workspace))]);
        let failing_terminal = RecordingTerminal {
            result: Err(format!("terminal failed with {FIXTURE_KEY}")),
            calls: RefCell::new(Vec::new()),
        };
        let settings = CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some(FIXTURE_KEY.to_string()),
        };
        let error = launch_resume_with(
            &failing_lookup,
            &runner,
            &failing_terminal,
            &settings,
            temp.path(),
            CHAT_ID,
            None,
            false,
        )
        .unwrap_err();
        assert!(!error.contains(FIXTURE_KEY));
        assert!(error.contains("[REDACTED]"));
        let (launcher_path, _) = &failing_terminal.calls.borrow()[0];
        assert!(!launcher_path.exists());
        assert!(!launcher_path.parent().unwrap().exists());
    }

    #[test]
    fn us003_official_env_isolates_login_and_user_api_key_modes() {
        let login = official_env(CursorOfficialAuthMode::Login, None);
        for name in [
            "CURSOR_API_ENDPOINT",
            "CURSOR_LOCAL_AGENT_BASE_URL",
            "CURSOR_LOCAL_AGENT_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "CURSOR_API_KEY",
        ] {
            assert!(login.remove.contains(name), "Login must remove {name}");
        }
        assert!(login.set.is_empty());

        let api_key = official_env(CursorOfficialAuthMode::UserApiKey, Some(FIXTURE_KEY));
        assert_eq!(
            api_key.set.get("CURSOR_API_KEY").map(String::as_str),
            Some(FIXTURE_KEY)
        );
        for name in [
            "CURSOR_API_ENDPOINT",
            "CURSOR_LOCAL_AGENT_BASE_URL",
            "CURSOR_LOCAL_AGENT_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
        ] {
            assert!(api_key.remove.contains(name), "API Key must remove {name}");
        }
        assert!(!build_status_args()
            .iter()
            .any(|argument| argument.contains(FIXTURE_KEY)));
    }

    #[test]
    fn status_probe_runs_version_then_status_and_returns_safe_account_fields() {
        let runner = FakeRunner::new(vec![
            success("2026.08.25-3e8eec8\n"),
            success(
                r#"{"hasAccessToken":true,"hasRefreshToken":true,"isAuthenticated":true,"status":"authenticated","userInfo":{"createdAt":"2026-01-01","email":"person@example.com","firstName":"Ada","lastName":"Lovelace","userId":"private-user-id"}}"#,
            ),
        ]);
        let settings = CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some(FIXTURE_KEY.to_string()),
        };

        let status = get_status_with_runner(&runner, &settings);

        assert_eq!(status.state, CursorOfficialRuntimeState::Ready);
        assert_eq!(status.version.as_deref(), Some("2026.08.25-3e8eec8"));
        assert_eq!(
            status.account.as_ref().and_then(|a| a.email.as_deref()),
            Some("person@example.com")
        );
        assert_eq!(
            runner
                .calls
                .borrow()
                .iter()
                .map(|call| call.args.clone())
                .collect::<Vec<_>>(),
            vec![build_version_args(), build_status_args()]
        );
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(FIXTURE_KEY));
        assert!(!serialized.contains("private-user-id"));
        assert!(!serialized.contains("hasAccessToken"));
        assert!(!serialized.contains("hasRefreshToken"));
    }

    #[test]
    fn user_api_key_mode_without_a_key_skips_status_and_requests_a_key() {
        let runner = FakeRunner::new(vec![success("agent 1.0\n")]);
        let settings = CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: None,
        };

        let status = get_status_with_runner(&runner, &settings);

        assert_eq!(status.state, CursorOfficialRuntimeState::NeedsApiKey);
        assert!(!status.authenticated);
        assert_eq!(runner.calls.borrow().len(), 1);
    }

    #[test]
    fn blank_legacy_user_api_key_is_treated_as_missing() {
        let runner = FakeRunner::new(vec![success("agent 1.0\n")]);
        let settings = CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some("   ".to_string()),
        };

        let status = get_status_with_runner(&runner, &settings);

        assert_eq!(status.state, CursorOfficialRuntimeState::NeedsApiKey);
        assert!(!status.has_user_api_key);
        assert_eq!(runner.calls.borrow().len(), 1);
    }

    #[test]
    fn unauthenticated_login_uses_login_remediation() {
        let runner = FakeRunner::new(vec![
            success("agent 1.0\n"),
            success(r#"{"isAuthenticated":false,"status":"not_authenticated"}"#),
        ]);

        let status = get_status_with_runner(
            &runner,
            &CursorOfficialSettings {
                auth_mode: CursorOfficialAuthMode::Login,
                user_api_key: Some(FIXTURE_KEY.to_string()),
            },
        );

        assert_eq!(status.state, CursorOfficialRuntimeState::NeedsLogin);
        assert!(!status.authenticated);
        assert!(runner.calls.borrow()[1]
            .env
            .remove
            .contains("CURSOR_API_KEY"));
        assert!(runner.calls.borrow()[1].env.set.is_empty());
    }

    #[test]
    fn malformed_status_json_is_status_unavailable() {
        let runner = FakeRunner::new(vec![success("agent 1.0\n"), success("not-json")]);

        let status = get_status_with_runner(&runner, &CursorOfficialSettings::default());

        assert_eq!(status.state, CursorOfficialRuntimeState::StatusUnavailable);
        assert!(status
            .error
            .as_deref()
            .is_some_and(|error| error.contains("JSON")));
    }

    #[test]
    fn missing_executable_is_cli_missing_without_running_commands() {
        let runner = FakeRunner {
            executable: Err(CursorResolveError::NotFound),
            outputs: RefCell::new(VecDeque::new()),
            calls: RefCell::new(Vec::new()),
        };

        let status = get_status_with_runner(&runner, &CursorOfficialSettings::default());

        assert_eq!(status.state, CursorOfficialRuntimeState::CliMissing);
        assert!(!status.installed);
        assert!(runner.calls.borrow().is_empty());
    }

    #[test]
    fn us003_status_dto_redacts_credentials_and_errors() {
        let parsed = parse_status_json(
            r#"{"isAuthenticated":true,"userInfo":{"email":"person@example.com","firstName":"Ada","lastName":"Lovelace","userId":"private-user-id"}}"#,
        )
        .expect("valid status schema");
        assert!(parsed.authenticated);
        assert_eq!(
            parsed.account.and_then(|account| account.first_name),
            Some("Ada".to_string())
        );

        let raw_error = format!(
            "authentication failed for {FIXTURE_KEY} {}",
            "x".repeat(500)
        );
        let sanitized = sanitize_cursor_error(&raw_error, &[FIXTURE_KEY.to_string()]);
        assert!(!sanitized.contains(FIXTURE_KEY));
        assert!(sanitized.contains("[REDACTED]"));
        assert!(sanitized.chars().count() <= CURSOR_ERROR_MAX_CHARS + 3);

        let runner = FakeRunner {
            executable: Ok(PathBuf::from("/opt/cursor/bin/agent")),
            outputs: RefCell::new(
                vec![
                    Ok(success("agent 1.0\n")),
                    Ok(CursorCommandOutput {
                        success: false,
                        code: Some(1),
                        stdout: String::new(),
                        stderr: raw_error,
                    }),
                ]
                .into_iter()
                .collect(),
            ),
            calls: RefCell::new(Vec::new()),
        };
        let status = get_status_with_runner(
            &runner,
            &CursorOfficialSettings {
                auth_mode: CursorOfficialAuthMode::UserApiKey,
                user_api_key: Some(FIXTURE_KEY.to_string()),
            },
        );
        assert_eq!(status.state, CursorOfficialRuntimeState::NeedsApiKey);
        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(FIXTURE_KEY));
        assert!(!format!("{status:?}").contains(FIXTURE_KEY));
    }

    #[test]
    fn us003_status_dto_sanitizes_every_command_derived_display_field() {
        const MAX_ACCOUNT_FIELD_CHARS: usize = 160;

        let long_name = format!("Ada\n{FIXTURE_KEY} {}", "x".repeat(300));
        let status_json = serde_json::json!({
            "isAuthenticated": true,
            "userInfo": {
                "email": format!("person+{FIXTURE_KEY}@example.com"),
                "firstName": long_name,
                "lastName": format!("Lovelace {FIXTURE_KEY}")
            }
        })
        .to_string();
        let version = format!("agent {FIXTURE_KEY} {}\n", "v".repeat(300));
        let runner = FakeRunner::new(vec![success(&version), success(&status_json)]);
        let settings = CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some(FIXTURE_KEY.to_string()),
        };

        let status = get_status_with_runner(&runner, &settings);

        let serialized = serde_json::to_string(&status).unwrap();
        assert!(!serialized.contains(FIXTURE_KEY));
        assert!(status
            .version
            .as_deref()
            .is_some_and(|value| value.chars().count() <= CURSOR_VERSION_MAX_CHARS + 3));
        let account = status.account.expect("sanitized account display fields");
        for value in [account.email, account.first_name, account.last_name]
            .into_iter()
            .flatten()
        {
            assert!(value.chars().count() <= MAX_ACCOUNT_FIELD_CHARS + 3);
            assert!(!value.contains(['\n', '\r']));
        }
    }

    #[cfg(unix)]
    #[test]
    fn bounded_runner_kills_descendants_that_hold_output_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("descendant-survived");
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "(sleep 0.2; : > \"$CURSOR_TEST_MARKER\") &"])
            .env("CURSOR_TEST_MARKER", &marker);

        let result = run_command_bounded(&mut command, Duration::from_millis(50));

        assert!(result.is_err());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!marker.exists(), "timed-out descendant must be terminated");
    }

    #[test]
    fn live_writer_results_reuse_the_shared_resume_decision() {
        assert_eq!(
            cursor_launch_result_from_resume(ResumeLaunchResult::Focused {
                app: "iTerm".to_string(),
            }),
            CursorLaunchResult::Focused {
                app: "iTerm".to_string(),
            }
        );
        assert_eq!(
            cursor_launch_result_from_resume(ResumeLaunchResult::Occupied {
                holder: "CodeG".to_string(),
            }),
            CursorLaunchResult::Occupied {
                holder: "CodeG".to_string(),
            }
        );
    }
}

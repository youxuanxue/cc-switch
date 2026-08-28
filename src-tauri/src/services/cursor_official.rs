use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::settings::{CursorOfficialAuthMode, CursorOfficialSettings};

const OFFICIAL_ENV_REMOVALS: [&str; 5] = [
    "CURSOR_API_ENDPOINT",
    "CURSOR_LOCAL_AGENT_BASE_URL",
    "CURSOR_LOCAL_AGENT_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
];
const CURSOR_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const CURSOR_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const CURSOR_CAPTURE_MAX_BYTES: usize = 64 * 1024;
const CURSOR_VERSION_MAX_CHARS: usize = 120;
const CURSOR_ERROR_MAX_CHARS: usize = 240;

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
        .map(|line| bound_chars(line, CURSOR_VERSION_MAX_CHARS))
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
    CursorOfficialStatus {
        installed,
        version,
        auth_mode: settings.auth_mode,
        has_user_api_key: configured_user_api_key(settings).is_some(),
        authenticated,
        account,
        state,
        error,
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

#[allow(dead_code)]
pub fn get_status() -> CursorOfficialStatus {
    get_status_with_runner(
        &SystemCursorCommandRunner,
        &crate::settings::get_cursor_official_settings(),
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
    use crate::settings::{CursorOfficialAuthMode, CursorOfficialSettings};
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::path::PathBuf;

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
}

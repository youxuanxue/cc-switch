use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const MAX_SESSION_ID_LEN: usize = 128;
const SESSION_RUNNERS: &[&str] = &[
    "agent",
    "claude",
    "codex",
    "cursor-agent",
    "gemini",
    "grok",
    "hermes",
    "opencode",
    "pi",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriterKind {
    TerminalTui,
    OtherClient,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub command: String,
    pub tty: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriterInfo {
    pub pid: u32,
    pub command: String,
    pub tty: Option<String>,
    pub app: Option<String>,
    pub kind: WriterKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeDecision {
    LaunchNew,
    Focus { app: String, tty: Option<String> },
    Occupied { holder: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ResumeLaunchResult {
    Launched,
    Focused { app: String },
    Occupied { holder: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionResumeAppearance {
    Resume,
    Return,
    ReturnToCodeG,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeState {
    pub appearance: SessionResumeAppearance,
}

pub trait ProcessView {
    fn lock_holder_pid(&self, path: &Path) -> Option<u32>;
    fn lock_holder_pids(&self, path: &Path) -> Vec<u32> {
        self.lock_holder_pid(path).into_iter().collect()
    }
    fn process_info(&self, pid: u32) -> Option<ProcessInfo>;
    fn processes(&self) -> Vec<ProcessInfo>;
}

pub struct LiveProcessView;

impl ProcessView for LiveProcessView {
    fn lock_holder_pid(&self, lock_path: &Path) -> Option<u32> {
        self.lock_holder_pids(lock_path).into_iter().next()
    }

    fn lock_holder_pids(&self, lock_path: &Path) -> Vec<u32> {
        let Some(output) = Command::new("lsof")
            .args(["-t", "--"])
            .arg(lock_path)
            .output()
            .ok()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    }

    fn process_info(&self, pid: u32) -> Option<ProcessInfo> {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "ppid=,tty=,command="])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_ps_line(pid, &String::from_utf8_lossy(&output.stdout))
    }

    fn processes(&self) -> Vec<ProcessInfo> {
        let output = Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid=,tty=,command="])
            .output()
            .ok();
        let Some(output) = output.filter(|output| output.status.success()) else {
            return Vec::new();
        };
        parse_ps_table(&String::from_utf8_lossy(&output.stdout))
    }
}

pub fn is_safe_session_id(session_id: &str) -> bool {
    let id = session_id.trim();
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !id.contains("..")
}

pub fn writer_lock_path(config_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !is_safe_session_id(session_id) {
        return None;
    }
    Some(
        config_dir
            .join("thread-writer-locks")
            .join(format!("{}.lock", session_id.trim())),
    )
}

pub fn normalize_tty(tty: Option<&str>) -> Option<String> {
    let value = tty?.trim();
    if value.is_empty() || value == "??" || value == "-" {
        return None;
    }
    Some(value.trim_start_matches("/dev/").trim().to_string())
}

pub fn infer_app_from_command(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("codeg-server")
        || lower.contains("codeg-mcp")
        || lower.contains("/codeg")
        || lower.contains("codeg.app")
    {
        return Some("CodeG".to_string());
    }
    if lower.contains("iterm") {
        return Some("iTerm".to_string());
    }
    if lower.contains("terminal.app") || lower.contains("/utilities/terminal") {
        return Some("Terminal".to_string());
    }
    if lower.contains("ghostty") {
        return Some("Ghostty".to_string());
    }
    if lower.contains("kitty") {
        return Some("kitty".to_string());
    }
    if lower.contains("wezterm") || lower.contains("kaku") {
        return Some(if lower.contains("kaku") {
            "Kaku".to_string()
        } else {
            "WezTerm".to_string()
        });
    }
    if lower.contains("alacritty") {
        return Some("Alacritty".to_string());
    }
    if lower.contains("warp") {
        return Some("Warp".to_string());
    }
    if lower.contains("otty") {
        return Some("Otty".to_string());
    }
    None
}

pub fn command_basename(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

pub fn is_inspector_noise(command: &str) -> bool {
    // Only treat the cc-switch binary itself as noise. Matching "cc-switch"
    // anywhere would hide live agent sessions whose --workspace path contains
    // the repo name (e.g. .../Codes/cc-switch --resume <id>).
    if is_cc_switch_binary_command(command) {
        return true;
    }
    command.split_whitespace().next().is_some_and(|token| {
        matches!(
            command_basename(token),
            "ps" | "lsof"
                | "rg"
                | "grep"
                | "git"
                | "vim"
                | "nvim"
                | "less"
                | "cat"
                | "head"
                | "tail"
        )
    })
}

fn is_cc_switch_binary_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Common case: argv0 has no spaces.
    let first = trimmed.split_whitespace().next().unwrap_or("");
    if command_basename(first) == "cc-switch" {
        return true;
    }
    // macOS app bundle paths include spaces: ".../CC Switch.app/Contents/MacOS/cc-switch".
    if let Some(idx) = trimmed.find("/Contents/MacOS/cc-switch") {
        let after = &trimmed[idx + "/Contents/MacOS/cc-switch".len()..];
        return after.is_empty() || after.starts_with(char::is_whitespace);
    }
    false
}

pub fn is_session_runner_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains("app-server") {
        return true;
    }
    command.split_whitespace().any(|token| {
        let base = command_basename(token);
        SESSION_RUNNERS.contains(&base) || base.ends_with("-acp")
    })
}

pub fn command_has_session_token(command: &str, session_id: &str) -> bool {
    command
        .split_whitespace()
        .any(|token| token == session_id || token.ends_with(&format!("={session_id}")))
}

pub fn classify_writer(command: &str, tty: Option<&str>) -> WriterKind {
    let lower = command.to_ascii_lowercase();
    if lower.contains("app-server")
        || command
            .split_whitespace()
            .any(|token| command_basename(token).ends_with("-acp"))
        || lower.contains("codeg-server")
        || lower.contains("codeg-mcp")
    {
        return WriterKind::OtherClient;
    }
    if normalize_tty(tty).is_some() {
        WriterKind::TerminalTui
    } else {
        WriterKind::OtherClient
    }
}

pub fn can_focus_app(app: &str) -> bool {
    matches!(
        app,
        "iTerm"
            | "Terminal"
            | "Ghostty"
            | "kitty"
            | "WezTerm"
            | "Kaku"
            | "Alacritty"
            | "Warp"
            | "Otty"
    )
}

pub fn holder_label(info: &WriterInfo) -> String {
    if info.app.as_deref() == Some("CodeG") {
        return "CodeG".to_string();
    }
    if info.app.as_deref() == Some("CC Switch") {
        return "CC Switch".to_string();
    }
    let cmd = info.command.to_ascii_lowercase();
    if cmd.contains("app-server")
        || info
            .command
            .split_whitespace()
            .any(|token| command_basename(token).ends_with("-acp"))
    {
        return "ACP".to_string();
    }
    info.app
        .clone()
        .unwrap_or_else(|| "another process".to_string())
}

fn is_cc_switch_descendant(pid: u32, view: &dyn ProcessView) -> bool {
    let mut current = Some(pid);
    let mut seen = HashSet::new();
    while let Some(pid) = current {
        if !seen.insert(pid) {
            break;
        }
        let Some(info) = view.process_info(pid) else {
            break;
        };
        if is_cc_switch_binary_command(&info.command) {
            return true;
        }
        current = info.ppid.filter(|ppid| *ppid > 1);
    }
    false
}

fn annotate_in_app_host(writer: &mut WriterInfo, view: &dyn ProcessView) {
    if is_cc_switch_descendant(writer.pid, view) {
        writer.app = Some("CC Switch".to_string());
    }
}

fn writer_preference(writer: &WriterInfo, session_id: &str) -> (u8, u8, u8) {
    let focusable = u8::from(
        writer.kind == WriterKind::TerminalTui && writer.app.as_deref().is_some_and(can_focus_app),
    );
    let argv_match = u8::from(command_has_session_token(&writer.command, session_id));
    let external = u8::from(writer.app.as_deref() != Some("CC Switch"));
    (focusable, argv_match, external)
}

fn pick_preferred_writer(mut writers: Vec<WriterInfo>, session_id: &str) -> Option<WriterInfo> {
    if writers.is_empty() {
        return None;
    }
    writers.sort_by(|left, right| {
        writer_preference(right, session_id).cmp(&writer_preference(left, session_id))
    });
    writers.into_iter().next()
}

pub fn inspect_pid(pid: u32, view: &dyn ProcessView) -> Option<WriterInfo> {
    let info = view.process_info(pid)?;
    let command = info.command.clone();
    let mut tty = normalize_tty(info.tty.as_deref());
    let mut app = infer_app_from_command(&info.command);
    let mut ppid = info.ppid;
    let mut seen = HashSet::new();
    seen.insert(pid);

    while let Some(parent_pid) = ppid {
        if !seen.insert(parent_pid) {
            break;
        }
        let Some(parent) = view.process_info(parent_pid) else {
            break;
        };
        if app.is_none() {
            app = infer_app_from_command(&parent.command);
        }
        if tty.is_none() {
            tty = normalize_tty(parent.tty.as_deref());
        }
        ppid = parent.ppid;
        if matches!(parent.ppid, Some(0 | 1)) {
            if app.is_none() {
                app = infer_app_from_command(&parent.command);
            }
            break;
        }
    }

    Some(WriterInfo {
        pid,
        command,
        tty,
        app,
        kind: classify_writer(&info.command, info.tty.as_deref()),
    })
    .map(|mut writer| {
        annotate_in_app_host(&mut writer, view);
        writer
    })
}

fn collect_file_holder(path: &Path, view: &dyn ProcessView, pids: &mut Vec<u32>) {
    for pid in view.lock_holder_pids(path) {
        let Some(writer) = inspect_pid(pid, view) else {
            continue;
        };
        if writer.pid == std::process::id() || is_inspector_noise(&writer.command) {
            continue;
        }
        pids.push(writer.pid);
    }
}

pub fn find_live_writer(
    session_id: &str,
    source_path: Option<&Path>,
    lock_config_dir: Option<&Path>,
    view: &dyn ProcessView,
) -> Option<WriterInfo> {
    if !is_safe_session_id(session_id) {
        return None;
    }

    let self_pid = std::process::id();
    let mut pids = Vec::new();
    for proc in view.processes() {
        if proc.pid == self_pid || is_inspector_noise(&proc.command) {
            continue;
        }
        if is_session_runner_command(&proc.command)
            && command_has_session_token(&proc.command, session_id)
        {
            pids.push(proc.pid);
        }
    }
    if let Some(path) = source_path {
        collect_file_holder(path, view, &mut pids);
    }
    if let Some(lock_path) = lock_config_dir.and_then(|dir| writer_lock_path(dir, session_id)) {
        collect_file_holder(&lock_path, view, &mut pids);
    }

    pids.sort_unstable();
    pids.dedup();
    let writers = pids
        .into_iter()
        .filter_map(|pid| inspect_pid(pid, view))
        .collect::<Vec<_>>();
    pick_preferred_writer(writers, session_id)
}

pub fn decide_resume(writer: Option<&WriterInfo>) -> ResumeDecision {
    let Some(writer) = writer else {
        return ResumeDecision::LaunchNew;
    };

    if writer.kind == WriterKind::OtherClient || !writer.app.as_deref().is_some_and(can_focus_app) {
        return ResumeDecision::Occupied {
            holder: holder_label(writer),
        };
    }

    ResumeDecision::Focus {
        app: writer.app.clone().expect("can_focus_app requires app"),
        tty: writer.tty.clone(),
    }
}

pub fn focus_script(app: &str, tty: Option<&str>) -> Option<String> {
    if !can_focus_app(app) {
        return None;
    }
    let tty = tty.unwrap_or("").trim();
    if tty.contains('"') || tty.contains('\\') {
        return None;
    }

    let script = match (app, tty.is_empty()) {
        ("iTerm", false) => format!(
            r#"tell application "iTerm"
    activate
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                try
                    if (tty of s as text) contains "{tty}" then
                        select w
                        select t
                        select s
                        return "ok"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "miss"
end tell"#
        ),
        ("Terminal", false) => format!(
            r#"tell application "Terminal"
    activate
    repeat with w in windows
        repeat with t in tabs of w
            try
                if (tty of t as text) contains "{tty}" then
                    set frontmost of w to true
                    set selected of t to true
                    return "ok"
                end if
            end try
        end repeat
    end repeat
    return "miss"
end tell"#
        ),
        (app, _) => format!(r#"tell application "{app}" to activate"#),
    };
    Some(script)
}

pub fn apply_decision(decision: ResumeDecision) -> Result<ResumeLaunchResult, String> {
    match decision {
        ResumeDecision::LaunchNew => Ok(ResumeLaunchResult::Launched),
        ResumeDecision::Occupied { holder } => Ok(ResumeLaunchResult::Occupied { holder }),
        ResumeDecision::Focus { app, tty } => match focus_existing_window(&app, tty.as_deref()) {
            Ok(()) => Ok(ResumeLaunchResult::Focused { app }),
            Err(_) => Ok(ResumeLaunchResult::Occupied { holder: app }),
        },
    }
}

pub fn resume_decision_for_session(
    session_id: &str,
    source_path: Option<&Path>,
    lock_config_dir: Option<&Path>,
    view: &dyn ProcessView,
) -> ResumeDecision {
    decide_resume(find_live_writer(session_id, source_path, lock_config_dir, view).as_ref())
}

/// True when a session still has a live agent / lock holder and must not be deleted.
pub fn is_session_live(
    session_id: &str,
    source_path: Option<&Path>,
    lock_config_dir: Option<&Path>,
    view: &dyn ProcessView,
) -> bool {
    !matches!(
        resume_decision_for_session(session_id, source_path, lock_config_dir, view),
        ResumeDecision::LaunchNew
    )
}

pub fn appearance_from_decision(decision: &ResumeDecision) -> SessionResumeAppearance {
    match decision {
        ResumeDecision::LaunchNew => SessionResumeAppearance::Resume,
        ResumeDecision::Focus { .. } => SessionResumeAppearance::Return,
        ResumeDecision::Occupied { holder } if holder == "CodeG" => {
            SessionResumeAppearance::ReturnToCodeG
        }
        ResumeDecision::Occupied { .. } => SessionResumeAppearance::Return,
    }
}

pub fn resume_state_for_session(
    session_id: &str,
    source_path: Option<&Path>,
    lock_config_dir: Option<&Path>,
    view: &dyn ProcessView,
) -> SessionResumeState {
    SessionResumeState {
        appearance: appearance_from_decision(&resume_decision_for_session(
            session_id,
            source_path,
            lock_config_dir,
            view,
        )),
    }
}

fn focus_existing_window(app: &str, tty: Option<&str>) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(format!("Cannot focus {app} on this platform"));
    }
    let script = focus_script(app, tty).ok_or_else(|| format!("No focus script for {app}"))?;
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to focus {app}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to focus {app}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if script.contains("return \"miss\"") && stdout.contains("miss") {
        return Err(format!("Could not find the existing {app} tab"));
    }
    Ok(())
}

fn parse_ps_line(pid: u32, raw: &str) -> Option<ProcessInfo> {
    let line = raw.lines().find(|line| !line.trim().is_empty())?.trim();
    let mut parts = line.split_whitespace();
    let ppid = parts.next()?.parse().ok();
    let tty = normalize_tty(parts.next());
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(ProcessInfo {
        pid,
        ppid,
        command,
        tty,
    })
}

fn parse_ps_table(raw: &str) -> Vec<ProcessInfo> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok();
            let tty = normalize_tty(parts.next());
            let command = parts.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                return None;
            }
            Some(ProcessInfo {
                pid,
                ppid,
                command,
                tty,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct MapView {
        holders: HashMap<PathBuf, Vec<u32>>,
        procs: HashMap<u32, ProcessInfo>,
    }

    impl MapView {
        fn new(procs: HashMap<u32, ProcessInfo>) -> Self {
            Self {
                holders: HashMap::new(),
                procs,
            }
        }

        fn with_holder(mut self, path: PathBuf, pid: u32) -> Self {
            self.holders.entry(path).or_default().push(pid);
            self
        }
    }

    impl ProcessView for MapView {
        fn lock_holder_pid(&self, path: &Path) -> Option<u32> {
            self.lock_holder_pids(path).into_iter().next()
        }

        fn lock_holder_pids(&self, path: &Path) -> Vec<u32> {
            self.holders.get(path).cloned().unwrap_or_default()
        }

        fn process_info(&self, pid: u32) -> Option<ProcessInfo> {
            self.procs.get(&pid).cloned()
        }

        fn processes(&self) -> Vec<ProcessInfo> {
            self.procs.values().cloned().collect()
        }
    }

    fn iterm_view(pid: u32, command: &str) -> MapView {
        MapView::new(HashMap::from([
            proc(pid, 100, Some("ttys019"), command),
            proc(100, 99, Some("ttys019"), "-zsh"),
            proc(99, 1, None, "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
        ]))
    }

    fn proc(pid: u32, ppid: u32, tty: Option<&str>, command: &str) -> (u32, ProcessInfo) {
        (
            pid,
            ProcessInfo {
                pid,
                ppid: Some(ppid),
                command: command.to_string(),
                tty: tty.map(str::to_string),
            },
        )
    }

    #[test]
    fn writer_lock_path_rejects_unsafe_session_ids() {
        let root = PathBuf::from("/tmp/codex");
        assert!(writer_lock_path(&root, "../evil").is_none());
        assert!(writer_lock_path(&root, "id/with/slash").is_none());
        assert!(writer_lock_path(&root, "").is_none());
        assert_eq!(
            writer_lock_path(&root, "01a04642-3684-7963-b9cf-d0db978ce131"),
            Some(root.join("thread-writer-locks/01a04642-3684-7963-b9cf-d0db978ce131.lock"))
        );
    }

    #[test]
    fn second_resume_focuses_the_existing_iterm_tui() {
        let view = MapView::new(HashMap::from([
            proc(
                69819,
                69787,
                Some("ttys019"),
                "codex resume 01a04642-3684-7963-b9cf-d0db978ce131",
            ),
            proc(69787, 69786, Some("ttys019"), "-zsh"),
            proc(69786, 5090, Some("ttys019"), "login -fp feng"),
            proc(
                5090,
                5089,
                None,
                "/Users/feng/Library/Application Support/iTerm2/iTermServer-3.6.11",
            ),
            proc(
                5089,
                1,
                None,
                "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            ),
        ]));

        let decision = resume_decision_for_session(
            "01a04642-3684-7963-b9cf-d0db978ce131",
            None,
            Some(Path::new("/tmp/codex")),
            &view,
        );

        assert_eq!(
            decision,
            ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys019".to_string()),
            }
        );
    }

    #[test]
    fn second_resume_does_not_launch_when_codeg_holds_the_writer() {
        let session_id = "01a04642-3684-7963-b9cf-d0db978ce131";
        let lock = writer_lock_path(Path::new("/tmp/codex"), session_id).expect("lock");
        let view = MapView::new(HashMap::from([
            proc(
                80683,
                80682,
                None,
                "/opt/homebrew/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server",
            ),
            proc(
                80682,
                80681,
                None,
                "node /opt/homebrew/lib/node_modules/@agentclientprotocol/codex-acp/node_modules/@openai/codex/bin/codex.js app-server",
            ),
            proc(80681, 64435, None, "node /opt/homebrew/bin/codex-acp"),
            proc(
                64435,
                64430,
                None,
                "/Users/feng/Codes/dev/codeg-deploy-0261/src-tauri/target/release/codeg-server",
            ),
        ]))
        .with_holder(lock, 80683);

        let decision = resume_decision_for_session(
            "01a04642-3684-7963-b9cf-d0db978ce131",
            None,
            Some(Path::new("/tmp/codex")),
            &view,
        );

        assert_eq!(
            decision,
            ResumeDecision::Occupied {
                holder: "CodeG".to_string(),
            }
        );
    }

    #[test]
    fn absent_writer_still_launches_a_new_terminal() {
        let view = MapView::new(HashMap::new());

        assert_eq!(
            resume_decision_for_session("session-1", None, Some(Path::new("/tmp/codex")), &view),
            ResumeDecision::LaunchNew
        );
    }

    #[test]
    fn iterm_focus_script_targets_the_writer_tty() {
        let script = focus_script("iTerm", Some("ttys019")).expect("script");
        assert!(script.contains(r#"tell application "iTerm""#));
        assert!(script.contains("ttys019"));
        assert!(script.contains("select s"));
    }

    #[test]
    fn apply_decision_does_not_treat_occupied_as_a_launch() {
        assert_eq!(
            apply_decision(ResumeDecision::Occupied {
                holder: "CodeG".to_string(),
            })
            .expect("occupied is a successful outcome"),
            ResumeLaunchResult::Occupied {
                holder: "CodeG".to_string(),
            }
        );
        assert_eq!(
            apply_decision(ResumeDecision::LaunchNew).expect("launch"),
            ResumeLaunchResult::Launched
        );
    }

    #[test]
    fn live_terminal_button_is_return_not_resume() {
        assert_eq!(
            appearance_from_decision(&ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys019".to_string()),
            }),
            SessionResumeAppearance::Return
        );
    }

    #[test]
    fn live_codeg_button_is_return_to_codeg() {
        assert_eq!(
            appearance_from_decision(&ResumeDecision::Occupied {
                holder: "CodeG".to_string(),
            }),
            SessionResumeAppearance::ReturnToCodeG
        );
    }

    #[test]
    fn idle_session_button_is_resume() {
        assert_eq!(
            appearance_from_decision(&ResumeDecision::LaunchNew),
            SessionResumeAppearance::Resume
        );
        assert_eq!(
            resume_state_for_session("any", None, None, &MapView::new(HashMap::new())).appearance,
            SessionResumeAppearance::Resume
        );
    }

    #[test]
    fn parse_ps_line_reads_ppid_tty_and_command() {
        let info = parse_ps_line(
            69819,
            " 69787 ttys019  codex resume 01a04642-3684-7963-b9cf-d0db978ce131\n",
        )
        .expect("parse");
        assert_eq!(info.ppid, Some(69787));
        assert_eq!(info.tty.as_deref(), Some("ttys019"));
        assert_eq!(
            info.command,
            "codex resume 01a04642-3684-7963-b9cf-d0db978ce131"
        );
    }

    #[test]
    fn live_claude_tui_is_return_not_resume() {
        let view = iterm_view(42, "claude --resume ses_abc123");
        assert_eq!(
            resume_decision_for_session("ses_abc123", None, None, &view),
            ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys019".to_string()),
            }
        );
        assert_eq!(
            resume_state_for_session("ses_abc123", None, None, &view).appearance,
            SessionResumeAppearance::Return
        );
    }

    #[test]
    fn live_gemini_grok_opencode_pi_and_cursor_tui_reuse_the_same_decision() {
        for (session_id, command) in [
            ("gem-1", "gemini --resume gem-1"),
            ("grok-1", "grok --resume grok-1"),
            ("opc-1", "opencode -s opc-1"),
            ("pi-1", "pi --session pi-1"),
            (
                "11111111-1111-4111-8111-111111111111",
                "agent --workspace /tmp/app --resume 11111111-1111-4111-8111-111111111111",
            ),
            (
                "22222222-2222-4222-8222-222222222222",
                "/Users/feng/.local/bin/agent --use-system-ca /Users/feng/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/index.js --workspace /tmp --resume 22222222-2222-4222-8222-222222222222",
            ),
            (
                "33333333-3333-4333-8333-333333333333",
                "cursor-agent --resume 33333333-3333-4333-8333-333333333333",
            ),
        ] {
            let view = iterm_view(42, command);
            assert_eq!(
                resume_decision_for_session(session_id, None, None, &view),
                ResumeDecision::Focus {
                    app: "iTerm".to_string(),
                    tty: Some("ttys019".to_string()),
                },
                "{command}"
            );
        }
    }

    #[test]
    fn inspector_processes_that_mention_a_session_id_are_not_writers() {
        let view = MapView::new(HashMap::from([
            proc(9, 1, None, "cc-switch --scan ses_abc123"),
            proc(10, 1, None, "rg ses_abc123 ~/.claude"),
            proc(11, 1, None, "ps aux"),
        ]));
        assert_eq!(
            resume_decision_for_session("ses_abc123", None, None, &view),
            ResumeDecision::LaunchNew
        );
    }

    #[test]
    fn live_agent_with_cc_switch_workspace_path_is_still_detected() {
        // Regression: workspace path containing "cc-switch" must not be treated
        // as inspector noise, or in-app PTY would spawn a conflicting second resume.
        let view = iterm_view(
            42,
            "/Users/feng/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/cursor-agent --use-system-ca /Users/feng/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/index.js --workspace /Users/feng/Codes/cc-switch --resume 619f3d4a-0a40-47c9-aae6-253f7052d311",
        );
        assert_eq!(
            resume_decision_for_session("619f3d4a-0a40-47c9-aae6-253f7052d311", None, None, &view),
            ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys019".to_string()),
            }
        );
    }

    #[test]
    fn one_live_body_invariant_holds_for_every_session_runner_with_cc_switch_workspace() {
        // Product invariant: one session => at most one live body.
        // A live TUI whose argv mentions .../cc-switch must Focus, never LaunchNew.
        for (session_id, command) in [
            (
                "claude-live-1",
                "claude --resume claude-live-1 --workspace /Users/feng/Codes/cc-switch",
            ),
            (
                "01a04642-3684-7963-b9cf-d0db978ce131",
                "codex resume 01a04642-3684-7963-b9cf-d0db978ce131",
            ),
            (
                "gem-live-1",
                "gemini --resume gem-live-1",
            ),
            (
                "grok-live-1",
                "grok --resume grok-live-1",
            ),
            (
                "opc-live-1",
                "opencode -s opc-live-1",
            ),
            (
                "pi-live-1",
                "pi --session pi-live-1",
            ),
            (
                "11111111-1111-4111-8111-111111111111",
                "agent --workspace /Users/feng/Codes/cc-switch --resume 11111111-1111-4111-8111-111111111111",
            ),
            (
                "22222222-2222-4222-8222-222222222222",
                "/Users/feng/.local/bin/agent --use-system-ca /tmp/index.js --workspace /Users/feng/Codes/cc-switch --resume 22222222-2222-4222-8222-222222222222",
            ),
            (
                "33333333-3333-4333-8333-333333333333",
                "cursor-agent --workspace /Users/feng/Codes/cc-switch --resume 33333333-3333-4333-8333-333333333333",
            ),
        ] {
            let view = iterm_view(42, command);
            assert_eq!(
                resume_decision_for_session(session_id, None, None, &view),
                ResumeDecision::Focus {
                    app: "iTerm".to_string(),
                    tty: Some("ttys019".to_string()),
                },
                "runner command must stay Focus (one live body): {command}"
            );
        }
    }

    #[test]
    fn is_inspector_noise_only_matches_cc_switch_binary_basename() {
        assert!(is_inspector_noise("cc-switch --scan ses_abc"));
        assert!(is_inspector_noise(
            "/Applications/CC Switch.app/Contents/MacOS/cc-switch"
        ));
        assert!(!is_inspector_noise(
            "agent --workspace /Users/feng/Codes/cc-switch --resume abc"
        ));
        assert!(!is_inspector_noise(
            "claude --resume abc --add-dir /tmp/cc-switch-notes"
        ));
    }

    #[test]
    fn source_path_holder_without_argv_token_is_still_occupied() {
        let source = PathBuf::from("/tmp/claude/projects/ses_abc123.jsonl");
        let view = MapView::new(HashMap::from([
            proc(77, 76, None, "node /opt/homebrew/bin/claude-acp"),
            proc(
                76,
                1,
                None,
                "/Users/feng/Codes/dev/codeg-deploy-0261/src-tauri/target/release/codeg-server",
            ),
        ]))
        .with_holder(source.clone(), 77);

        assert_eq!(
            resume_decision_for_session("ses_abc123", Some(&source), None, &view),
            ResumeDecision::Occupied {
                holder: "CodeG".to_string(),
            }
        );
    }

    #[test]
    fn parse_ps_table_reads_pid_ppid_tty_and_command() {
        let procs = parse_ps_table(
            "  42  100 ttys019  claude --resume ses_abc123\n  10    1 ??  rg ses_abc123\n",
        );
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[0].pid, 42);
        assert_eq!(procs[0].ppid, Some(100));
        assert_eq!(procs[0].tty.as_deref(), Some("ttys019"));
        assert_eq!(procs[0].command, "claude --resume ses_abc123");
        assert_eq!(procs[1].tty, None);
    }

    #[test]
    fn prefers_external_iterm_over_cc_switch_in_app_pty_for_store_db_holders() {
        let session_id = "96213bcb-a72e-4e04-bc67-877ba1a8a1ca";
        let store = PathBuf::from(format!("/tmp/cursor/{session_id}/store.db"));
        let view = MapView::new(HashMap::from([
            proc(
                21424,
                33263,
                Some("ttys009"),
                "/Users/feng/.local/bin/agent --use-system-ca /tmp/index.js",
            ),
            proc(33263, 33262, Some("ttys009"), "-zsh"),
            proc(33262, 5090, Some("ttys009"), "login -fp feng"),
            proc(
                5090,
                5089,
                None,
                "/Users/feng/Library/Application Support/iTerm2/iTermServer-3.6.11",
            ),
            proc(
                5089,
                1,
                None,
                "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            ),
            proc(
                95952,
                20077,
                Some("ttys013"),
                "/Users/feng/.local/share/cursor-agent/versions/2026.08.31/cursor-agent --use-system-ca /tmp/index.js --workspace /tmp/sub2api --resume 96213bcb-a72e-4e04-bc67-877ba1a8a1ca",
            ),
            proc(
                20077,
                1,
                None,
                "/Applications/CC Switch.app/Contents/MacOS/cc-switch",
            ),
        ]))
        .with_holder(store.clone(), 21424)
        .with_holder(store.clone(), 95952);

        assert_eq!(
            resume_decision_for_session(session_id, Some(&store), None, &view),
            ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys009".to_string()),
            }
        );
    }

    #[test]
    fn cursor_store_db_holder_detects_live_session_without_argv_token() {
        let session_id = "619f3d4a-0a40-47c9-aae6-253f7052d311";
        let store = PathBuf::from(format!("/tmp/cursor/{session_id}/store.db"));
        let view = MapView::new(HashMap::from([
            proc(
                87066,
                87035,
                Some("ttys002"),
                "/Users/feng/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/cursor-agent --use-system-ca index.js --workspace /tmp/app",
            ),
            proc(87035, 87034, Some("ttys002"), "-zsh"),
            proc(87034, 5090, Some("ttys002"), "login -fp feng"),
            proc(
                5090,
                5089,
                None,
                "/Users/feng/Library/Application Support/iTerm2/iTermServer-3.6.11",
            ),
            proc(
                5089,
                1,
                None,
                "/Applications/iTerm.app/Contents/MacOS/iTerm2",
            ),
        ]))
        .with_holder(store.clone(), 87066);

        assert_eq!(
            resume_decision_for_session(session_id, Some(&store), None, &view),
            ResumeDecision::Focus {
                app: "iTerm".to_string(),
                tty: Some("ttys002".to_string()),
            }
        );
    }

    #[test]
    fn is_session_live_tracks_resume_decision() {
        let view = MapView::new(HashMap::from([proc(
            7,
            1,
            None,
            "claude --resume ses_abc123",
        )]));
        assert!(is_session_live("ses_abc123", None, None, &view));
        assert!(!is_session_live("other-session", None, None, &view));
    }

    #[test]
    fn is_session_live_respects_store_db_holder() {
        let session_id = "619f3d4a-0a40-47c9-aae6-253f7052d311";
        let store = PathBuf::from(format!("/tmp/{session_id}/store.db"));
        let view = MapView::new(HashMap::from([proc(
            42,
            1,
            None,
            "/Applications/iTerm.app/Contents/MacOS/iTerm2",
        )]))
        .with_holder(store.clone(), 42);
        assert!(is_session_live(session_id, Some(&store), None, &view));
    }

    #[test]
    fn reject_if_session_live_blocks_active_session() {
        use crate::session_manager::reject_if_session_live;

        let view = MapView::new(HashMap::from([proc(
            7,
            1,
            None,
            "claude --resume ses_abc123",
        )]));
        let error = reject_if_session_live(
            "claude",
            "ses_abc123",
            "/tmp/session.jsonl",
            &view,
        )
        .expect_err("active session must be rejected");
        assert!(error.contains("still active"));
        reject_if_session_live("claude", "other-session", "/tmp/session.jsonl", &view)
            .expect("idle session can be deleted");
    }

    #[test]
    fn a_codex_lock_does_not_occupy_a_claude_session() {
        let session_id = "ses_shared";
        let lock = writer_lock_path(Path::new("/tmp/codex"), session_id).expect("lock");
        let view = MapView::new(HashMap::from([
            proc(77, 76, None, "node /opt/homebrew/bin/codex-acp"),
            proc(
                76,
                1,
                None,
                "/Users/feng/Codes/dev/codeg-deploy-0261/src-tauri/target/release/codeg-server",
            ),
        ]))
        .with_holder(lock, 77);

        assert_eq!(
            resume_decision_for_session(session_id, None, None, &view),
            ResumeDecision::LaunchNew
        );
        assert_eq!(
            resume_decision_for_session(session_id, None, Some(Path::new("/tmp/codex")), &view),
            ResumeDecision::Occupied {
                holder: "CodeG".to_string(),
            }
        );
    }
}

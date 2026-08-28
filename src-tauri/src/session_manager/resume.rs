use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

const MAX_SESSION_ID_LEN: usize = 128;

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
    fn lock_holder_pid(&self, lock_path: &Path) -> Option<u32>;
    fn process_info(&self, pid: u32) -> Option<ProcessInfo>;
}

pub struct LiveProcessView;

impl ProcessView for LiveProcessView {
    fn lock_holder_pid(&self, lock_path: &Path) -> Option<u32> {
        let output = Command::new("lsof")
            .args(["-t", "--"])
            .arg(lock_path)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.trim().parse().ok())
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

pub fn classify_writer(command: &str, tty: Option<&str>) -> WriterKind {
    let lower = command.to_ascii_lowercase();
    if lower.contains("app-server")
        || lower.contains("codex-acp")
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
    let cmd = info.command.to_ascii_lowercase();
    if cmd.contains("app-server") || cmd.contains("codex-acp") {
        return "Codex ACP".to_string();
    }
    info.app
        .clone()
        .unwrap_or_else(|| "another Codex process".to_string())
}

pub fn inspect_writer(lock_path: &Path, view: &dyn ProcessView) -> Option<WriterInfo> {
    let pid = view.lock_holder_pid(lock_path)?;
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

pub fn resume_decision_for_codex_session(
    config_dir: &Path,
    session_id: &str,
    view: &dyn ProcessView,
) -> ResumeDecision {
    let Some(lock_path) = writer_lock_path(config_dir, session_id) else {
        return ResumeDecision::LaunchNew;
    };
    decide_resume(inspect_writer(&lock_path, view).as_ref())
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
    provider_id: &str,
    session_id: &str,
    config_dir: &Path,
    view: &dyn ProcessView,
) -> SessionResumeState {
    let appearance = if provider_id == "codex" {
        appearance_from_decision(&resume_decision_for_codex_session(
            config_dir, session_id, view,
        ))
    } else {
        SessionResumeAppearance::Resume
    };
    SessionResumeState { appearance }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct MapView {
        holder: Option<u32>,
        procs: HashMap<u32, ProcessInfo>,
    }

    impl ProcessView for MapView {
        fn lock_holder_pid(&self, _lock_path: &Path) -> Option<u32> {
            self.holder
        }

        fn process_info(&self, pid: u32) -> Option<ProcessInfo> {
            self.procs.get(&pid).cloned()
        }
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
        let view = MapView {
            holder: Some(69819),
            procs: HashMap::from([
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
            ]),
        };

        let decision = resume_decision_for_codex_session(
            Path::new("/tmp/codex"),
            "01a04642-3684-7963-b9cf-d0db978ce131",
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
        let view = MapView {
            holder: Some(80683),
            procs: HashMap::from([
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
            ]),
        };

        let decision = resume_decision_for_codex_session(
            Path::new("/tmp/codex"),
            "01a04642-3684-7963-b9cf-d0db978ce131",
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
        let view = MapView {
            holder: None,
            procs: HashMap::new(),
        };

        assert_eq!(
            resume_decision_for_codex_session(Path::new("/tmp/codex"), "session-1", &view),
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
            resume_state_for_session(
                "claude",
                "any",
                Path::new("/tmp/codex"),
                &MapView {
                    holder: None,
                    procs: HashMap::new(),
                }
            )
            .appearance,
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
}

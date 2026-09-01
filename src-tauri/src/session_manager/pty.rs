//! In-app PTY host for Session Manager live terminal.
//!
//! Pragmatic baseline:
//! - Real PTY with winsize / SIGWINCH via portable-pty resize
//! - Spawn new process only (never reattach an existing iTerm tty)
//! - Focus / Occupied live sessions stay on the external host

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

pub const PTY_OUTPUT_EVENT: &str = "session-pty-output";
pub const PTY_EXIT_EVENT: &str = "session-pty-exit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPtyOutputPayload {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPtyExitPayload {
    #[serde(rename = "ptyId")]
    pub pty_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum SessionPtySpawnResult {
    Launched {
        #[serde(rename = "ptyId")]
        pty_id: String,
    },
    Focused {
        app: String,
    },
    Occupied {
        holder: String,
    },
}

struct LivePty {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killed: Arc<AtomicBool>,
}

#[derive(Default)]
struct PtyRegistry {
    sessions: HashMap<String, LivePty>,
}

fn registry() -> &'static Mutex<PtyRegistry> {
    static REGISTRY: OnceLock<Mutex<PtyRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(PtyRegistry::default()))
}

fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

/// Spawn `command` inside a login-capable shell, with optional cwd.
pub fn spawn_shell_command(
    app: AppHandle,
    command: &str,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let shell = default_shell();
    let mut builder = CommandBuilder::new(&shell);
    builder.arg("-lc");
    builder.arg(command);
    if let Some(cwd) = cwd {
        let path = Path::new(cwd);
        if !path.is_dir() {
            return Err(format!("Working directory does not exist: {cwd}"));
        }
        builder.cwd(path);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    // Prefer classic Claude TUI until in-app mouse/image paste is solid.
    builder.env("CLAUDE_CODE_DISABLE_MOUSE", "1");

    spawn_builder(app, builder, cols, rows)
}

/// Spawn an executable/script path directly (used for Cursor launcher).
pub fn spawn_executable(
    app: AppHandle,
    executable: &Path,
    cwd: Option<&Path>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let mut builder = CommandBuilder::new(executable);
    if let Some(cwd) = cwd {
        if !cwd.is_dir() {
            return Err(format!(
                "Working directory does not exist: {}",
                cwd.display()
            ));
        }
        builder.cwd(cwd);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    builder.env("CLAUDE_CODE_DISABLE_MOUSE", "1");

    spawn_builder(app, builder, cols, rows)
}

fn spawn_builder(
    app: AppHandle,
    builder: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let cols = cols.max(20);
    let rows = rows.max(8);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("Failed to spawn command in PTY: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    let pty_id = Uuid::new_v4().to_string();
    let killed = Arc::new(AtomicBool::new(false));
    {
        let mut guard = registry()
            .lock()
            .map_err(|_| "PTY registry lock poisoned".to_string())?;
        guard.sessions.insert(
            pty_id.clone(),
            LivePty {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                killed: Arc::clone(&killed),
            },
        );
    }

    let output_id = pty_id.clone();
    let output_app = app.clone();
    let reader_killed = Arc::clone(&killed);
    thread::Builder::new()
        .name(format!("pty-read-{output_id}"))
        .spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                if reader_killed.load(Ordering::SeqCst) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = output_app.emit(
                            PTY_OUTPUT_EVENT,
                            SessionPtyOutputPayload {
                                pty_id: output_id.clone(),
                                data,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("Failed to start PTY reader: {e}"))?;

    let exit_id = pty_id.clone();
    let exit_app = app;
    let exit_killed = Arc::clone(&killed);
    thread::Builder::new()
        .name(format!("pty-wait-{exit_id}"))
        .spawn(move || {
            let code = loop {
                if exit_killed.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    break None;
                }
                match child.try_wait() {
                    Ok(Some(status)) => break Some(status.exit_code() as i32),
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break None,
                }
            };
            exit_killed.store(true, Ordering::SeqCst);
            let _ = exit_app.emit(
                PTY_EXIT_EVENT,
                SessionPtyExitPayload {
                    pty_id: exit_id.clone(),
                    code,
                },
            );
            if let Ok(mut guard) = registry().lock() {
                guard.sessions.remove(&exit_id);
            }
        })
        .map_err(|e| format!("Failed to start PTY waiter: {e}"))?;

    Ok(pty_id)
}

pub fn write_pty(pty_id: &str, data: &str) -> Result<(), String> {
    let guard = registry()
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    let session = guard
        .sessions
        .get(pty_id)
        .ok_or_else(|| format!("Unknown PTY session: {pty_id}"))?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "PTY writer lock poisoned".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("Failed to write to PTY: {e}"))
}

pub fn resize_pty(pty_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let cols = cols.max(20);
    let rows = rows.max(8);
    let guard = registry()
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    let session = guard
        .sessions
        .get(pty_id)
        .ok_or_else(|| format!("Unknown PTY session: {pty_id}"))?;
    let master = session
        .master
        .lock()
        .map_err(|_| "PTY master lock poisoned".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize PTY: {e}"))
}

pub fn kill_pty(pty_id: &str) -> Result<(), String> {
    let mut guard = registry()
        .lock()
        .map_err(|_| "PTY registry lock poisoned".to_string())?;
    let Some(session) = guard.sessions.remove(pty_id) else {
        return Ok(());
    };
    session.killed.store(true, Ordering::SeqCst);
    // Dropping master/writer closes the PTY; waiter thread kills the child.
    drop(session);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_result_serializes_launched_with_pty_id() {
        let json = serde_json::to_value(SessionPtySpawnResult::Launched {
            pty_id: "abc".into(),
        })
        .unwrap();
        assert_eq!(json["action"], "launched");
        assert_eq!(json["ptyId"], "abc");
    }

    #[test]
    fn kill_unknown_pty_is_ok() {
        kill_pty("missing-pty-id").expect("missing pty kill is idempotent");
    }
}

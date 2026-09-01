#![allow(non_snake_case)]

use crate::codex_config::get_codex_config_dir;
use crate::session_manager;
use crate::session_manager::pty::SessionPtySpawnResult;
use crate::session_manager::resume::{
    apply_decision, resume_decision_for_session, resume_state_for_session, LiveProcessView,
    ResumeDecision, ResumeLaunchResult, SessionResumeState,
};
use std::path::Path;
use tauri::AppHandle;

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<session_manager::SessionMeta>, String> {
    let sessions = tauri::async_runtime::spawn_blocking(session_manager::scan_sessions)
        .await
        .map_err(|e| format!("Failed to scan sessions: {e}"))?;
    Ok(sessions)
}

#[tauri::command]
pub async fn get_session_messages(
    providerId: String,
    sourcePath: String,
) -> Result<Vec<session_manager::SessionMessage>, String> {
    let provider_id = providerId.clone();
    let source_path = sourcePath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_messages(&provider_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to load session messages: {e}"))?
}

/// 在用户选定的终端里恢复一个会话。
///
/// # 安全边界：`command` 是刻意不加校验的
///
/// 本命令接受 renderer 传来的任意字符串并最终交给 shell。多份外部审计把这一点
/// 报成"IPC 任意命令执行"，这里明确记录为**已知并接受的风险**，而不是待修缺陷。
///
/// 依据是本应用把 renderer 当作可信边界。支撑这一判断的是以下事实，全部逐条
/// 核实过（2026-07）：
///
/// 1. 全库仅一处 `dangerouslySetInnerHTML`（`ProviderIcon.tsx`），其入参是图标
///    **名字**，经 `hasIcon()` 把关后从手工维护的构建期注册表取 SVG——用户与
///    深链接都只能给名字，给不了标记内容
/// 2. 前端无 `eval` / `new Function`
/// 3. `tauri.conf.json` 的 `frontendDist` 指向打包产物，webview 不加载任何远程
///    源；界面里也没有 `<iframe>` / `<webview>`
/// 4. CSP 为 `script-src 'self'`——既不允许内联脚本，也不允许外部脚本
///
/// 因此"攻击者能调用本 IPC"这一前提，成立时已意味着他能以当前用户身份执行代码；
/// 那种情况下绕道本命令并不会让他多拿到任何东西。
///
/// # 什么会推翻这个结论
///
/// 上面四条任意一条不再成立，本命令就必须改成**只接收 session / provider 标识、
/// 由后端从会话记录重建命令**。具体触发条件：
///
/// - 渲染任何来自网络或配置文件的富文本 / HTML / SVG 内容
/// - 引入 `<iframe>`、`<webview>`，或让 webview 导航到远程 origin
/// - 放宽 CSP 的 `script-src`（例如为了加载第三方脚本或统计 SDK）
/// - 引入任何在 renderer 内执行外部代码的机制
///
/// 相比之下 `cwd` 的处理**不属于**这条豁免：它是磁盘上扫来的项目路径，正常使用
/// 就可能含 `$(...)`，与 renderer 是否可信无关，因此在
/// `session_manager::terminal::shell_escape` 里做了完整的单引号转义。
#[tauri::command]
pub async fn launch_session_terminal(
    command: String,
    cwd: Option<String>,
    custom_config: Option<String>,
    sessionId: Option<String>,
    providerId: Option<String>,
    sourcePath: Option<String>,
    terminal: Option<String>,
) -> Result<ResumeLaunchResult, String> {
    let command = command.clone();
    let cwd = cwd.clone();
    let custom_config = custom_config.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();
    let provider_id = providerId.clone();
    let preferred = crate::settings::get_preferred_terminal();
    let target = session_manager::terminal::resolve_session_terminal_target(
        terminal.as_deref(),
        preferred.as_deref(),
    );

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(session_id) = session_id.as_deref() {
            let lock_dir = (provider_id.as_deref() == Some("codex")).then(get_codex_config_dir);
            let decision = resume_decision_for_session(
                session_id,
                source_path.as_deref().map(Path::new),
                lock_dir.as_deref(),
                &LiveProcessView,
            );
            if !matches!(decision, ResumeDecision::LaunchNew) {
                return apply_decision(decision);
            }
        }

        session_manager::terminal::launch_terminal(
            &target,
            &command,
            cwd.as_deref(),
            custom_config.as_deref(),
        )?;
        Ok(ResumeLaunchResult::Launched)
    })
    .await
    .map_err(|e| format!("Failed to launch terminal: {e}"))?
}

#[tauri::command]
pub async fn list_wts_workspaces(
    #[allow(non_snake_case)] projectDir: String,
) -> Result<session_manager::wts::WtsProjectContext, String> {
    let project_dir = projectDir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::wts::list_wts_workspaces(Path::new(&project_dir))
    })
    .await
    .map_err(|e| format!("Failed to list workspaces: {e}"))?
}

/// Spawn an in-app PTY for a non-Cursor session resume/new command.
///
/// Live sessions still Focus / Occupied on the external host — this never
/// reattaches an existing iTerm tty. Cursor must use `spawn_cursor_session_pty`.
#[tauri::command]
pub async fn spawn_session_pty(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    sessionId: Option<String>,
    providerId: Option<String>,
    sourcePath: Option<String>,
) -> Result<SessionPtySpawnResult, String> {
    let cols = cols.unwrap_or(100);
    let rows = rows.unwrap_or(28);

    if let Some(session_id) = sessionId.as_deref() {
        let lock_dir = (providerId.as_deref() == Some("codex")).then(get_codex_config_dir);
        let decision = resume_decision_for_session(
            session_id,
            sourcePath.as_deref().map(Path::new),
            lock_dir.as_deref(),
            &LiveProcessView,
        );
        match decision {
            ResumeDecision::LaunchNew => {}
            other => {
                return match apply_decision(other)? {
                    ResumeLaunchResult::Focused { app } => {
                        Ok(SessionPtySpawnResult::Focused { app })
                    }
                    ResumeLaunchResult::Occupied { holder } => {
                        Ok(SessionPtySpawnResult::Occupied { holder })
                    }
                    ResumeLaunchResult::Launched => {
                        Err("Unexpected launched result without PTY spawn".to_string())
                    }
                };
            }
        }
    }

    let pty_id =
        session_manager::pty::spawn_shell_command(app, &command, cwd.as_deref(), cols, rows)?;
    Ok(SessionPtySpawnResult::Launched { pty_id })
}

#[tauri::command]
pub async fn session_pty_write(ptyId: String, data: String) -> Result<(), String> {
    session_manager::pty::write_pty(&ptyId, &data)
}

#[tauri::command]
pub async fn session_pty_resize(ptyId: String, cols: u16, rows: u16) -> Result<(), String> {
    session_manager::pty::resize_pty(&ptyId, cols, rows)
}

#[tauri::command]
pub async fn session_pty_kill(ptyId: String) -> Result<(), String> {
    session_manager::pty::kill_pty(&ptyId)
}

#[tauri::command]
pub async fn get_session_resume_state(
    providerId: String,
    sessionId: String,
    sourcePath: Option<String>,
) -> Result<SessionResumeState, String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock_dir = (provider_id.as_str() == "codex").then(get_codex_config_dir);
        Ok(resume_state_for_session(
            &session_id,
            source_path.as_deref().map(Path::new),
            lock_dir.as_deref(),
            &LiveProcessView,
        ))
    })
    .await
    .map_err(|e| format!("Failed to inspect session resume state: {e}"))?
}

#[tauri::command]
pub async fn delete_session(
    providerId: String,
    sessionId: String,
    sourcePath: String,
) -> Result<bool, String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::delete_session(&provider_id, &session_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to delete session: {e}"))?
}

#[tauri::command]
pub async fn delete_sessions(
    items: Vec<session_manager::DeleteSessionRequest>,
) -> Result<Vec<session_manager::DeleteSessionOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || session_manager::delete_sessions(&items))
        .await
        .map_err(|e| format!("Failed to delete sessions: {e}"))
}

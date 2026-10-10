#![allow(non_snake_case)]

use std::path::Path;

use tauri::ipc::{Channel, Response};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::codex_config::get_codex_config_dir;
use crate::session_manager;
use crate::session_manager::cache::chunk_ranges;
use crate::session_manager::content::{self, BlockContent};
use crate::session_manager::model::{ContentRef, ImageRef, TranscriptChunk};
use crate::session_manager::pty::SessionPtySpawnResult;
use crate::session_manager::resume::{
    apply_decision, resume_decision_for_session, resume_state_for_session, LiveProcessView,
    ResumeDecision, ResumeLaunchResult, SessionResumeState,
};

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<session_manager::SessionMeta>, String> {
    let sessions = tauri::async_runtime::spawn_blocking(session_manager::scan_sessions)
        .await
        .map_err(|e| format!("Failed to scan sessions: {e}"))?;
    Ok(sessions)
}

/// 一次性返回全部消息（兼容旧前端；「复制整段」等一次性场景也用它）。走解析缓存。
#[tauri::command]
pub async fn get_session_messages(
    providerId: String,
    sourcePath: String,
) -> Result<Vec<session_manager::SessionMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_transcript(&providerId, &sourcePath)
            .map(|loaded| loaded.transcript.messages.clone())
    })
    .await
    .map_err(|e| format!("Failed to load session messages: {e}"))?
}

/// 分块流式读取会话（§5.1，决策 D1）：依次发送 `Header` → 若干 `Messages` → `Done`。
///
/// 读取失败时先发一个 `Error` 包，再以同样的文案返回 `Err`，前端任选一处处理。
#[tauri::command]
pub async fn stream_session_messages(
    providerId: String,
    sourcePath: String,
    onChunk: Channel<TranscriptChunk>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let loaded = match session_manager::load_transcript(&providerId, &sourcePath) {
            Ok(loaded) => loaded,
            Err(message) => {
                let _ = onChunk.send(TranscriptChunk::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        };
        let transcript = loaded.transcript;
        let send = |chunk: TranscriptChunk| {
            onChunk
                .send(chunk)
                .map_err(|e| format!("Failed to send session chunk: {e}"))
        };

        send(TranscriptChunk::Header {
            total: transcript.messages.len(),
            turns: transcript.turns.clone(),
            cached: loaded.cached,
            parse_ms: loaded.parse_ms,
        })?;
        for (start, end) in chunk_ranges(&transcript.message_bytes) {
            send(TranscriptChunk::Messages {
                start,
                messages: transcript.messages[start..end].to_vec(),
            })?;
        }
        send(TranscriptChunk::Done {
            payload_bytes: transcript.approx_bytes as u64,
        })
    })
    .await
    .map_err(|e| format!("Failed to stream session messages: {e}"))?
}

/// 按 [`ContentRef`] 取工具输出 / 参数 / 思考 / diff 全文，按字符分页（默认且最多 512K 字符一页）。
#[tauri::command]
pub async fn get_session_block_content(
    providerId: String,
    sourcePath: String,
    contentRef: ContentRef,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<BlockContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = content::validate_source(&providerId, &sourcePath)?;
        let full = content::resolve_content_ref(&source, &contentRef)?;
        Ok(content::paginate(&full, offset, limit))
    })
    .await
    .map_err(|e| format!("Failed to load block content: {e}"))?
}

/// 读取会话图片的原始字节（决策 D2）；前端按 `ImageRef.mediaType` 生成 Blob URL。
#[tauri::command]
pub async fn get_session_image(
    providerId: String,
    sourcePath: String,
    image: ImageRef,
) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = content::validate_source(&providerId, &sourcePath)?;
        content::load_image(&source, &image).map(Response::new)
    })
    .await
    .map_err(|e| format!("Failed to load session image: {e}"))?
}

/// 在文件管理器中显示某个已存在的文件或目录（决策 D3）；不提供「用默认程序打开」。
#[tauri::command]
pub async fn reveal_session_path(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = content::resolve_reveal_path(&path)?;
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .map_err(|_| "无法在文件管理器中显示该路径".to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| format!("Failed to reveal path: {e}"))?
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
#[allow(clippy::too_many_arguments)]
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
pub async fn prune_session_storage(
) -> Result<session_manager::prune::SessionStoragePruneResult, String> {
    tauri::async_runtime::spawn_blocking(session_manager::prune::prune_session_storage)
        .await
        .map_err(|e| format!("Failed to prune session storage: {e}"))?
}

#[tauri::command]
pub async fn classify_stale_registered_wts_worktrees(
) -> Result<session_manager::wts::ClassifyStaleRegisteredWtsResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let sessions = session_manager::scan_sessions();
        session_manager::wts::classify_stale_registered_wts_worktrees(&sessions)
    })
    .await
    .map_err(|e| format!("Failed to classify stale registered WTS worktrees: {e}"))?
}

#[tauri::command]
pub async fn remove_stale_registered_wts_worktrees(
    paths: Vec<String>,
) -> Result<session_manager::wts::RemoveStaleRegisteredWtsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::wts::remove_stale_registered_wts_worktrees(&paths)
    })
    .await
    .map_err(|e| format!("Failed to remove stale registered WTS worktrees: {e}"))?
}

#[tauri::command]
pub async fn classify_session_live_states(
    items: Vec<session_manager::SessionLiveProbe>,
) -> Result<Vec<session_manager::SessionLiveState>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(session_manager::classify_session_live_states(
            &items,
            &LiveProcessView,
        ))
    })
    .await
    .map_err(|e| format!("Failed to classify session live states: {e}"))?
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

/// 把会话导出为 Markdown 文件：由后端弹出保存对话框并写入。写入路径只能是用户在
/// 对话框里选的位置，前端不能指定任意路径。用户取消时返回 `None`，否则返回保存路径。
#[tauri::command]
pub async fn export_session_markdown<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    #[allow(non_snake_case)] defaultName: String,
    content: String,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name(&defaultName)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("打开保存对话框失败: {e}"))?;

    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("无效的保存路径: {e}"))?;
    crate::config::write_text_file(&path, &content).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

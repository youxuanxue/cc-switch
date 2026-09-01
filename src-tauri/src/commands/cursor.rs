#![allow(non_snake_case)]

use crate::services::cursor_official::{
    self, CursorLaunchResult, CursorOfficialStatus, CursorPtySpawnResult, CursorResumeContext,
};
use crate::session_manager::providers::cursor::CursorIndexStatus;
use crate::settings::CursorOfficialAuthMode;
use tauri::AppHandle;

fn parse_cursor_auth_update(
    auth_mode: &str,
    user_api_key: Option<String>,
) -> Result<(CursorOfficialAuthMode, Option<String>), String> {
    let auth_mode = match auth_mode {
        "login" => CursorOfficialAuthMode::Login,
        "userApiKey" => CursorOfficialAuthMode::UserApiKey,
        _ => {
            return Err("Invalid Cursor auth mode; expected login or userApiKey".to_string());
        }
    };
    if user_api_key
        .as_deref()
        .is_some_and(|key| key.trim().is_empty())
    {
        return Err(
            "Cursor User API Key cannot be empty; use the explicit clear action".to_string(),
        );
    }
    Ok((auth_mode, user_api_key))
}

async fn run_cursor_blocking<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Cursor background task failed: {error}"))?
}

#[tauri::command]
pub async fn get_cursor_official_status() -> Result<CursorOfficialStatus, String> {
    run_cursor_blocking(|| Ok(cursor_official::get_status())).await
}

#[tauri::command]
pub async fn update_cursor_official_auth(
    authMode: String,
    userApiKey: Option<String>,
) -> Result<CursorOfficialStatus, String> {
    let (auth_mode, user_api_key) = parse_cursor_auth_update(&authMode, userApiKey)?;
    run_cursor_blocking(move || {
        crate::settings::update_cursor_official_settings(auth_mode, user_api_key)
            .map_err(|error| error.to_string())?;
        Ok(cursor_official::get_status())
    })
    .await
}

#[tauri::command]
pub async fn clear_cursor_user_api_key() -> Result<CursorOfficialStatus, String> {
    run_cursor_blocking(|| {
        crate::settings::clear_cursor_user_api_key().map_err(|error| error.to_string())?;
        Ok(cursor_official::get_status())
    })
    .await
}

#[tauri::command]
pub async fn get_cursor_session_index_status() -> Result<CursorIndexStatus, String> {
    run_cursor_blocking(|| Ok(crate::session_manager::providers::cursor::index_status())).await
}

#[tauri::command]
pub async fn get_cursor_session_resume_context(
    sessionId: String,
    workspaceOverride: Option<String>,
) -> Result<CursorResumeContext, String> {
    run_cursor_blocking(move || {
        cursor_official::get_resume_context(&sessionId, workspaceOverride.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn launch_cursor_session(
    sessionId: String,
    workspaceOverride: Option<String>,
) -> Result<CursorLaunchResult, String> {
    run_cursor_blocking(move || {
        cursor_official::launch_session(&sessionId, workspaceOverride.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn spawn_cursor_session_pty(
    app: AppHandle,
    sessionId: String,
    workspaceOverride: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<CursorPtySpawnResult, String> {
    let cols = cols.unwrap_or(100);
    let rows = rows.unwrap_or(28);
    run_cursor_blocking(move || {
        cursor_official::launch_session_pty(
            app,
            &sessionId,
            workspaceOverride.as_deref(),
            cols,
            rows,
        )
    })
    .await
}

#[tauri::command]
pub async fn launch_cursor_login() -> Result<CursorLaunchResult, String> {
    run_cursor_blocking(cursor_official::launch_login).await
}

#[tauri::command]
pub async fn launch_cursor_login_and_session(
    sessionId: String,
    workspaceOverride: Option<String>,
) -> Result<CursorLaunchResult, String> {
    run_cursor_blocking(move || {
        cursor_official::launch_login_and_session(&sessionId, workspaceOverride.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn us003_auth_update_rejects_unknown_mode_and_empty_key() {
        assert_eq!(
            parse_cursor_auth_update("login", None).unwrap(),
            (CursorOfficialAuthMode::Login, None)
        );
        assert_eq!(
            parse_cursor_auth_update("userApiKey", None).unwrap(),
            (CursorOfficialAuthMode::UserApiKey, None)
        );

        let unknown = parse_cursor_auth_update("tokenKey", None).unwrap_err();
        assert!(unknown.contains("login"));
        assert!(unknown.contains("userApiKey"));

        let empty = parse_cursor_auth_update("userApiKey", Some("   ".to_string())).unwrap_err();
        assert!(empty.contains("clear"));
    }

    #[test]
    fn cursor_command_results_serialize_to_structured_states() {
        assert_eq!(
            serde_json::to_value(CursorIndexStatus::IndexReady).unwrap(),
            json!({ "state": "indexReady" })
        );
        assert_eq!(
            serde_json::to_value(CursorResumeContext::Ready {
                workspace: "/workspace/app".to_string(),
            })
            .unwrap(),
            json!({ "workspaceState": "ready", "workspace": "/workspace/app" })
        );
        assert_eq!(
            serde_json::to_value(CursorResumeContext::WorkspaceRequired).unwrap(),
            json!({ "workspaceState": "workspaceRequired" })
        );
        assert_eq!(
            serde_json::to_value(CursorLaunchResult::Launched).unwrap(),
            json!({ "state": "launched" })
        );
        assert_eq!(
            serde_json::to_value(CursorLaunchResult::WorkspaceRequired).unwrap(),
            json!({ "state": "workspaceRequired" })
        );
        assert_eq!(
            serde_json::to_value(CursorLaunchResult::Focused {
                app: "iTerm".to_string(),
            })
            .unwrap(),
            json!({ "state": "focused", "app": "iTerm" })
        );
        assert_eq!(
            serde_json::to_value(CursorLaunchResult::Occupied {
                holder: "CodeG".to_string(),
            })
            .unwrap(),
            json!({ "state": "occupied", "holder": "CodeG" })
        );
    }
}

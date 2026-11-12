use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

use crate::config::get_home_dir;

#[derive(Debug, Clone, Default)]
pub struct CodegSidebarSnapshot {
    pub open_folder_paths: HashSet<PathBuf>,
    open_folder_keys_lower: HashSet<String>,
    pub closed_folder_paths: HashSet<PathBuf>,
    closed_folder_keys_lower: HashSet<String>,
    pub protected_session_ids: HashSet<String>,
}

impl CodegSidebarSnapshot {
    pub fn is_open_folder(&self, path: &Path) -> bool {
        let normalized = normalize_path_key(path);
        self.open_folder_paths.contains(&normalized)
            || self
                .open_folder_keys_lower
                .contains(&normalized.to_string_lossy().to_ascii_lowercase())
    }

    pub fn is_closed_folder(&self, path: &Path) -> bool {
        if self.is_open_folder(path) {
            return false;
        }
        let normalized = normalize_path_key(path);
        self.closed_folder_paths.contains(&normalized)
            || self
                .closed_folder_keys_lower
                .contains(&normalized.to_string_lossy().to_ascii_lowercase())
    }

    pub fn is_session_protected(&self, session_id: &str) -> bool {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return false;
        }
        if self.protected_session_ids.contains(trimmed) {
            return true;
        }
        if let Some(stripped) = trimmed.strip_prefix("session-") {
            return self.protected_session_ids.contains(stripped);
        }
        false
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegPruneResult {
    pub conversations_removed: u32,
    pub folders_removed: u32,
}

impl CodegPruneResult {
    pub fn total_removed(&self) -> u32 {
        self.conversations_removed + self.folders_removed
    }

    pub fn merge(&mut self, other: Self) {
        self.conversations_removed += other.conversations_removed;
        self.folders_removed += other.folders_removed;
    }
}

pub fn candidate_codeg_db_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(dir) = std::env::var("CODEG_DATA_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed).join("codeg.db"));
        }
    }
    paths.push(home.join("codeg").join("codeg.db"));
    paths.push(
        home.join("Library")
            .join("Application Support")
            .join("app.codeg")
            .join("codeg.db"),
    );
    paths.push(
        home.join("Library")
            .join("Application Support")
            .join("com.xintaofeng.codeg")
            .join("codeg.db"),
    );
    paths.push(
        home.join("Library")
            .join("Application Support")
            .join("codeg")
            .join("codeg.db"),
    );
    paths.push(
        home.join(".local")
            .join("share")
            .join("codeg")
            .join("codeg.db"),
    );

    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| path.is_file() && seen.insert(normalize_path_key(path)))
        .collect()
}

pub fn load_default_codeg_sidebar_snapshot() -> CodegSidebarSnapshot {
    load_codeg_sidebar_snapshot_for_home(&get_home_dir())
}

pub fn load_codeg_sidebar_snapshot_for_home(home: &Path) -> CodegSidebarSnapshot {
    let mut combined = CodegSidebarSnapshot::default();
    for db_path in candidate_codeg_db_paths(home) {
        if let Ok(snapshot) = load_codeg_sidebar_snapshot_from_db(&db_path) {
            for path in snapshot.open_folder_paths {
                combined
                    .open_folder_keys_lower
                    .insert(path.to_string_lossy().to_ascii_lowercase());
                combined.open_folder_paths.insert(path);
            }
            for path in snapshot.closed_folder_paths {
                let lower = path.to_string_lossy().to_ascii_lowercase();
                if !combined.open_folder_keys_lower.contains(&lower) {
                    combined.closed_folder_keys_lower.insert(lower);
                    combined.closed_folder_paths.insert(path);
                }
            }
            combined
                .protected_session_ids
                .extend(snapshot.protected_session_ids);
        }
    }
    let open_paths = combined.open_folder_paths.clone();
    let open_lower = combined.open_folder_keys_lower.clone();
    combined.closed_folder_paths.retain(|path| {
        !open_paths.contains(path)
            && !open_lower.contains(&path.to_string_lossy().to_ascii_lowercase())
    });
    combined
        .closed_folder_keys_lower
        .retain(|key| !combined.open_folder_keys_lower.contains(key));
    combined
}

pub fn load_codeg_sidebar_snapshot_from_db(db_path: &Path) -> Result<CodegSidebarSnapshot, String> {
    if !db_path.is_file() {
        return Ok(CodegSidebarSnapshot::default());
    }
    let conn = open_readonly(db_path)?;
    let mut snapshot = CodegSidebarSnapshot::default();

    if table_exists(&conn, "folder") {
        let mut stmt = conn
            .prepare("SELECT path, is_open, deleted_at FROM folder")
            .map_err(|err| format!("Failed to query Codeg folder table: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let is_open: bool = row.get::<_, i64>(1).unwrap_or(0) != 0;
                let deleted_at: Option<String> = row.get(2).ok().flatten();
                Ok((path, is_open, deleted_at))
            })
            .map_err(|err| format!("Failed to read Codeg folder rows: {err}"))?;

        for row in rows.flatten() {
            let (raw_path, is_open, deleted_at) = row;
            let trimmed = raw_path.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = normalize_path_key(Path::new(trimmed));
            let lower = normalized.to_string_lossy().to_ascii_lowercase();
            let is_deleted = deleted_at
                .as_deref()
                .is_some_and(|val| !val.trim().is_empty());
            if is_open && !is_deleted {
                snapshot.open_folder_keys_lower.insert(lower);
                snapshot.open_folder_paths.insert(normalized);
            } else {
                snapshot.closed_folder_keys_lower.insert(lower);
                snapshot.closed_folder_paths.insert(normalized);
            }
        }
        let open_paths = snapshot.open_folder_paths.clone();
        let open_lower = snapshot.open_folder_keys_lower.clone();
        snapshot.closed_folder_paths.retain(|path| {
            !open_paths.contains(path)
                && !open_lower.contains(&path.to_string_lossy().to_ascii_lowercase())
        });
        snapshot
            .closed_folder_keys_lower
            .retain(|key| !snapshot.open_folder_keys_lower.contains(key));
    }

    let opened_tab_ids = read_opened_conversation_ids(&conn);

    if table_exists(&conn, "conversation") {
        let query = if table_exists(&conn, "folder") {
            "SELECT c.id, c.external_id, c.status, c.pinned_at, c.deleted_at,
                    COALESCE(f.is_open, 0), f.deleted_at, COALESCE(f.kind, 'regular')
             FROM conversation c
             LEFT JOIN folder f ON c.folder_id = f.id"
        } else {
            "SELECT c.id, c.external_id, c.status, c.pinned_at, c.deleted_at,
                    1, NULL, 'regular'
             FROM conversation c"
        };

        let mut stmt = conn
            .prepare(query)
            .map_err(|err| format!("Failed to query Codeg conversation table: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let external_id: Option<String> = row.get(1).ok().flatten();
                let status: Option<String> = row.get(2).ok().flatten();
                let pinned_at: Option<String> = row.get(3).ok().flatten();
                let deleted_at: Option<String> = row.get(4).ok().flatten();
                let folder_open: bool = row.get::<_, i64>(5).unwrap_or(0) != 0;
                let folder_deleted_at: Option<String> = row.get(6).ok().flatten();
                let folder_kind: String = row
                    .get::<_, Option<String>>(7)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "regular".to_string());
                Ok((
                    id,
                    external_id,
                    status,
                    pinned_at,
                    deleted_at,
                    folder_open,
                    folder_deleted_at,
                    folder_kind,
                ))
            })
            .map_err(|err| format!("Failed to read Codeg conversation rows: {err}"))?;

        for row in rows.flatten() {
            let (
                id,
                external_id,
                status,
                pinned_at,
                deleted_at,
                folder_open,
                folder_deleted_at,
                folder_kind,
            ) = row;
            if deleted_at
                .as_deref()
                .is_some_and(|val| !val.trim().is_empty())
            {
                continue;
            }
            let Some(ext_id) = external_id
                .as_deref()
                .map(str::trim)
                .filter(|val| !val.is_empty())
            else {
                continue;
            };
            let folder_deleted = folder_deleted_at
                .as_deref()
                .is_some_and(|val| !val.trim().is_empty());
            let status_norm = status.as_deref().unwrap_or("").trim().to_ascii_lowercase();
            let is_pinned = pinned_at
                .as_deref()
                .is_some_and(|val| !val.trim().is_empty());
            let in_sidebar = (folder_open && !folder_deleted && status_norm != "completed")
                || status_norm == "in_progress"
                || is_pinned
                || folder_kind == "chat"
                || opened_tab_ids.contains(&id);

            if in_sidebar {
                insert_session_id_variants(&mut snapshot.protected_session_ids, ext_id);
            }
        }
    }

    Ok(snapshot)
}

pub fn prune_non_sidebar_codeg_state() -> Result<CodegPruneResult, String> {
    prune_non_sidebar_codeg_state_for_home(&get_home_dir())
}

pub fn prune_non_sidebar_codeg_state_for_home(home: &Path) -> Result<CodegPruneResult, String> {
    let mut total = CodegPruneResult::default();
    for db_path in candidate_codeg_db_paths(home) {
        total.merge(prune_non_sidebar_codeg_state_in(&db_path)?);
    }
    Ok(total)
}

pub fn prune_non_sidebar_codeg_state_in(db_path: &Path) -> Result<CodegPruneResult, String> {
    if !db_path.is_file() {
        return Ok(CodegPruneResult::default());
    }
    let conn = open_readwrite(db_path)?;
    if !table_exists(&conn, "folder") {
        return Ok(CodegPruneResult::default());
    }

    let opened_tab_ids = read_opened_conversation_ids(&conn);
    let credentials = read_codeg_web_credentials(&conn);

    let mut candidate_conversations: Vec<i64> = Vec::new();
    if table_exists(&conn, "conversation") {
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.status, c.pinned_at,
                        f.id, COALESCE(f.is_open, 0), f.deleted_at, COALESCE(f.kind, 'regular')
                 FROM conversation c
                 LEFT JOIN folder f ON c.folder_id = f.id
                 WHERE c.deleted_at IS NULL",
            )
            .map_err(|err| format!("Failed to query Codeg conversations for prune: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let status: Option<String> = row.get(1).ok().flatten();
                let pinned_at: Option<String> = row.get(2).ok().flatten();
                let folder_id: Option<i64> = row.get(3).ok().flatten();
                let folder_open: bool = row.get::<_, i64>(4).unwrap_or(0) != 0;
                let folder_deleted_at: Option<String> = row.get(5).ok().flatten();
                let folder_kind: String = row
                    .get::<_, Option<String>>(6)
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "regular".to_string());
                Ok((
                    id,
                    status,
                    pinned_at,
                    folder_id,
                    folder_open,
                    folder_deleted_at,
                    folder_kind,
                ))
            })
            .map_err(|err| format!("Failed to read Codeg conversations for prune: {err}"))?;

        for row in rows.flatten() {
            let (id, status, pinned_at, folder_id, folder_open, folder_deleted_at, folder_kind) =
                row;
            let status_norm = status.as_deref().unwrap_or("").trim().to_ascii_lowercase();
            let is_pinned = pinned_at
                .as_deref()
                .is_some_and(|val| !val.trim().is_empty());
            if status_norm == "in_progress"
                || is_pinned
                || folder_kind == "chat"
                || opened_tab_ids.contains(&id)
            {
                continue;
            }
            let folder_closed_or_missing = folder_id.is_none()
                || !folder_open
                || folder_deleted_at
                    .as_deref()
                    .is_some_and(|val| !val.trim().is_empty());
            if folder_closed_or_missing {
                candidate_conversations.push(id);
            }
        }
    }

    let mut candidate_folders: Vec<(i64, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, path FROM folder
                 WHERE is_open = 0 AND deleted_at IS NULL AND COALESCE(kind, 'regular') != 'chat'",
            )
            .map_err(|err| format!("Failed to query closed Codeg folders: {err}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("Failed to read closed Codeg folders: {err}"))?;
        for row in rows.flatten() {
            candidate_folders.push(row);
        }
    }

    let mut result = CodegPruneResult::default();
    let now_rfc3339 = chrono::Utc::now().to_rfc3339();

    for conv_id in candidate_conversations {
        let deleted_via_api = credentials.as_ref().is_some_and(|(port, token)| {
            post_codeg_loopback_json(
                *port,
                token,
                "/api/delete_conversation",
                &serde_json::json!({ "conversationId": conv_id }),
            )
        });
        if deleted_via_api {
            result.conversations_removed += 1;
            continue;
        }
        let changed = conn
            .execute(
                "UPDATE conversation SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                rusqlite::params![&now_rfc3339, conv_id],
            )
            .unwrap_or(0);
        if changed > 0 {
            result.conversations_removed += 1;
        }
    }

    for (folder_id, path) in candidate_folders {
        let removed_via_api = credentials.as_ref().is_some_and(|(port, token)| {
            post_codeg_loopback_json(
                *port,
                token,
                "/api/remove_folder_from_history",
                &serde_json::json!({ "path": path }),
            )
        });
        if removed_via_api {
            result.folders_removed += 1;
            continue;
        }
        let changed = conn
            .execute(
                "UPDATE folder SET deleted_at = ?1 WHERE id = ?2 AND is_open = 0 AND deleted_at IS NULL",
                rusqlite::params![&now_rfc3339, folder_id],
            )
            .unwrap_or(0);
        if changed > 0 {
            result.folders_removed += 1;
        }
    }

    Ok(result)
}

fn normalize_path_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn insert_session_id_variants(target: &mut HashSet<String>, raw_id: &str) {
    let trimmed = raw_id.trim();
    if trimmed.is_empty() {
        return;
    }
    target.insert(trimmed.to_string());
    if let Some(stripped) = trimmed.strip_prefix("session-") {
        if !stripped.is_empty() {
            target.insert(stripped.to_string());
        }
    } else {
        target.insert(format!("session-{trimmed}"));
    }
}

fn open_readonly(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("Failed to open Codeg database {}: {err}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    Ok(conn)
}

fn open_readwrite(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("Failed to open Codeg database {}: {err}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    Ok(conn)
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn read_opened_conversation_ids(conn: &Connection) -> HashSet<i64> {
    let mut ids = HashSet::new();
    if !table_exists(conn, "app_metadata") {
        return ids;
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT value FROM app_metadata
         WHERE deleted_at IS NULL AND key LIKE 'opened_conversations:%'",
    ) else {
        return ids;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return ids;
    };
    for raw in rows.flatten() {
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if let Some(active_id) = parsed.get("active_id").and_then(Value::as_i64) {
            ids.insert(active_id);
        }
        if let Some(tabs) = parsed.get("opened_tabs").and_then(Value::as_array) {
            for tab in tabs {
                if let Some(id) = tab.as_i64() {
                    ids.insert(id);
                }
            }
        }
    }
    ids
}

fn read_codeg_web_credentials(conn: &Connection) -> Option<(u16, String)> {
    let env_port = std::env::var("CODEG_PORT")
        .ok()
        .and_then(|val| val.trim().parse::<u16>().ok());
    let env_token = std::env::var("CODEG_TOKEN")
        .ok()
        .map(|val| val.trim().to_string())
        .filter(|val| !val.is_empty());

    let mut db_port: Option<u16> = None;
    let mut db_token: Option<String> = None;
    if table_exists(conn, "app_metadata") {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT key, value FROM app_metadata
             WHERE deleted_at IS NULL AND key IN ('web_service_port', 'web_service_token')",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for (key, value) in rows.flatten() {
                    match key.as_str() {
                        "web_service_port" => {
                            db_port = value.trim().parse::<u16>().ok();
                        }
                        "web_service_token" => {
                            let trimmed = value.trim().to_string();
                            if !trimmed.is_empty() {
                                db_token = Some(trimmed);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let token = env_token.or(db_token)?;
    let port = env_port.or(db_port).unwrap_or(3080);
    Some((port, token))
}

fn post_codeg_loopback_json(port: u16, token: &str, path: &str, payload: &Value) -> bool {
    let body = match serde_json::to_vec(payload) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(800);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(request.as_bytes()).is_err() || stream.write_all(&body).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response
        .lines()
        .next()
        .is_some_and(|status_line| status_line.contains(" 200 "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn seed_codeg_db(db_path: &Path) -> Connection {
        let conn = Connection::open(db_path).expect("open sqlite");
        conn.execute_batch(
            "CREATE TABLE folder (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                is_open INTEGER NOT NULL DEFAULT 1,
                deleted_at TEXT,
                kind TEXT NOT NULL DEFAULT 'regular'
            );
            CREATE TABLE conversation (
                id INTEGER PRIMARY KEY,
                folder_id INTEGER NOT NULL,
                title TEXT,
                agent_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending_review',
                external_id TEXT,
                pinned_at TEXT,
                deleted_at TEXT
            );
            CREATE TABLE app_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                deleted_at TEXT
            );",
        )
        .expect("create tables");
        conn
    }

    #[test]
    fn snapshot_protects_open_sidebar_conversations_and_tracks_closed_folders() {
        let root = tempdir().expect("tempdir");
        let open_dir = root.path().join("sub2api-main-open");
        let closed_dir = root.path().join("sub2api-main-closed");
        std::fs::create_dir_all(&open_dir).expect("open dir");
        std::fs::create_dir_all(&closed_dir).expect("closed dir");

        let db_path = root.path().join("codeg.db");
        let conn = seed_codeg_db(&db_path);
        conn.execute(
            "INSERT INTO folder (id, name, path, is_open, deleted_at, kind) VALUES
             (1, 'open-wt', ?1, 1, NULL, 'regular'),
             (2, 'closed-wt', ?2, 0, NULL, 'regular')",
            rusqlite::params![
                open_dir.to_string_lossy().to_string(),
                closed_dir.to_string_lossy().to_string()
            ],
        )
        .expect("insert folders");
        conn.execute(
            "INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, pinned_at, deleted_at) VALUES
             (10, 1, 'Sidebar Active', 'codex', 'pending_review', 'uuid-open-1', NULL, NULL),
             (11, 1, 'Sidebar Completed', 'codex', 'completed', 'uuid-completed-1', NULL, NULL),
             (12, 2, 'Closed Folder Conv', 'claude_code', 'pending_review', 'uuid-closed-1', NULL, NULL),
             (13, 2, 'Pinned Closed Conv', 'claude_code', 'pending_review', 'uuid-pinned-1', '2026-11-11T00:00:00Z', NULL)",
            [],
        )
        .expect("insert conversations");

        let snapshot = load_codeg_sidebar_snapshot_from_db(&db_path).expect("load snapshot");
        assert!(snapshot.is_open_folder(&open_dir));
        assert!(!snapshot.is_closed_folder(&open_dir));
        assert!(snapshot.is_closed_folder(&closed_dir));
        assert!(!snapshot.is_open_folder(&closed_dir));

        assert!(snapshot.is_session_protected("uuid-open-1"));
        assert!(snapshot.is_session_protected("session-uuid-open-1"));
        assert!(!snapshot.is_session_protected("uuid-completed-1"));
        assert!(!snapshot.is_session_protected("uuid-closed-1"));
        assert!(snapshot.is_session_protected("uuid-pinned-1"));
    }

    #[test]
    fn prune_non_sidebar_codeg_state_soft_deletes_closed_folder_items_only() {
        let root = tempdir().expect("tempdir");
        let db_path = root.path().join("codeg.db");
        let conn = seed_codeg_db(&db_path);
        conn.execute(
            "INSERT INTO folder (id, name, path, is_open, deleted_at, kind) VALUES
             (1, 'open-wt', '/tmp/open-wt', 1, NULL, 'regular'),
             (2, 'closed-wt', '/tmp/closed-wt', 0, NULL, 'regular')",
            [],
        )
        .expect("insert folders");
        conn.execute(
            "INSERT INTO conversation (id, folder_id, title, agent_type, status, external_id, pinned_at, deleted_at) VALUES
             (10, 1, 'Sidebar Active', 'codex', 'pending_review', 'uuid-open-1', NULL, NULL),
             (12, 2, 'Closed Folder Conv', 'claude_code', 'pending_review', 'uuid-closed-1', NULL, NULL),
             (13, 2, 'Closed Running Conv', 'claude_code', 'in_progress', 'uuid-running-1', NULL, NULL)",
            [],
        )
        .expect("insert conversations");

        let result = prune_non_sidebar_codeg_state_in(&db_path).expect("prune");
        assert_eq!(result.conversations_removed, 1);
        assert_eq!(result.folders_removed, 1);

        let open_deleted: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM conversation WHERE id = 10",
                [],
                |row| row.get(0),
            )
            .expect("query open conv");
        let closed_deleted: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM conversation WHERE id = 12",
                [],
                |row| row.get(0),
            )
            .expect("query closed conv");
        let running_deleted: Option<String> = conn
            .query_row(
                "SELECT deleted_at FROM conversation WHERE id = 13",
                [],
                |row| row.get(0),
            )
            .expect("query running conv");
        assert!(open_deleted.is_none());
        assert!(closed_deleted.is_some());
        assert!(running_deleted.is_none());
    }
}

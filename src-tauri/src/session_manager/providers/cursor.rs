use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::session_manager::{SessionMessage, SessionMeta};

use super::utils::{extract_text, remove_dir_if_present, truncate_summary, TITLE_MAX_CHARS};
use crate::session_manager::resume::{is_session_live, LiveProcessView, ProcessView};

const PROVIDER_ID: &str = "cursor";
const INDEX_REASON_MAX_CHARS: usize = 240;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CursorIndexStatus {
    IndexReady,
    IndexUnavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorSessionRecord {
    pub chat_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub metadata_path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorMetadata {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    created_at_ms: Option<i64>,
    #[serde(default)]
    updated_at_ms: Option<i64>,
    #[serde(default)]
    has_conversation: bool,
}

struct CursorCandidate {
    record: CursorSessionRecord,
    has_conversation: bool,
    normalized_metadata_path: String,
}

struct CursorMetadataLocation {
    chat_id: String,
    metadata_path: PathBuf,
}

struct CursorIndexLayout {
    metadata_locations: Vec<CursorMetadataLocation>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CursorPruneResult {
    pub buckets_removed: u32,
    pub stale_chats_removed: u32,
    pub orphan_dirs_removed: u32,
    pub buckets_retained: u32,
    pub scannable_chats_retained: u32,
}

impl CursorPruneResult {
    pub fn total_removed(&self) -> u32 {
        self.buckets_removed + self.stale_chats_removed + self.orphan_dirs_removed
    }
}

fn cursor_chats_root() -> PathBuf {
    crate::config::get_home_dir().join(".cursor").join("chats")
}

fn sanitize_index_reason(reason: impl AsRef<str>) -> String {
    let reason = reason.as_ref().trim();
    if reason.chars().count() <= INDEX_REASON_MAX_CHARS {
        return reason.to_string();
    }

    let mut bounded = reason
        .chars()
        .take(INDEX_REASON_MAX_CHARS)
        .collect::<String>();
    bounded.push_str("...");
    bounded
}

fn index_unavailable(reason: impl AsRef<str>) -> String {
    sanitize_index_reason(format!(
        "Cursor session index is unavailable: {}",
        reason.as_ref()
    ))
}

fn resolve_index_layout(root: &Path) -> Result<CursorIndexLayout, String> {
    let metadata = fs::metadata(root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            index_unavailable("root does not exist")
        } else {
            index_unavailable(error.to_string())
        }
    })?;
    if !metadata.is_dir() {
        return Err(index_unavailable("root is not a directory"));
    }

    let canonical = root
        .canonicalize()
        .map_err(|error| index_unavailable(error.to_string()))?;
    let entries = fs::read_dir(&canonical).map_err(|error| index_unavailable(error.to_string()))?;
    let mut saw_root_entry = false;
    let mut metadata_locations = Vec::new();

    for bucket in entries {
        saw_root_entry = true;
        let Ok(bucket) = bucket else {
            continue;
        };
        if !bucket.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(chat_entries) = fs::read_dir(bucket.path()) else {
            continue;
        };

        for chat in chat_entries {
            let Ok(chat) = chat else {
                continue;
            };
            if !chat.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Some(chat_id) = chat.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if Uuid::parse_str(&chat_id).is_err() {
                continue;
            }
            let metadata_path = chat.path().join("meta.json");
            if !fs::symlink_metadata(&metadata_path).is_ok_and(|metadata| metadata.is_file()) {
                continue;
            }
            metadata_locations.push(CursorMetadataLocation {
                chat_id,
                metadata_path,
            });
        }
    }

    if saw_root_entry && metadata_locations.is_empty() {
        return Err(index_unavailable("layout is not recognized"));
    }

    Ok(CursorIndexLayout { metadata_locations })
}

fn parse_candidate(metadata_path: &Path, chat_id: &str) -> Option<CursorCandidate> {
    let file_type = fs::symlink_metadata(metadata_path).ok()?.file_type();
    if !file_type.is_file() {
        return None;
    }

    let metadata: CursorMetadata = serde_json::from_slice(&fs::read(metadata_path).ok()?).ok()?;
    let canonical_metadata_path = metadata_path.canonicalize().ok()?;
    let normalized_metadata_path = canonical_metadata_path.to_string_lossy().replace('\\', "/");

    Some(CursorCandidate {
        record: CursorSessionRecord {
            chat_id: chat_id.to_string(),
            title: metadata.title,
            cwd: metadata.cwd,
            created_at_ms: metadata.created_at_ms,
            updated_at_ms: metadata.updated_at_ms,
            metadata_path: canonical_metadata_path,
        },
        has_conversation: metadata.has_conversation,
        normalized_metadata_path,
    })
}

fn candidate_wins(candidate: &CursorCandidate, current: &CursorCandidate) -> bool {
    let candidate_updated = candidate.record.updated_at_ms.unwrap_or(0);
    let current_updated = current.record.updated_at_ms.unwrap_or(0);
    candidate_updated > current_updated
        || (candidate_updated == current_updated
            && candidate.normalized_metadata_path < current.normalized_metadata_path)
}

fn scan_records_in(root: &Path) -> Result<Vec<CursorSessionRecord>, String> {
    let layout = resolve_index_layout(root)?;
    let mut winners: HashMap<String, CursorCandidate> = HashMap::new();

    for location in layout.metadata_locations {
        let Some(candidate) = parse_candidate(&location.metadata_path, &location.chat_id) else {
            continue;
        };

        match winners.entry(location.chat_id) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(candidate);
            }
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if candidate_wins(&candidate, entry.get()) {
                    entry.insert(candidate);
                }
            }
        }
    }

    let mut records = winners
        .into_values()
        .filter(|candidate| candidate.has_conversation)
        .map(|candidate| candidate.record)
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .updated_at_ms
            .unwrap_or(0)
            .cmp(&left.updated_at_ms.unwrap_or(0))
            .then_with(|| left.chat_id.cmp(&right.chat_id))
    });
    Ok(records)
}

fn scan_sessions_in(root: &Path) -> Result<Vec<SessionMeta>, String> {
    scan_records_in(root).map(|records| {
        records
            .into_iter()
            .map(|record| SessionMeta {
                provider_id: PROVIDER_ID.to_string(),
                session_id: record.chat_id,
                title: record
                    .title
                    .as_deref()
                    .map(|title| truncate_summary(title, TITLE_MAX_CHARS)),
                summary: None,
                project_dir: record.cwd,
                created_at: record.created_at_ms,
                last_active_at: record.updated_at_ms,
                source_path: delete_target_path(&record.metadata_path),
                resume_command: None,
            })
            .collect()
    })
}

fn scan_sessions_or_empty_in(root: &Path) -> Vec<SessionMeta> {
    match scan_sessions_in(root) {
        Ok(sessions) => sessions,
        Err(error) => {
            log::debug!("Cursor session index unavailable: {error}");
            Vec::new()
        }
    }
}

fn index_status_in(root: &Path) -> CursorIndexStatus {
    match resolve_index_layout(root) {
        Ok(_) => CursorIndexStatus::IndexReady,
        Err(reason) => CursorIndexStatus::IndexUnavailable { reason },
    }
}

fn find_session_in(root: &Path, session_id: &str) -> Result<CursorSessionRecord, String> {
    Uuid::parse_str(session_id).map_err(|_| "Invalid Cursor chat ID".to_string())?;
    scan_records_in(root)?
        .into_iter()
        .find(|record| record.chat_id == session_id)
        .ok_or_else(|| "Cursor session not found".to_string())
}

pub fn session_roots() -> Vec<PathBuf> {
    vec![cursor_chats_root()]
}

pub fn scan_sessions() -> Vec<SessionMeta> {
    scan_sessions_or_empty_in(&cursor_chats_root())
}

pub fn index_status() -> CursorIndexStatus {
    index_status_in(&cursor_chats_root())
}

pub fn find_session(session_id: &str) -> Result<CursorSessionRecord, String> {
    find_session_in(&cursor_chats_root(), session_id)
}

/// Path passed to live-session detection for Cursor. The active agent holds
/// `store.db`, not `meta.json`; lsof on the transcript DB catches live bodies
/// even when `ps` visibility is limited inside the packaged app.
pub fn live_writer_source_path(metadata_path: &Path) -> PathBuf {
    metadata_path
        .parent()
        .map(|dir| dir.join("store.db"))
        .filter(|store| store.is_file())
        .unwrap_or_else(|| metadata_path.to_path_buf())
}

fn store_path_if_present(metadata_path: &Path) -> Option<String> {
    let store = metadata_path.parent()?.join("store.db");
    store
        .is_file()
        .then(|| store.to_string_lossy().replace('\\', "/"))
}

fn delete_target_path(metadata_path: &Path) -> Option<String> {
    store_path_if_present(metadata_path)
        .or_else(|| metadata_path.to_str().map(|value| value.replace('\\', "/")))
}

const CURSOR_CHAT_FILES: &[&str] = &[
    "meta.json",
    "store.db",
    "store.db-wal",
    "store.db-shm",
    "prompt_history.json",
];

fn is_cursor_chat_id(session_id: &str) -> bool {
    Uuid::parse_str(session_id).is_ok()
}

fn resolve_agent_cli_chat_dir(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let chat_dir = if path.is_dir() {
        path.to_path_buf()
    } else {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid Cursor session source: {}", path.display()))?;
        if !CURSOR_CHAT_FILES.contains(&file_name) {
            return Err(format!(
                "Unexpected Cursor Agent CLI session source: {}",
                path.display()
            ));
        }
        path.parent()
            .ok_or_else(|| format!("Invalid Cursor session path: {}", path.display()))?
            .to_path_buf()
    };

    if !chat_dir.starts_with(root) || chat_dir == root {
        return Err(format!(
            "Refusing to delete Cursor path outside Agent CLI chats: {}",
            chat_dir.display()
        ));
    }

    let bucket = chat_dir.parent().ok_or_else(|| {
        format!(
            "Invalid Cursor Agent CLI session directory: {}",
            chat_dir.display()
        )
    })?;
    if bucket == root || bucket.parent() != Some(root) {
        return Err(format!(
            "Refusing to delete Cursor Agent CLI project bucket or chats root: {}",
            chat_dir.display()
        ));
    }

    Ok(chat_dir)
}

fn read_chat_has_conversation(chat_dir: &Path) -> Option<bool> {
    let meta_path = chat_dir.join("meta.json");
    if !meta_path.is_file() {
        return None;
    }
    let metadata: CursorMetadata = serde_json::from_slice(&fs::read(&meta_path).ok()?).ok()?;
    Some(metadata.has_conversation)
}

fn chat_live_probe_source_path(chat_dir: &Path) -> Option<PathBuf> {
    let store_path = chat_dir.join("store.db");
    if store_path.is_file() {
        return Some(store_path);
    }

    let meta_path = chat_dir.join("meta.json");
    meta_path.is_file().then_some(meta_path)
}

fn chat_dir_is_live(session_id: &str, chat_dir: &Path, view: &dyn ProcessView) -> bool {
    let source_path = chat_live_probe_source_path(chat_dir);
    is_session_live(session_id, source_path.as_deref(), None, view)
}

fn remove_chat_dir_if_not_live(
    chat_dir: &Path,
    session_id: &str,
    view: &dyn ProcessView,
) -> Result<bool, String> {
    if !chat_dir.exists() {
        return Ok(false);
    }
    if chat_dir_is_live(session_id, chat_dir, view) {
        return Ok(false);
    }
    remove_dir_if_present(chat_dir, "Cursor Agent CLI chat")
}

fn cleanup_bucket_after_chat_removal(
    root: &Path,
    bucket: &Path,
    view: &dyn ProcessView,
) -> Result<(), String> {
    if bucket == root || bucket.parent() != Some(root) {
        return Ok(());
    }

    for chat in fs::read_dir(bucket).into_iter().flatten().flatten() {
        if !chat.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(chat_id) = chat.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if Uuid::parse_str(&chat_id).is_err() {
            continue;
        }

        let chat_dir = chat.path();
        match read_chat_has_conversation(&chat_dir) {
            None | Some(false) => {
                let _ = remove_chat_dir_if_not_live(&chat_dir, &chat_id, view)?;
            }
            Some(true) => {}
        }
    }

    Ok(())
}

pub fn delete_session(root: &Path, path: &Path, session_id: &str) -> Result<bool, String> {
    if !is_cursor_chat_id(session_id) {
        return Err(format!("Invalid Cursor chat ID: {session_id}"));
    }
    if !path.starts_with(root) {
        return Err(format!(
            "Cursor session source is outside the Agent CLI chats root: {}",
            path.display()
        ));
    }

    let chat_dir = resolve_agent_cli_chat_dir(root, path)?;
    let bucket = chat_dir
        .parent()
        .ok_or_else(|| {
            format!(
                "Invalid Cursor Agent CLI session directory: {}",
                chat_dir.display()
            )
        })?
        .to_path_buf();
    if chat_dir.file_name().and_then(|name| name.to_str()) != Some(session_id) {
        return Err(format!(
            "Cursor session directory does not match session ID: {}",
            chat_dir.display()
        ));
    }
    if !chat_dir.join("meta.json").is_file() {
        return Err(format!(
            "Cursor Agent CLI session is missing meta.json: {}",
            chat_dir.display()
        ));
    }

    std::fs::remove_dir_all(&chat_dir).map_err(|error| {
        format!(
            "Failed to delete Cursor Agent CLI session {}: {error}",
            chat_dir.display()
        )
    })?;
    cleanup_bucket_after_chat_removal(root, &bucket, &LiveProcessView)?;
    Ok(true)
}

/// Remove stale Agent CLI chat dirs while retaining project buckets.
pub fn prune_empty_agent_cli_buckets() -> Result<CursorPruneResult, String> {
    prune_empty_agent_cli_buckets_in(&cursor_chats_root())
}

fn prune_empty_agent_cli_buckets_in(root: &Path) -> Result<CursorPruneResult, String> {
    prune_empty_agent_cli_buckets_in_with_view(root, &LiveProcessView)
}

fn prune_empty_agent_cli_buckets_in_with_view(
    root: &Path,
    view: &dyn ProcessView,
) -> Result<CursorPruneResult, String> {
    let mut result = CursorPruneResult {
        buckets_removed: 0,
        stale_chats_removed: 0,
        orphan_dirs_removed: 0,
        buckets_retained: 0,
        scannable_chats_retained: 0,
    };

    if !root.is_dir() {
        return Ok(result);
    }

    for bucket in fs::read_dir(root).into_iter().flatten().flatten() {
        if !bucket.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let bucket_path = bucket.path();
        if bucket_path == root || bucket_path.parent() != Some(root) {
            continue;
        }

        for chat in fs::read_dir(&bucket_path).into_iter().flatten().flatten() {
            if !chat.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let Some(chat_id) = chat.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if Uuid::parse_str(&chat_id).is_err() {
                continue;
            }

            let chat_dir = chat.path();
            match read_chat_has_conversation(&chat_dir) {
                None => {
                    if remove_chat_dir_if_not_live(&chat_dir, &chat_id, view)? {
                        result.orphan_dirs_removed += 1;
                    }
                }
                Some(false) => {
                    if remove_chat_dir_if_not_live(&chat_dir, &chat_id, view)? {
                        result.stale_chats_removed += 1;
                    }
                }
                Some(true) => {
                    result.scannable_chats_retained += 1;
                }
            }
        }

        result.buckets_retained += 1;
    }

    Ok(result)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Failed to decode Cursor hex".to_string());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .map_err(|_| "Failed to decode Cursor hex".to_string())
        })
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_store_meta(value: &str) -> Result<Value, String> {
    let trimmed = value.trim();
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed)
            .map_err(|error| format!("Failed to parse Cursor store meta: {error}"));
    }
    let bytes = decode_hex(trimmed)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to parse Cursor store meta: {error}"))
}

fn extract_known_blob_ids(data: &[u8], known_ids: &HashSet<[u8; 32]>) -> Vec<String> {
    let mut ids = Vec::new();
    let mut index = 0;
    while index + 32 <= data.len() {
        let mut candidate = [0u8; 32];
        candidate.copy_from_slice(&data[index..index + 32]);
        if known_ids.contains(&candidate) {
            ids.push(encode_hex(&candidate));
            index += 32;
        } else {
            index += 1;
        }
    }
    ids
}

fn decode_hex_id(id: &str) -> Option<[u8; 32]> {
    let bytes = decode_hex(id).ok()?;
    bytes.try_into().ok()
}

fn message_from_blob(data: &[u8]) -> Option<SessionMessage> {
    let value: Value = serde_json::from_slice(data).ok()?;
    let role = value.get("role")?.as_str()?;
    if role == "system" {
        return None;
    }
    let content = value.get("content").map(extract_text).unwrap_or_default();
    if content.trim().is_empty() {
        return None;
    }
    Some(SessionMessage {
        role: role.to_string(),
        content,
        ts: None,
    })
}

pub fn load_messages(path: &Path) -> Result<Vec<SessionMessage>, String> {
    if path.file_name().and_then(|name| name.to_str()) != Some("store.db") {
        return Err("Unsupported Cursor transcript source".to_string());
    }
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Failed to open Cursor store: {error}"))?;
    let meta_value: String =
        match connection.query_row("SELECT value FROM meta LIMIT 1", [], |row| row.get(0)) {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(Vec::new()),
            Err(error) => return Err(format!("Failed to read Cursor store meta: {error}")),
        };
    let meta = decode_store_meta(&meta_value)?;
    let Some(root_id) = meta.get("latestRootBlobId").and_then(Value::as_str) else {
        return Ok(Vec::new());
    };

    let mut blobs = HashMap::new();
    let mut known_ids = HashSet::new();
    let mut statement = connection
        .prepare("SELECT id, data FROM blobs")
        .map_err(|error| format!("Failed to read Cursor store blobs: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .map_err(|error| format!("Failed to read Cursor store blobs: {error}"))?;
    for row in rows {
        let (id, data) =
            row.map_err(|error| format!("Failed to read Cursor store blobs: {error}"))?;
        if let Some(decoded) = decode_hex_id(&id) {
            known_ids.insert(decoded);
        }
        blobs.insert(id, data);
    }

    let Some(root) = blobs.get(root_id) else {
        return Ok(Vec::new());
    };
    if let Some(message) = message_from_blob(root) {
        return Ok(vec![message]);
    }

    Ok(extract_known_blob_ids(root, &known_ids)
        .into_iter()
        .filter_map(|blob_id| blobs.get(&blob_id).and_then(|data| message_from_blob(data)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    const CHAT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_CHAT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_CHAT_ID: &str = "33333333-3333-4333-8333-333333333333";

    #[derive(Default)]
    struct TestProcessView {
        holders: HashMap<PathBuf, Vec<u32>>,
        processes: HashMap<u32, crate::session_manager::resume::ProcessInfo>,
    }

    impl TestProcessView {
        fn with_holder(mut self, path: PathBuf, pid: u32) -> Self {
            self.holders.entry(path).or_default().push(pid);
            self.processes.insert(
                pid,
                crate::session_manager::resume::ProcessInfo {
                    pid,
                    ppid: Some(1),
                    command: "agent".to_string(),
                    tty: None,
                },
            );
            self
        }
    }

    impl ProcessView for TestProcessView {
        fn lock_holder_pid(&self, path: &Path) -> Option<u32> {
            self.lock_holder_pids(path).into_iter().next()
        }

        fn lock_holder_pids(&self, path: &Path) -> Vec<u32> {
            self.holders.get(path).cloned().unwrap_or_default()
        }

        fn process_info(&self, pid: u32) -> Option<crate::session_manager::resume::ProcessInfo> {
            self.processes.get(&pid).cloned()
        }

        fn processes(&self) -> Vec<crate::session_manager::resume::ProcessInfo> {
            self.processes.values().cloned().collect()
        }
    }

    fn write_meta(
        root: &Path,
        bucket: &str,
        chat_id: &str,
        updated_at_ms: Option<i64>,
        has_conversation: Option<bool>,
        cwd: Option<&str>,
    ) -> PathBuf {
        let dir = root.join(bucket).join(chat_id);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meta.json");
        let mut value = json!({
            "title": "A Cursor session title",
            "createdAtMs": 10,
        });
        let object = value.as_object_mut().unwrap();
        if let Some(updated_at_ms) = updated_at_ms {
            object.insert("updatedAtMs".to_string(), json!(updated_at_ms));
        }
        if let Some(has_conversation) = has_conversation {
            object.insert("hasConversation".to_string(), json!(has_conversation));
        }
        if let Some(cwd) = cwd {
            object.insert("cwd".to_string(), json!(cwd));
        }
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        path
    }

    #[test]
    fn live_writer_source_path_prefers_store_db() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let store = meta.parent().unwrap().join("store.db");
        std::fs::write(&store, b"store").unwrap();

        assert_eq!(live_writer_source_path(&meta), store);
    }

    #[test]
    fn us001_maps_metadata_cwd_into_session_project_dir() {
        let root = tempdir().unwrap();
        write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );

        let sessions = scan_sessions_in(root.path()).expect("recognized Cursor index");

        assert_eq!(sessions.len(), 1);
        let session = &sessions[0];
        assert_eq!(session.provider_id, "cursor");
        assert_eq!(session.session_id, CHAT_ID);
        assert_eq!(session.title.as_deref(), Some("A Cursor session title"));
        assert_eq!(session.project_dir.as_deref(), Some("/workspace/app"));
        assert_eq!(session.created_at, Some(10));
        assert_eq!(session.last_active_at, Some(20));
        assert!(session.summary.is_none());
        assert!(session
            .source_path
            .as_deref()
            .is_some_and(|path| path.ends_with("meta.json")));
        assert!(session.resume_command.is_none());
    }

    fn write_store(dir: &Path, root_id: &str, blobs: &[(&str, Vec<u8>)]) -> PathBuf {
        let path = dir.join("store.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)", [])
            .unwrap();
        connection
            .execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)", [])
            .unwrap();
        for (id, data) in blobs {
            connection
                .execute("INSERT INTO blobs (id, data) VALUES (?1, ?2)", (id, data))
                .unwrap();
        }
        let meta = serde_json::json!({ "latestRootBlobId": root_id }).to_string();
        connection
            .execute(
                "INSERT INTO meta (key, value) VALUES ('0', ?1)",
                [encode_hex(meta.as_bytes())],
            )
            .unwrap();
        path
    }

    #[test]
    fn us005_sets_source_path_only_when_store_exists() {
        let root = tempdir().unwrap();
        write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let chat_dir = root.path().join("workspace-a").join(CHAT_ID);
        write_store(
            &chat_dir,
            &"33".repeat(32),
            &[(&"33".repeat(32), b"{}".to_vec())],
        );

        let sessions = scan_sessions_in(root.path()).expect("recognized Cursor index");
        assert_eq!(sessions.len(), 1);
        let source = PathBuf::from(sessions[0].source_path.as_deref().unwrap());
        let chat_dir = chat_dir.canonicalize().unwrap();
        assert_eq!(
            source.file_name().and_then(|name| name.to_str()),
            Some("store.db")
        );
        assert_eq!(source.parent(), Some(chat_dir.as_path()));
        assert!(source.is_file());
    }

    #[test]
    fn us005_loads_ordered_conversation_and_skips_system_and_unreferenced_blobs() {
        let root = tempdir().unwrap();
        let user_id = "11".repeat(32);
        let assistant_id = "22".repeat(32);
        let system_id = "aa".repeat(32);
        let extra_id = "bb".repeat(32);
        let root_id = "33".repeat(32);
        let mut root_blob = decode_hex(&user_id).unwrap();
        root_blob.extend(decode_hex(&assistant_id).unwrap());
        let path = write_store(
            root.path(),
            &root_id,
            &[
                (
                    system_id.as_str(),
                    br#"{"role":"system","content":"ignore me"}"#.to_vec(),
                ),
                (
                    extra_id.as_str(),
                    br#"{"role":"user","content":"not in root"}"#.to_vec(),
                ),
                (
                    user_id.as_str(),
                    br#"{"role":"user","content":[{"type":"text","text":"hello"}]}"#.to_vec(),
                ),
                (
                    assistant_id.as_str(),
                    br#"{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool-call","toolName":"read"}]}"#.to_vec(),
                ),
                (root_id.as_str(), root_blob),
            ],
        );

        let messages = load_messages(&path).expect("load cursor transcript");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "hi\n[Tool: read]");
    }

    #[test]
    fn us005_rejects_non_store_transcript_paths() {
        let error = load_messages(Path::new("/tmp/does-not-matter.jsonl"))
            .expect_err("only store.db is a Cursor transcript");
        assert_eq!(error, "Unsupported Cursor transcript source");
    }

    #[test]
    fn us001_deduplicates_chat_ids_before_conversation_filter() {
        let root = tempdir().unwrap();
        write_meta(
            root.path(),
            "old",
            CHAT_ID,
            Some(10),
            Some(true),
            Some("/workspace/old"),
        );
        write_meta(
            root.path(),
            "new",
            CHAT_ID,
            Some(20),
            Some(false),
            Some("/workspace/new"),
        );
        write_meta(
            root.path(),
            "z-bucket",
            SECOND_CHAT_ID,
            Some(30),
            Some(true),
            Some("/workspace/z"),
        );
        let expected_path = write_meta(
            root.path(),
            "a-bucket",
            SECOND_CHAT_ID,
            Some(30),
            Some(true),
            Some("/workspace/a"),
        )
        .canonicalize()
        .unwrap();

        let records = scan_records_in(root.path()).expect("recognized Cursor index");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].chat_id, SECOND_CHAT_ID);
        assert_eq!(records[0].cwd.as_deref(), Some("/workspace/a"));
        assert_eq!(records[0].metadata_path, expected_path);
        let resolved = find_session_in(root.path(), SECOND_CHAT_ID).unwrap();
        assert_eq!(resolved.metadata_path, expected_path);
        assert!(find_session_in(root.path(), CHAT_ID).is_err());
    }

    #[test]
    fn us001_skips_bad_metadata_without_losing_valid_sessions() {
        let root = tempdir().unwrap();
        write_meta(
            root.path(),
            "valid",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/moved"),
        );
        write_meta(
            root.path(),
            "empty-cwd",
            SECOND_CHAT_ID,
            None,
            Some(true),
            Some(""),
        );
        write_meta(
            root.path(),
            "missing-cwd",
            THIRD_CHAT_ID,
            None,
            Some(true),
            None,
        );
        let malformed = root
            .path()
            .join("broken")
            .join("44444444-4444-4444-8444-444444444444");
        std::fs::create_dir_all(&malformed).unwrap();
        std::fs::write(malformed.join("meta.json"), b"{not-json").unwrap();
        write_meta(
            root.path(),
            "invalid-id",
            "not-a-chat-id",
            Some(99),
            Some(true),
            Some("/workspace/invalid"),
        );

        let sessions = scan_sessions_in(root.path()).expect("recognized Cursor index");

        assert_eq!(sessions.len(), 3);
        assert_eq!(
            sessions
                .iter()
                .find(|session| session.session_id == SECOND_CHAT_ID)
                .and_then(|session| session.project_dir.as_deref()),
            Some("")
        );
        assert!(sessions
            .iter()
            .find(|session| session.session_id == THIRD_CHAT_ID)
            .is_some_and(|session| session.project_dir.is_none()));
        assert!(!sessions
            .iter()
            .any(|session| session.session_id == "not-a-chat-id"));
    }

    #[test]
    fn us001_reports_unavailable_index_without_breaking_global_scan() {
        let parent = tempdir().unwrap();
        let missing = parent.path().join("missing");
        assert!(matches!(
            index_status_in(&missing),
            CursorIndexStatus::IndexUnavailable { .. }
        ));
        assert!(scan_sessions_or_empty_in(&missing).is_empty());

        let not_a_directory = parent.path().join("chats-file");
        std::fs::write(&not_a_directory, b"not a directory").unwrap();
        assert!(matches!(
            index_status_in(&not_a_directory),
            CursorIndexStatus::IndexUnavailable { .. }
        ));
        assert!(scan_sessions_or_empty_in(&not_a_directory).is_empty());

        let empty = parent.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert_eq!(index_status_in(&empty), CursorIndexStatus::IndexReady);
        assert!(scan_sessions_in(&empty).unwrap().is_empty());
    }

    #[test]
    fn us001_reports_structurally_unrecognized_index_as_unavailable() {
        let root = tempdir().unwrap();
        let unexpected = root.path().join("workspace").join("not-a-chat-id");
        std::fs::create_dir_all(&unexpected).unwrap();
        std::fs::write(unexpected.join("unexpected.json"), b"{}").unwrap();

        assert!(matches!(
            index_status_in(root.path()),
            CursorIndexStatus::IndexUnavailable { .. }
        ));
        assert!(scan_sessions_or_empty_in(root.path()).is_empty());
    }

    #[test]
    fn deletes_only_the_agent_cli_chat_directory() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let chat_dir = meta.parent().unwrap().to_path_buf();
        std::fs::write(chat_dir.join("store.db"), b"store").unwrap();
        write_meta(
            root.path(),
            "workspace-a",
            SECOND_CHAT_ID,
            Some(10),
            Some(true),
            Some("/workspace/app"),
        );
        let bucket = root.path().join("workspace-a");

        let deleted = delete_session(root.path(), &chat_dir.join("store.db"), CHAT_ID)
            .expect("delete agent cli chat");

        assert!(deleted);
        assert!(!chat_dir.exists());
        assert!(bucket.join(SECOND_CHAT_ID).join("meta.json").is_file());
        assert!(bucket.is_dir());
        assert!(root.path().is_dir());
    }

    #[test]
    fn retains_project_bucket_after_last_chat_is_deleted() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let chat_dir = meta.parent().unwrap().to_path_buf();
        let bucket = root.path().join("workspace-a");

        let deleted =
            delete_session(root.path(), &meta, CHAT_ID).expect("delete last agent cli chat");

        assert!(deleted);
        assert!(!chat_dir.exists());
        assert!(bucket.is_dir());
        assert!(root.path().is_dir());
    }

    #[test]
    fn retains_project_bucket_after_orphan_chat_dirs_are_removed() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let chat_dir = meta.parent().unwrap().to_path_buf();
        let bucket = root.path().join("workspace-a");
        let orphan = bucket.join("11111111-1111-4111-8111-111111111111");
        fs::create_dir_all(&orphan).unwrap();

        let deleted = delete_session(root.path(), &meta, CHAT_ID).expect("delete chat");

        assert!(deleted);
        assert!(!chat_dir.exists());
        assert!(!orphan.exists());
        assert!(bucket.is_dir());
    }

    #[test]
    fn deletes_agent_cli_chat_directory_from_meta_json_when_store_is_absent() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let chat_dir = meta.parent().unwrap().to_path_buf();
        let bucket = root.path().join("workspace-a");

        let deleted = delete_session(root.path(), &meta, CHAT_ID)
            .expect("delete agent cli chat via meta.json");

        assert!(deleted);
        assert!(!chat_dir.exists());
        assert!(bucket.is_dir());
        assert!(root.path().is_dir());
    }

    #[test]
    fn remove_chat_dir_if_not_live_ignores_already_removed_dirs() {
        let root = tempdir().unwrap();
        let missing = root.path().join("missing-chat");
        assert!(
            !remove_chat_dir_if_not_live(&missing, CHAT_ID, &TestProcessView::default())
                .expect("missing dir is noop")
        );
    }

    #[test]
    fn prune_retains_active_chat_with_store_db_but_no_metadata() {
        let root = tempdir().unwrap();
        let chat_dir = root.path().join("workspace-a").join(CHAT_ID);
        fs::create_dir_all(&chat_dir).unwrap();
        let store = chat_dir.join("store.db");
        fs::write(&store, b"active store").unwrap();
        let view = TestProcessView::default().with_holder(store, 42);

        let result = prune_empty_agent_cli_buckets_in_with_view(root.path(), &view)
            .expect("active metadata-less chat must be retained");

        assert_eq!(
            result,
            CursorPruneResult {
                buckets_removed: 0,
                stale_chats_removed: 0,
                orphan_dirs_removed: 0,
                buckets_retained: 1,
                scannable_chats_retained: 0,
            }
        );
        assert!(chat_dir.is_dir());
    }

    #[test]
    fn prune_never_removes_project_bucket_with_unknown_content() {
        let root = tempdir().unwrap();
        let bucket = root.path().join("workspace-a");
        let unknown = bucket.join("future-layout").join("data.bin");
        fs::create_dir_all(unknown.parent().unwrap()).unwrap();
        fs::write(&unknown, b"keep").unwrap();

        let result =
            prune_empty_agent_cli_buckets_in_with_view(root.path(), &TestProcessView::default())
                .expect("unknown bucket content must be retained");

        assert_eq!(result.buckets_removed, 0);
        assert_eq!(result.buckets_retained, 1);
        assert!(unknown.is_file());
    }

    #[test]
    fn prune_empty_agent_cli_buckets_removes_stale_chats_and_retains_project_buckets() {
        let root = tempdir().unwrap();
        write_meta(
            root.path(),
            "still-active",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        write_meta(
            root.path(),
            "dead-only",
            SECOND_CHAT_ID,
            Some(10),
            Some(false),
            Some("/workspace/dead"),
        );
        fs::create_dir_all(root.path().join("already-empty")).unwrap();
        fs::create_dir_all(
            root.path()
                .join("orphan-chat-dirs")
                .join("11111111-1111-4111-8111-111111111111"),
        )
        .unwrap();

        let removed = super::prune_empty_agent_cli_buckets_in(root.path()).expect("prune buckets");

        assert_eq!(
            removed,
            CursorPruneResult {
                buckets_removed: 0,
                stale_chats_removed: 1,
                orphan_dirs_removed: 1,
                buckets_retained: 4,
                scannable_chats_retained: 1,
            }
        );
        assert!(root.path().join("still-active").join(CHAT_ID).is_dir());
        assert!(root.path().join("dead-only").is_dir());
        assert!(root.path().join("already-empty").is_dir());
        assert!(root.path().join("orphan-chat-dirs").is_dir());
    }

    #[test]
    fn refuses_to_delete_a_project_bucket_or_chats_root() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );
        let bucket = meta.parent().unwrap().parent().unwrap();

        let bucket_error = delete_session(root.path(), bucket, CHAT_ID)
            .expect_err("must not delete the project bucket");
        assert!(bucket_error.contains("project bucket") || bucket_error.contains("chats root"));
        assert!(meta.is_file());

        let root_error = delete_session(root.path(), root.path(), CHAT_ID)
            .expect_err("must not delete chats root");
        assert!(
            root_error.contains("outside Agent CLI chats") || root_error.contains("chats root")
        );
        assert!(meta.is_file());
    }

    #[test]
    fn refuses_mismatched_or_invalid_cursor_chat_ids() {
        let root = tempdir().unwrap();
        let meta = write_meta(
            root.path(),
            "workspace-a",
            CHAT_ID,
            Some(20),
            Some(true),
            Some("/workspace/app"),
        );

        let mismatch = delete_session(root.path(), &meta, SECOND_CHAT_ID)
            .expect_err("session id must match directory");
        assert!(mismatch.contains("does not match session ID"));

        let invalid =
            delete_session(root.path(), &meta, "not-a-uuid").expect_err("chat id must be a uuid");
        assert!(invalid.contains("Invalid Cursor chat ID"));
        assert!(meta.is_file());
    }
}

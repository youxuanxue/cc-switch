use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::session_manager::SessionMeta;

use super::utils::{truncate_summary, TITLE_MAX_CHARS};

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
                source_path: None,
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

pub fn scan_sessions() -> Vec<SessionMeta> {
    scan_sessions_or_empty_in(&cursor_chats_root())
}

pub fn index_status() -> CursorIndexStatus {
    index_status_in(&cursor_chats_root())
}

pub fn find_session(session_id: &str) -> Result<CursorSessionRecord, String> {
    find_session_in(&cursor_chats_root(), session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use tempfile::tempdir;

    const CHAT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_CHAT_ID: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_CHAT_ID: &str = "33333333-3333-4333-8333-333333333333";

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
        assert!(session.source_path.is_none());
        assert!(session.resume_command.is_none());
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
}

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::get_home_dir;

use super::providers::utils::remove_dir_if_present;
use super::providers::{claude, codex, cursor, gemini, grokbuild};
use super::wts::{self, WtsWorktreePruneResult};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoragePruneResult {
    pub cursor: cursor::CursorPruneResult,
    pub claude_partitions_removed: u32,
    pub codex_empty_dirs_removed: u32,
    pub gemini_partitions_removed: u32,
    pub grok_partitions_removed: u32,
    pub cursor_desktop_workspaces_removed: u32,
    pub cursor_desktop_workspaces_retained: u32,
    pub wts_worktrees: WtsWorktreePruneResult,
}

impl SessionStoragePruneResult {
    pub fn total_removed(&self) -> u32 {
        self.cursor.total_removed()
            + self.claude_partitions_removed
            + self.codex_empty_dirs_removed
            + self.gemini_partitions_removed
            + self.grok_partitions_removed
            + self.cursor_desktop_workspaces_removed
            + self.wts_worktrees.total_removed()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorDesktopWorkspacePruneResult {
    pub removed: u32,
    pub retained: u32,
}

pub fn prune_session_storage() -> Result<SessionStoragePruneResult, String> {
    let desktop = prune_orphan_cursor_desktop_workspaces()?;
    let wts = wts::prune_stale_wts_worktrees_in(&wts::default_codes_dir())?;
    Ok(SessionStoragePruneResult {
        cursor: cursor::prune_empty_agent_cli_buckets()?,
        claude_partitions_removed: claude::prune_empty_partitions()?,
        codex_empty_dirs_removed: codex::prune_empty_date_dirs()?,
        gemini_partitions_removed: gemini::prune_empty_partitions()?,
        grok_partitions_removed: grokbuild::prune_empty_partitions()?,
        cursor_desktop_workspaces_removed: desktop.removed,
        cursor_desktop_workspaces_retained: desktop.retained,
        wts_worktrees: wts,
    })
}

/// Remove Cursor Desktop workspace metadata under `~/.cursor/projects/` when the
/// encoded workspace path no longer exists on disk.
pub fn prune_orphan_cursor_desktop_workspaces() -> Result<CursorDesktopWorkspacePruneResult, String>
{
    prune_orphan_cursor_desktop_workspaces_in(
        &get_home_dir().join(".cursor").join("projects"),
        &get_home_dir(),
    )
}

fn prune_orphan_cursor_desktop_workspaces_in(
    root: &Path,
    home: &Path,
) -> Result<CursorDesktopWorkspacePruneResult, String> {
    let mut result = CursorDesktopWorkspacePruneResult {
        removed: 0,
        retained: 0,
    };
    if !root.is_dir() {
        return Ok(result);
    }

    for entry in fs::read_dir(root)
        .map_err(|error| format!("Failed to read Cursor Desktop projects root: {error}"))?
        .flatten()
    {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let workspace_dir = entry.path();
        let file_name = entry.file_name();
        let Some(encoded) = file_name.to_str() else {
            continue;
        };
        match decode_cursor_desktop_workspace_path(home, encoded) {
            Some(path) if path.is_dir() => result.retained += 1,
            _ => {
                if remove_dir_if_present(&workspace_dir, "Cursor Desktop workspace metadata")? {
                    result.removed += 1;
                }
            }
        }
    }

    Ok(result)
}

fn encode_workspace_path(path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    path.to_string_lossy()
        .trim_start_matches('/')
        .replace('/', "-")
}

fn decode_cursor_desktop_workspace_path(home: &Path, encoded: &str) -> Option<PathBuf> {
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let home_encoded = encode_workspace_path(&home);
    let rest = encoded.strip_prefix(&format!("{home_encoded}-"))?;
    resolve_path_from_dashed_segments(&home, rest)
}

fn resolve_path_from_dashed_segments(base: &Path, rest: &str) -> Option<PathBuf> {
    let segments: Vec<&str> = rest.split('-').collect();
    resolve_path_segments(base, &segments, 0, base.to_path_buf())
}

fn resolve_path_segments(
    base: &Path,
    segments: &[&str],
    index: usize,
    current: PathBuf,
) -> Option<PathBuf> {
    if index >= segments.len() {
        return current.is_dir().then_some(current);
    }
    for end in (index + 1)..=segments.len() {
        let name = segments[index..end].join("-");
        let next = current.join(&name);
        if let Some(path) = resolve_path_segments(base, segments, end, next) {
            return Some(path);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        decode_cursor_desktop_workspace_path, prune_orphan_cursor_desktop_workspaces_in,
        resolve_path_from_dashed_segments,
    };
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    fn encode_workspace_path(path: &Path) -> String {
        super::encode_workspace_path(path)
    }

    #[test]
    fn decode_cursor_desktop_workspace_path_supports_nested_directories() {
        let root = tempdir().expect("tempdir");
        let home = root.path().join("Users").join("dev");
        let repo = home.join("Codes").join("challenge").join("agenthon2026");
        fs::create_dir_all(&repo).expect("repo");

        let encoded = encode_workspace_path(&repo);
        assert_eq!(
            decode_cursor_desktop_workspace_path(&home, &encoded)
                .and_then(|path| path.canonicalize().ok()),
            repo.canonicalize().ok()
        );
    }

    #[test]
    fn decode_cursor_desktop_workspace_path_supports_hyphenated_directory_names() {
        let root = tempdir().expect("tempdir");
        let home = root.path().join("Users").join("dev");
        let repo = home.join("Codes").join("sub2api-wt-online");
        fs::create_dir_all(&repo).expect("repo");

        let encoded = encode_workspace_path(&repo);
        assert_eq!(
            decode_cursor_desktop_workspace_path(&home, &encoded)
                .and_then(|path| path.canonicalize().ok()),
            repo.canonicalize().ok()
        );
    }

    #[test]
    fn prune_orphan_cursor_desktop_workspaces_removes_missing_checkouts_only() {
        let root = tempdir().expect("tempdir");
        let home = root.path().join("Users").join("dev");
        let projects = home.join(".cursor").join("projects");
        let alive = home.join("Codes").join("sub2api-wt-alive");
        fs::create_dir_all(&alive).expect("alive checkout");
        fs::create_dir_all(projects.join(encode_workspace_path(&alive))).expect("alive meta");
        let gone = home.join("Codes").join("sub2api-wt-gone");
        let gone_meta = projects.join(encode_workspace_path(&gone));
        fs::create_dir_all(&gone).expect("gone checkout");
        fs::create_dir_all(&gone_meta).expect("gone meta");
        fs::remove_dir_all(&gone).ok();

        let result =
            prune_orphan_cursor_desktop_workspaces_in(&projects, &home).expect("prune desktop");
        assert_eq!(result.removed, 1);
        assert_eq!(result.retained, 1);
        assert!(projects.join(encode_workspace_path(&alive)).is_dir());
        assert!(!projects.join(encode_workspace_path(&gone)).exists());
    }

    #[test]
    fn resolve_path_from_dashed_segments_returns_none_for_missing_paths() {
        let root = tempdir().expect("tempdir");
        let home = root.path().join("Users").join("dev");
        fs::create_dir_all(home.join("Codes")).expect("codes");
        assert!(resolve_path_from_dashed_segments(&home, "Codes-sub2api-wt-missing").is_none());
    }
}

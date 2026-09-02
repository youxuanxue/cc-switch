use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::session_manager::providers::utils::remove_dir_if_present;
use crate::session_manager::SessionMeta;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WtsWorkspace {
    pub slug: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WtsProjectContext {
    pub is_git_repo: bool,
    pub workspaces: Vec<WtsWorkspace>,
}

pub fn is_git_checkout(project_dir: &Path) -> bool {
    project_dir.join(".git").exists()
}

pub fn is_valid_wts_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn list_wts_workspaces(project_dir: &Path) -> Result<WtsProjectContext, String> {
    let project_dir = fs::canonicalize(project_dir)
        .map_err(|error| format!("项目目录不可用：{} ({error})", project_dir.display()))?;
    if !project_dir.is_dir() {
        return Err(format!("项目目录不是文件夹：{}", project_dir.display()));
    }

    let name = project_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "项目目录名无效".to_string())?;
    let parent = project_dir
        .parent()
        .ok_or_else(|| "无法读取项目的父目录".to_string())?;
    let prefix = format!("{name}-wt-");

    let mut workspaces = Vec::new();
    for entry in fs::read_dir(parent).map_err(|error| format!("无法列出工作区：{error}"))? {
        let entry = entry.map_err(|error| format!("无法读取工作区：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法判断工作区类型：{error}"))?;
        if !file_type.is_dir() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(slug) = file_name.strip_prefix(&prefix) else {
            continue;
        };
        if !is_valid_wts_slug(slug) {
            continue;
        }
        workspaces.push(WtsWorkspace {
            slug: slug.to_string(),
            path: entry.path().to_string_lossy().into_owned(),
        });
    }

    workspaces.sort_by(|left, right| left.slug.cmp(&right.slug));
    Ok(WtsProjectContext {
        is_git_repo: is_git_checkout(&project_dir),
        workspaces,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WtsWorktreePruneResult {
    pub removed: u32,
    pub git_removed: u32,
    pub retained: u32,
    pub skipped_dirty: u32,
}

impl WtsWorktreePruneResult {
    pub fn total_removed(&self) -> u32 {
        self.removed + self.git_removed
    }

    pub fn merge(&mut self, other: Self) {
        self.removed += other.removed;
        self.git_removed += other.git_removed;
        self.retained += other.retained;
        self.skipped_dirty += other.skipped_dirty;
    }
}

pub fn default_codes_dir() -> PathBuf {
    crate::config::get_home_dir().join("Codes")
}

pub fn is_main_git_repo(path: &Path) -> bool {
    path.join(".git").is_dir()
}

/// Remove sibling `{repo}-wt-*` directories that git no longer registers, plus
/// ephemeral temp worktrees git still tracks.
pub fn prune_stale_wts_worktrees_in(codes_dir: &Path) -> Result<WtsWorktreePruneResult, String> {
    let mut result = WtsWorktreePruneResult {
        removed: 0,
        git_removed: 0,
        retained: 0,
        skipped_dirty: 0,
    };
    if !codes_dir.is_dir() {
        return Ok(result);
    }

    for entry in fs::read_dir(codes_dir)
        .map_err(|error| {
            format!(
                "Failed to read codes directory {}: {error}",
                codes_dir.display()
            )
        })?
        .flatten()
    {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let repo_path = entry.path();
        if !is_main_git_repo(&repo_path) {
            continue;
        }
        result.merge(prune_stale_wts_worktrees_for_repo(&repo_path)?);
    }

    Ok(result)
}

pub fn prune_stale_wts_worktrees_for_repo(
    project_dir: &Path,
) -> Result<WtsWorktreePruneResult, String> {
    let project_dir = project_dir
        .canonicalize()
        .map_err(|error| format!("项目目录不可用：{} ({error})", project_dir.display()))?;
    if !is_main_git_repo(&project_dir) {
        return Err(format!(
            "Refusing to prune WTS worktrees for non-main checkout: {}",
            project_dir.display()
        ));
    }

    let _ = run_git(&project_dir, &["worktree", "prune"]);
    let registered = git_worktree_paths(&project_dir)?;

    let mut result = WtsWorktreePruneResult {
        removed: 0,
        git_removed: 0,
        retained: 0,
        skipped_dirty: 0,
    };

    for worktree in registered.iter() {
        if canonical_path(worktree) == canonical_path(&project_dir) {
            continue;
        }
        if is_ephemeral_worktree_path(worktree, &project_dir) {
            match git_worktree_remove(&project_dir, worktree) {
                Ok(()) => result.git_removed += 1,
                Err(error) if error.contains("dirty") || error.contains("modified") => {
                    result.skipped_dirty += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    let context = list_wts_workspaces(&project_dir)?;
    for workspace in context.workspaces {
        let workspace_path = PathBuf::from(&workspace.path);
        let canonical = canonical_path(&workspace_path);
        if registered
            .iter()
            .any(|path| canonical_path(path) == canonical)
        {
            result.retained += 1;
            continue;
        }
        if !git_working_tree_clean(&workspace_path)? {
            result.skipped_dirty += 1;
            continue;
        }
        if remove_dir_if_present(&workspace_path, "WTS worktree checkout")? {
            result.removed += 1;
        }
    }

    Ok(result)
}

fn canonical_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn is_ephemeral_worktree_path(worktree: &Path, main_repo: &Path) -> bool {
    let canonical = canonical_path(worktree);
    let main_repo = canonical_path(main_repo);
    let Some(repo_name) = main_repo.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if canonical.parent() == main_repo.parent() {
        let prefix = format!("{repo_name}-wt-");
        if canonical
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(&prefix))
        {
            return false;
        }
    }
    let value = canonical.to_string_lossy();
    value.contains("/T/") || value.contains("/tmp/") || value.contains("/temp/")
}

fn git_worktree_paths(repo: &Path) -> Result<HashSet<PathBuf>, String> {
    let output = run_git(repo, &["worktree", "list", "--porcelain"])?;
    if !output.status.success() {
        return Err(format!(
            "Failed to list git worktrees for {}: {}",
            repo.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let mut paths = HashSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some(path) = line.strip_prefix("worktree ") else {
            continue;
        };
        paths.insert(canonical_path(Path::new(path)));
    }
    Ok(paths)
}

fn git_working_tree_clean(path: &Path) -> Result<bool, String> {
    if !path.join(".git").exists() {
        // Orphan directories without git metadata are treated as removable shells.
        return Ok(true);
    }
    let output = run_git(path, &["status", "--porcelain"])?;
    if !output.status.success() {
        // Fail closed: unknown dirty state must not authorize deletion.
        return Ok(false);
    }
    Ok(output.stdout.is_empty())
}

fn git_worktree_remove(repo: &Path, worktree: &Path) -> Result<(), String> {
    if !git_working_tree_clean(worktree)? {
        return Err(format!(
            "Refusing to remove dirty git worktree: {}",
            worktree.display()
        ));
    }

    // Prefer delete + prune: `git worktree remove` walks the whole tree and is
    // very slow on large checkouts (node_modules etc). For already-clean WTS
    // siblings, removing the directory then pruning admin metadata is enough.
    if worktree.is_dir() {
        remove_dir_if_present(worktree, "WTS worktree checkout")?;
    }
    let prune = run_git(repo, &["worktree", "prune", "--verbose"])?;
    if !prune.status.success() {
        return Err(format!(
            "Failed to prune git worktree metadata after removing {}: {}",
            worktree.display(),
            String::from_utf8_lossy(&prune.stderr).trim()
        ));
    }
    if worktree.exists() {
        return Err(format!(
            "Worktree still exists after removal: {}",
            worktree.display()
        ));
    }
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to run git in {}: {error}", cwd.display()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WtsRegisteredWorktreeAssessment {
    pub path: String,
    pub repo_path: String,
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub session_count: u32,
    pub merged: bool,
    pub clean: bool,
    pub removable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyStaleRegisteredWtsResult {
    pub removable: Vec<WtsRegisteredWorktreeAssessment>,
    pub skipped: Vec<WtsRegisteredWorktreeAssessment>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WtsWorktreeRemovalFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStaleRegisteredWtsResult {
    pub removed: u32,
    pub failed: Vec<WtsWorktreeRemovalFailure>,
}

pub fn session_counts_by_project_dir(sessions: &[SessionMeta]) -> HashMap<PathBuf, u32> {
    let mut counts = HashMap::new();
    for session in sessions {
        let Some(project_dir) = session.project_dir.as_deref() else {
            continue;
        };
        let key = canonical_path(Path::new(project_dir));
        *counts.entry(key).or_default() += 1;
    }
    counts
}

pub fn classify_stale_registered_wts_worktrees(
    sessions: &[SessionMeta],
) -> Result<ClassifyStaleRegisteredWtsResult, String> {
    classify_stale_registered_wts_worktrees_in(&default_codes_dir(), sessions)
}

fn classify_stale_registered_wts_worktrees_in(
    codes_dir: &Path,
    sessions: &[SessionMeta],
) -> Result<ClassifyStaleRegisteredWtsResult, String> {
    let session_counts = session_counts_by_project_dir(sessions);
    let mut result = ClassifyStaleRegisteredWtsResult {
        removable: Vec::new(),
        skipped: Vec::new(),
    };
    if !codes_dir.is_dir() {
        return Ok(result);
    }

    for entry in fs::read_dir(codes_dir)
        .map_err(|error| {
            format!(
                "Failed to read codes directory {}: {error}",
                codes_dir.display()
            )
        })?
        .flatten()
    {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let repo_path = entry.path();
        if !is_main_git_repo(&repo_path) {
            continue;
        }
        let registered = git_worktree_paths(&repo_path)?;
        for worktree in registered {
            if canonical_path(&worktree) == canonical_path(&repo_path) {
                continue;
            }
            let Some(assessment) =
                assess_registered_wts_worktree(&repo_path, &worktree, &session_counts)?
            else {
                continue;
            };
            if assessment.removable {
                result.removable.push(assessment);
            } else {
                result.skipped.push(assessment);
            }
        }
    }

    result
        .removable
        .sort_by(|left, right| left.path.cmp(&right.path));
    result
        .skipped
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(result)
}

pub fn remove_stale_registered_wts_worktrees(
    paths: &[String],
) -> Result<RemoveStaleRegisteredWtsResult, String> {
    let sessions = crate::session_manager::scan_sessions();
    remove_stale_registered_wts_worktrees_in(&default_codes_dir(), paths, &sessions)
}

fn remove_stale_registered_wts_worktrees_in(
    codes_dir: &Path,
    paths: &[String],
    sessions: &[SessionMeta],
) -> Result<RemoveStaleRegisteredWtsResult, String> {
    let mut result = RemoveStaleRegisteredWtsResult {
        removed: 0,
        failed: Vec::new(),
    };
    if paths.is_empty() {
        return Ok(result);
    }

    let session_counts = session_counts_by_project_dir(sessions);

    for path in paths {
        let worktree = PathBuf::from(path);
        let Some(main_repo) = resolve_main_repo_for_worktree(&worktree, codes_dir) else {
            result.failed.push(WtsWorktreeRemovalFailure {
                path: path.clone(),
                error: "Could not resolve main git repository for worktree".to_string(),
            });
            continue;
        };

        match assess_registered_wts_worktree(&main_repo, &worktree, &session_counts)? {
            Some(assessment) if assessment.removable => {}
            Some(assessment) => {
                result.failed.push(WtsWorktreeRemovalFailure {
                    path: path.clone(),
                    error: format!(
                        "Refusing to remove worktree that is no longer removable ({})",
                        assessment
                            .skip_reason
                            .unwrap_or_else(|| "not_removable".to_string())
                    ),
                });
                continue;
            }
            None => {
                result.failed.push(WtsWorktreeRemovalFailure {
                    path: path.clone(),
                    error: "Path is not a sibling WTS worktree under Codes".to_string(),
                });
                continue;
            }
        }

        match git_worktree_remove(&main_repo, &worktree) {
            Ok(()) => result.removed += 1,
            Err(error) => result.failed.push(WtsWorktreeRemovalFailure {
                path: path.clone(),
                error,
            }),
        }
    }

    Ok(result)
}

fn assess_registered_wts_worktree(
    main_repo: &Path,
    worktree: &Path,
    session_counts: &HashMap<PathBuf, u32>,
) -> Result<Option<WtsRegisteredWorktreeAssessment>, String> {
    let Some(slug) = sibling_wts_slug(main_repo, worktree) else {
        return Ok(None);
    };
    let canonical = canonical_path(worktree);
    let session_count = session_counts.get(&canonical).copied().unwrap_or(0);
    let clean = git_working_tree_clean(worktree)?;
    let branch = git_current_branch(worktree);
    let merged = git_branch_fully_merged(main_repo, worktree)?;

    let mut assessment = WtsRegisteredWorktreeAssessment {
        path: canonical.to_string_lossy().replace('\\', "/"),
        repo_path: canonical_path(main_repo)
            .to_string_lossy()
            .replace('\\', "/"),
        slug,
        branch,
        session_count,
        merged,
        clean,
        removable: false,
        skip_reason: None,
    };

    if !clean {
        assessment.skip_reason = Some("dirty".to_string());
    } else if session_count > 0 && !merged {
        assessment.skip_reason = Some("has_sessions".to_string());
    } else {
        assessment.removable = true;
    }

    Ok(Some(assessment))
}

fn sibling_wts_slug(main_repo: &Path, worktree: &Path) -> Option<String> {
    let main_repo = canonical_path(main_repo);
    let worktree = canonical_path(worktree);
    let repo_name = main_repo.file_name()?.to_str()?;
    if worktree.parent()? != main_repo.parent()? {
        return None;
    }
    let prefix = format!("{repo_name}-wt-");
    worktree
        .file_name()?
        .to_str()?
        .strip_prefix(&prefix)
        .filter(|slug| is_valid_wts_slug(slug))
        .map(str::to_owned)
}

fn resolve_main_repo_for_worktree(worktree: &Path, codes_dir: &Path) -> Option<PathBuf> {
    let worktree = canonical_path(worktree);
    let parent = worktree.parent()?;
    if canonical_path(parent) != canonical_path(codes_dir) {
        return None;
    }
    let name = worktree.file_name()?.to_str()?;
    let marker = name.find("-wt-")?;
    let repo_name = &name[..marker];
    let main_repo = parent.join(repo_name);
    is_main_git_repo(&main_repo).then(|| canonical_path(&main_repo))
}

fn git_current_branch(path: &Path) -> Option<String> {
    let output = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch == "HEAD" {
        None
    } else {
        Some(branch)
    }
}

fn git_default_integration_branch(main_repo: &Path) -> Option<String> {
    for candidate in ["main", "master"] {
        let output = run_git(main_repo, &["rev-parse", "--verify", candidate]).ok()?;
        if output.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn git_rev_parse(repo: &Path, reference: &str) -> Result<String, String> {
    let output = run_git(repo, &["rev-parse", reference])?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve git reference {reference} in {}: {}",
            repo.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_branch_fully_merged(main_repo: &Path, worktree: &Path) -> Result<bool, String> {
    let Some(branch) = git_current_branch(worktree) else {
        return Ok(false);
    };
    if branch == "main" || branch == "master" {
        return Ok(false);
    }
    let main_head = git_rev_parse(main_repo, "HEAD")?;
    let worktree_head = git_rev_parse(worktree, "HEAD")?;
    if main_head == worktree_head {
        return Ok(false);
    }
    let Some(base) = git_default_integration_branch(main_repo) else {
        return Ok(false);
    };
    let output = run_git(main_repo, &["branch", "--merged", base.as_str()])?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.trim().trim_start_matches('*').trim() == branch))
}

#[cfg(test)]
mod tests {
    use super::{is_valid_wts_slug, list_wts_workspaces};
    use crate::session_manager::SessionMeta;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn accepts_safe_slugs_and_rejects_paths() {
        assert!(is_valid_wts_slug("prob"));
        assert!(is_valid_wts_slug("cursor-official"));
        assert!(!is_valid_wts_slug(""));
        assert!(!is_valid_wts_slug("../escape"));
        assert!(!is_valid_wts_slug("has/slash"));
        assert!(!is_valid_wts_slug("-leading"));
    }

    #[test]
    fn lists_sibling_wts_directories_and_ignores_noise() {
        let root = tempdir().expect("tempdir");
        let repo = root.path().join("cc-switch");
        fs::create_dir(&repo).expect("repo");
        fs::create_dir(root.path().join("cc-switch-wt-prob")).expect("prob");
        fs::create_dir(root.path().join("cc-switch-wt-cursor-official")).expect("cursor");
        fs::create_dir(root.path().join("other-wt-nope")).expect("other");
        fs::write(root.path().join("cc-switch-wt-file"), "nope").expect("file");

        let context = list_wts_workspaces(&repo).expect("list");
        let slugs: Vec<_> = context
            .workspaces
            .iter()
            .map(|item| item.slug.as_str())
            .collect();
        assert!(!context.is_git_repo);
        assert_eq!(slugs, ["cursor-official", "prob"]);
        assert!(context
            .workspaces
            .iter()
            .all(|item| item.path.ends_with(&format!("cc-switch-wt-{}", item.slug))));
    }

    #[test]
    fn reports_git_checkout_only_when_dot_git_exists() {
        let root = tempdir().expect("tempdir");
        let repo = root.path().join("cc-switch");
        fs::create_dir(&repo).expect("repo");
        assert!(!super::is_git_checkout(&repo));

        fs::create_dir(repo.join(".git")).expect("git dir");
        assert!(super::is_git_checkout(&repo));
        assert!(list_wts_workspaces(&repo).expect("list").is_git_repo);

        let worktree = root.path().join("linked");
        fs::create_dir(&worktree).expect("worktree");
        fs::write(worktree.join(".git"), "gitdir: ../cc-switch/.git").expect("git file");
        assert!(super::is_git_checkout(&worktree));
    }

    #[test]
    fn rejects_missing_project_dir() {
        let root = tempdir().expect("tempdir");
        let error = list_wts_workspaces(&root.path().join("missing")).expect_err("missing");
        assert!(error.contains("项目目录不可用"));
    }

    fn configure_git(repo: &Path) {
        for (key, value) in [
            ("user.email", "test@example.com"),
            ("user.name", "Test User"),
        ] {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["config", key, value])
                .status()
                .expect("git config");
            assert!(
                status.success(),
                "git config {key} failed in {}",
                repo.display()
            );
        }
    }

    fn init_git_repo(repo: &Path, default_branch: &str) {
        fs::create_dir_all(repo).expect("repo");
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["init", "-b", default_branch])
            .status()
            .expect("git init");
        assert!(status.success(), "git init failed in {}", repo.display());
        configure_git(repo);
    }

    fn seed_main_repo(repo: &Path) {
        init_git_repo(repo, "main");
        fs::write(repo.join("README.md"), "seed").expect("seed");
        let add = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["add", "README.md"])
            .status()
            .expect("git add");
        assert!(add.success(), "git add failed in {}", repo.display());
        let commit = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["commit", "-m", "seed"])
            .status()
            .expect("git commit");
        assert!(commit.success(), "git commit failed in {}", repo.display());
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[test]
    fn prune_stale_wts_worktrees_removes_unregistered_sibling_directories() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let orphan = root.path().join("sub2api-wt-orphan");
        fs::create_dir_all(&orphan).expect("orphan");

        let result = super::prune_stale_wts_worktrees_in(root.path()).expect("prune");
        assert_eq!(result.removed, 1);
        assert_eq!(result.retained, 0);
        assert!(!orphan.exists());
    }

    #[test]
    fn prune_stale_wts_worktrees_retains_registered_sibling_directories() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let alive = root.path().join("sub2api-wt-alive");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                alive.to_str().expect("path"),
                "-b",
                "feature/alive",
            ])
            .status()
            .expect("git worktree add");

        let result = super::prune_stale_wts_worktrees_in(root.path()).expect("prune");
        assert_eq!(result.removed, 0);
        assert_eq!(result.retained, 1);
        assert!(alive.is_dir());
    }

    #[test]
    fn classify_stale_registered_wts_worktrees_marks_no_session_worktrees_removable() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let stale = root.path().join("sub2api-wt-stale");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                stale.to_str().expect("path"),
                "-b",
                "feature/stale",
            ])
            .status()
            .expect("git worktree add");

        let result =
            super::classify_stale_registered_wts_worktrees_in(root.path(), &[]).expect("classify");
        assert_eq!(result.removable.len(), 1);
        assert_eq!(result.removable[0].slug, "stale");
        assert_eq!(result.removable[0].session_count, 0);
    }

    #[test]
    fn classify_stale_registered_wts_worktrees_skips_unmerged_worktrees_with_sessions() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let active = root.path().join("sub2api-wt-active");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                active.to_str().expect("path"),
                "-b",
                "feature/active",
            ])
            .status()
            .expect("git worktree add");
        fs::write(active.join("change.txt"), "delta").expect("change");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&active)
            .args(["add", "change.txt"])
            .status()
            .expect("git add");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&active)
            .args(["commit", "-m", "active change"])
            .status()
            .expect("git commit");

        let sessions = vec![SessionMeta {
            provider_id: "codex".to_string(),
            session_id: "sess-1".to_string(),
            title: None,
            summary: None,
            project_dir: Some(active.to_string_lossy().replace('\\', "/")),
            created_at: None,
            last_active_at: None,
            source_path: None,
            resume_command: None,
        }];

        let result = super::classify_stale_registered_wts_worktrees_in(root.path(), &sessions)
            .expect("classify");
        assert!(result.removable.is_empty());
        assert_eq!(result.skipped.len(), 1);
        assert_eq!(
            result.skipped[0].skip_reason.as_deref(),
            Some("has_sessions")
        );
    }

    #[test]
    fn remove_stale_registered_wts_worktrees_refuses_unmerged_worktrees_with_sessions() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let active = root.path().join("sub2api-wt-active");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                active.to_str().expect("path"),
                "-b",
                "feature/active",
            ])
            .status()
            .expect("git worktree add");
        fs::write(active.join("change.txt"), "delta").expect("change");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&active)
            .args(["add", "change.txt"])
            .status()
            .expect("git add");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&active)
            .args(["commit", "-m", "active change"])
            .status()
            .expect("git commit");

        let sessions = vec![SessionMeta {
            provider_id: "codex".to_string(),
            session_id: "sess-1".to_string(),
            title: None,
            summary: None,
            project_dir: Some(active.to_string_lossy().replace('\\', "/")),
            created_at: None,
            last_active_at: None,
            source_path: None,
            resume_command: None,
        }];
        let path = active.to_string_lossy().replace('\\', "/");

        let result = super::remove_stale_registered_wts_worktrees_in(
            root.path(),
            &[path.clone()],
            &sessions,
        )
        .expect("remove");
        assert_eq!(result.removed, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].path, path);
        assert!(
            result.failed[0].error.contains("has_sessions"),
            "expected has_sessions refusal, got {}",
            result.failed[0].error
        );
        assert!(active.is_dir());
    }

    #[test]
    fn remove_stale_registered_wts_worktrees_refuses_dirty_worktrees() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let dirty = root.path().join("sub2api-wt-dirty");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                dirty.to_str().expect("path"),
                "-b",
                "feature/dirty",
            ])
            .status()
            .expect("git worktree add");
        fs::write(dirty.join("scratch.txt"), "uncommitted").expect("dirty file");

        let path = dirty.to_string_lossy().replace('\\', "/");
        let result =
            super::remove_stale_registered_wts_worktrees_in(root.path(), &[path.clone()], &[])
                .expect("remove");
        assert_eq!(result.removed, 0);
        assert_eq!(result.failed.len(), 1);
        assert!(
            result.failed[0].error.contains("dirty"),
            "expected dirty refusal, got {}",
            result.failed[0].error
        );
        assert!(dirty.is_dir());
    }

    #[test]
    fn git_working_tree_clean_fail_closed_when_status_fails() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("broken");
        fs::create_dir_all(&repo).expect("repo");
        // .git exists but is not a valid repository → status fails → treat as dirty.
        fs::create_dir(repo.join(".git")).expect("git dir");
        assert!(!super::git_working_tree_clean(&repo).expect("clean check"));
    }

    #[test]
    fn remove_stale_registered_wts_worktrees_removes_no_session_worktrees() {
        if !git_available() {
            return;
        }

        let root = tempdir().expect("tempdir");
        let repo = root.path().join("sub2api");
        seed_main_repo(&repo);

        let stale = root.path().join("sub2api-wt-stale");
        std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                stale.to_str().expect("path"),
                "-b",
                "feature/stale",
            ])
            .status()
            .expect("git worktree add");

        let path = stale.to_string_lossy().replace('\\', "/");
        let result = super::remove_stale_registered_wts_worktrees_in(root.path(), &[path], &[])
            .expect("remove");
        assert_eq!(result.removed, 1);
        assert!(result.failed.is_empty());
        assert!(!stale.exists());
    }
}

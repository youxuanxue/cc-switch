use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::config::get_app_config_dir;
use crate::error::AppError;

use super::catalog::CatalogSource;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

pub(super) fn git_output(root: &Path, args: &[&str]) -> Result<String, AppError> {
    let stdout = tempfile::NamedTempFile::new().map_err(|e| AppError::Message(e.to_string()))?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| AppError::Message(e.to_string()))?;
    let mut child = Command::new("git")
        .current_dir(root)
        .arg("--no-optional-locks")
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "http.lowSpeedLimit=1",
            "-c",
            "http.lowSpeedTime=30",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=10",
        )
        .stdin(Stdio::null())
        .stdout(
            stdout
                .reopen()
                .map_err(|e| AppError::Message(e.to_string()))?,
        )
        .stderr(
            stderr
                .reopen()
                .map_err(|e| AppError::Message(e.to_string()))?,
        )
        .spawn()
        .map_err(|e| AppError::Message(format!("Git source: {e}")))?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(invalid(format!(
                        "Git source command failed: {}",
                        args.first().unwrap_or(&"git")
                    )));
                }
                return fs::read_to_string(stdout.path())
                    .map_err(|e| AppError::io(stdout.path(), e));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Message(format!(
                    "Git source command timed out or failed: {result:?}"
                )));
            }
        }
    }
}

pub(super) fn resolve(
    source: &CatalogSource,
    name: &str,
    fetch: bool,
) -> Result<PathBuf, AppError> {
    let repo = source
        .repo
        .as_deref()
        .ok_or_else(|| invalid("Git source requires repo"))?;
    let revision = source
        .revision
        .as_deref()
        .ok_or_else(|| invalid("Git source requires revision"))?;
    let rel = source
        .path
        .as_deref()
        .ok_or_else(|| invalid("Git source requires path"))?;
    let url = url::Url::parse(repo).map_err(|_| invalid("Invalid Git source URL"))?;
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 2
        || !parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
        || !parts[1].ends_with(".git")
    {
        return Err(invalid(
            "Git source requires an HTTPS GitHub repository URL without credentials",
        ));
    }
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(invalid(
            "Git source revision must be a full lowercase commit SHA",
        ));
    }
    if rel.is_empty()
        || rel.contains('\\')
        || !Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(invalid("Git source path must stay inside the repository"));
    }
    let cache = get_app_config_dir()
        .join("catalog-sources")
        .join(format!("{:x}", Sha256::digest(repo.as_bytes())));
    let root = cache.join(revision);
    if !root.exists() {
        if !fetch {
            return Err(invalid(
                "Git source is not cached; install or upgrade to fetch it",
            ));
        }
        fs::create_dir_all(&cache).map_err(|e| AppError::io(&cache, e))?;
        let staging = tempfile::Builder::new()
            .prefix(".fetch-")
            .tempdir_in(&cache)
            .map_err(|e| AppError::io(&cache, e))?;
        git_output(staging.path(), &["init", "--quiet", "--template="])?;
        if git_output(
            staging.path(),
            &["fetch", "--quiet", "--depth=1", "--no-tags", repo, revision],
        )
        .is_err()
        {
            let ssh = format!("git@github.com:{}", parts.join("/"));
            git_output(
                staging.path(),
                &["fetch", "--quiet", "--depth=1", "--no-tags", &ssh, revision],
            )?;
        }
        let fetched = git_output(staging.path(), &["rev-parse", "FETCH_HEAD^{commit}"])?;
        if fetched.trim() != revision {
            return Err(invalid(
                "Fetched Git source does not match the approved commit",
            ));
        }
        git_output(
            staging.path(),
            &["checkout", "--quiet", "--detach", revision],
        )?;
        validate(staging.path(), rel, name, revision)?;
        match fs::rename(staging.path(), &root) {
            Ok(()) => (),
            Err(_) if root.exists() => (),
            Err(e) => return Err(AppError::io(&root, e)),
        }
    }
    validate(&root, rel, name, revision)
}

fn validate(root: &Path, rel: &str, name: &str, revision: &str) -> Result<PathBuf, AppError> {
    if git_output(root, &["rev-parse", "HEAD"])?.trim() != revision
        || !git_output(
            root,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
            ],
        )?
        .trim()
        .is_empty()
    {
        return Err(invalid(
            "Cached Git source has drifted; refusing to install it",
        ));
    }
    let path = root.join(rel);
    let canonical = fs::canonicalize(&path).map_err(|e| AppError::io(&path, e))?;
    if !canonical.starts_with(fs::canonicalize(root).map_err(|e| AppError::io(root, e))?) {
        return Err(invalid("Git skill path escapes its repository"));
    }
    validate_tree(&path)?;
    let file = path.join("SKILL.md");
    let body = fs::read_to_string(&file).map_err(|e| AppError::io(&file, e))?;
    let frontmatter = body
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---").map(|(yaml, _)| yaml))
        .ok_or_else(|| invalid("Git skill is missing YAML frontmatter"))?;
    let meta: serde_yaml::Value = serde_yaml::from_str(frontmatter)
        .map_err(|e| invalid(format!("Invalid skill YAML: {e}")))?;
    if meta["name"].as_str() != Some(name) {
        return Err(invalid("Git skill name does not match the catalog"));
    }
    Ok(path)
}

fn validate_tree(path: &Path) -> Result<(), AppError> {
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::io(path, e))?;
    if meta.file_type().is_symlink() {
        return Err(invalid("Git skill packages cannot contain symlinks"));
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| AppError::io(path, e))? {
            validate_tree(&entry.map_err(|e| AppError::io(path, e))?.path())?;
        }
    }
    Ok(())
}

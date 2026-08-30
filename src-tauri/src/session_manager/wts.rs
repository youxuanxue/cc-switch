use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WtsWorkspace {
    pub slug: String,
    pub path: String,
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

pub fn list_wts_workspaces(project_dir: &Path) -> Result<Vec<WtsWorkspace>, String> {
    let project_dir = fs::canonicalize(project_dir).map_err(|error| {
        format!(
            "项目目录不可用：{} ({error})",
            project_dir.display()
        )
    })?;
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
    Ok(workspaces)
}

#[cfg(test)]
mod tests {
    use super::{is_valid_wts_slug, list_wts_workspaces};
    use std::fs;
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

        let workspaces = list_wts_workspaces(&repo).expect("list");
        let slugs: Vec<_> = workspaces.iter().map(|item| item.slug.as_str()).collect();
        assert_eq!(slugs, ["cursor-official", "prob"]);
        assert!(workspaces
            .iter()
            .all(|item| item.path.ends_with(&format!("cc-switch-wt-{}", item.slug))));
    }

    #[test]
    fn rejects_missing_project_dir() {
        let root = tempdir().expect("tempdir");
        let error = list_wts_workspaces(&root.path().join("missing")).expect_err("missing");
        assert!(error.contains("项目目录不可用"));
    }
}

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::AppError;

use super::state::DEFAULT_CATALOG_REPO;

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogFile {
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub revision: Option<String>,
    #[serde(default)]
    pub skills: Vec<CatalogSkill>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogSkill {
    pub name: String,
    #[serde(default)]
    pub recommended: bool,
    pub source: CatalogSource,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogSource {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LoadedCatalog {
    pub repo: String,
    pub revision: String,
    pub skills: Vec<CatalogSkill>,
    pub root: PathBuf,
}

impl LoadedCatalog {
    pub fn empty() -> Self {
        Self {
            repo: DEFAULT_CATALOG_REPO.to_string(),
            revision: String::new(),
            skills: Vec::new(),
            root: PathBuf::new(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&CatalogSkill> {
        self.skills.iter().find(|s| s.name == name)
    }

    pub fn recommended(&self) -> Vec<&CatalogSkill> {
        self.skills.iter().filter(|s| s.recommended).collect()
    }

    pub fn source_dir(&self, skill: &CatalogSkill) -> Result<PathBuf, AppError> {
        if skill.source.kind != "self" {
            return Err(AppError::InvalidInput(format!(
                "v1 只支持 source.kind=self，收到 {}",
                skill.source.kind
            )));
        }
        let rel = skill.source.path.as_deref().unwrap_or(&skill.name);
        let path = if Path::new(rel).is_absolute() {
            PathBuf::from(rel)
        } else {
            self.root.join(rel)
        };
        if !path.join("SKILL.md").is_file() {
            return Err(AppError::InvalidInput(format!(
                "货架技能 {} 缺少 SKILL.md: {}",
                skill.name,
                path.display()
            )));
        }
        Ok(path)
    }
}

pub fn load_catalog() -> Result<LoadedCatalog, AppError> {
    let path = match std::env::var("CC_SWITCH_CATALOG") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => return Ok(LoadedCatalog::empty()),
    };
    if !path.is_file() {
        return Ok(LoadedCatalog::empty());
    }
    let raw = fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))?;
    let parsed: CatalogFile = serde_yaml::from_str(&raw)
        .map_err(|e| AppError::Config(format!("catalog YAML 无效: {e}")))?;
    Ok(LoadedCatalog {
        repo: parsed
            .repo
            .unwrap_or_else(|| DEFAULT_CATALOG_REPO.to_string()),
        revision: parsed.revision.unwrap_or_default(),
        skills: parsed.skills,
        root: path.parent().unwrap_or(Path::new(".")).to_path_buf(),
    })
}

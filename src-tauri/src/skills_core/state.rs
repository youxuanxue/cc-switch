use serde::{Deserialize, Serialize};

use crate::config::get_app_config_dir;
use crate::database::Database;
use crate::error::AppError;

pub const DEFAULT_CATALOG_REPO: &str = "https://github.com/youxuanxue/agent-skills.git";
pub const STATE_KEY: &str = "skills_core_v1";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ControlState {
    #[serde(default)]
    pub in_use_agents: Vec<String>,
    #[serde(default = "default_follow")]
    pub follow_catalog: bool,
    #[serde(default)]
    pub catalog_ref: CatalogRef,
    #[serde(default)]
    pub library: Vec<LibraryEntry>,
}

fn default_follow() -> bool {
    true
}

impl ControlState {
    pub fn closed() -> Self {
        Self {
            in_use_agents: Vec::new(),
            follow_catalog: true,
            catalog_ref: CatalogRef::default(),
            library: Vec::new(),
        }
    }

    pub fn is_open(&self) -> bool {
        !self.in_use_agents.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogRef {
    pub repo: String,
    pub revision: String,
}

impl Default for CatalogRef {
    fn default() -> Self {
        Self {
            repo: DEFAULT_CATALOG_REPO.to_string(),
            revision: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryEntry {
    pub name: String,
    pub provenance: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCandidate {
    pub name: String,
    pub provenance: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameConflict {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirstOpenPreview {
    pub candidates: Vec<SkillCandidate>,
    pub conflicts: Vec<NameConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibrarySkill {
    pub name: String,
    pub provenance: String,
    pub behind_catalog: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Projection {
    pub agent: String,
    pub aligned: bool,
    pub skill_count: usize,
    pub description_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorReport {
    pub schema: u32,
    pub open: bool,
    pub follow_catalog: bool,
    pub catalog_ref: CatalogRef,
    pub in_use_agents: Vec<String>,
    pub library: Vec<LibrarySkill>,
    pub projections: Vec<Projection>,
    pub foreign: Vec<String>,
    pub broken: Vec<String>,
    pub duplicate: Vec<String>,
    pub legacy_writers_stopped: Vec<String>,
    pub reload: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerFile {
    pub schema: u32,
    pub owner: String,
    pub catalog_ref: CatalogRef,
    pub in_use_agents: Vec<String>,
    pub follow_catalog: bool,
}

pub fn load_state(db: &Database) -> Result<ControlState, AppError> {
    match db.get_setting(STATE_KEY)? {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw)
            .map_err(|e| AppError::Config(format!("skills_core_v1 损坏: {e}"))),
        _ => Ok(ControlState::closed()),
    }
}

pub fn save_state(db: &Database, state: &ControlState) -> Result<(), AppError> {
    let raw = serde_json::to_string(state).map_err(|e| AppError::JsonSerialize { source: e })?;
    db.set_setting(STATE_KEY, &raw)
}

pub fn marker_path() -> std::path::PathBuf {
    get_app_config_dir().join("skills-control.json")
}

pub fn write_marker(state: &ControlState) -> Result<(), AppError> {
    if !state.is_open() {
        clear_marker()?;
        return Ok(());
    }
    let marker = MarkerFile {
        schema: 1,
        owner: "cc-switch".into(),
        catalog_ref: state.catalog_ref.clone(),
        in_use_agents: state.in_use_agents.clone(),
        follow_catalog: state.follow_catalog,
    };
    let path = marker_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    let raw = serde_json::to_string_pretty(&marker)
        .map_err(|e| AppError::JsonSerialize { source: e })?;
    std::fs::write(&path, raw).map_err(|e| AppError::io(&path, e))
}

pub fn clear_marker() -> Result<(), AppError> {
    let path = marker_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| AppError::io(&path, e))?;
    }
    Ok(())
}

pub fn require_open(db: &Database) -> Result<ControlState, AppError> {
    let state = load_state(db)?;
    if !state.is_open() {
        return Err(AppError::InvalidInput(
            "未开张：只有 `cc-switch skills open` 可以写库".into(),
        ));
    }
    Ok(state)
}

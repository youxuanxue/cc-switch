use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::app_config::AppType;
use crate::config::get_home_dir;
use crate::error::AppError;
use crate::services::skill::SkillService;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentToken {
    ClaudeCursor,
    Codex,
    Gemini,
    GrokBuild,
    OpenCode,
    Hermes,
    Pi,
    Antigravity,
}

impl AgentToken {
    pub fn parse(token: &str) -> Result<Self, AppError> {
        match token {
            "claude-cursor" => Ok(Self::ClaudeCursor),
            "codex" => Ok(Self::Codex),
            "gemini" => Ok(Self::Gemini),
            "grokbuild" => Ok(Self::GrokBuild),
            "opencode" => Ok(Self::OpenCode),
            "hermes" => Ok(Self::Hermes),
            "pi" => Ok(Self::Pi),
            "antigravity" => Ok(Self::Antigravity),
            other => Err(AppError::InvalidInput(format!(
                "未知在用 Agent token: {other}"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCursor => "claude-cursor",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
            Self::GrokBuild => "grokbuild",
            Self::OpenCode => "opencode",
            Self::Hermes => "hermes",
            Self::Pi => "pi",
            Self::Antigravity => "antigravity",
        }
    }

    pub fn app_type(self) -> Option<AppType> {
        match self {
            Self::ClaudeCursor => None,
            Self::Codex => Some(AppType::Codex),
            Self::Gemini => Some(AppType::Gemini),
            Self::GrokBuild => Some(AppType::GrokBuild),
            Self::OpenCode => Some(AppType::OpenCode),
            Self::Hermes => Some(AppType::Hermes),
            Self::Pi => Some(AppType::Pi),
            Self::Antigravity => None,
        }
    }

    pub fn projection_root(self) -> Result<PathBuf, AppError> {
        match self {
            Self::ClaudeCursor => Ok(cursor_skills_dir()),
            Self::Antigravity => Ok(antigravity_skills_dir()),
            other => {
                let app = other
                    .app_type()
                    .expect("non-special token must map to AppType");
                SkillService::get_app_skills_dir(&app).map_err(|e| AppError::Message(e.to_string()))
            }
        }
    }
}

pub fn cursor_skills_dir() -> PathBuf {
    get_home_dir().join(".cursor").join("skills")
}

pub fn antigravity_skills_dir() -> PathBuf {
    get_home_dir()
        .join(".gemini")
        .join("antigravity-cli")
        .join("skills")
}

pub fn claude_skills_root() -> Result<PathBuf, AppError> {
    SkillService::get_app_skills_dir(&AppType::Claude).map_err(|e| AppError::Message(e.to_string()))
}

pub fn is_dir_symlink_to(link: &Path, target: &Path) -> bool {
    let meta = match fs::symlink_metadata(link) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.file_type().is_symlink() {
        return false;
    }
    match (fs::canonicalize(link), fs::canonicalize(target)) {
        (Ok(a), Ok(b)) => a == b,
        _ => fs::read_link(link).ok().as_deref() == Some(target),
    }
}

pub fn sanitize_skill_name(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return Err(AppError::InvalidInput(format!(
            "非法技能名: {raw}"
        )));
    }
    let path = Path::new(trimmed);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) => {
            let normalized = name.to_string_lossy().trim().to_string();
            if normalized.is_empty()
                || normalized == "."
                || normalized == ".."
                || normalized.starts_with('.')
            {
                Err(AppError::InvalidInput(format!("非法技能名: {raw}")))
            } else {
                Ok(normalized)
            }
        }
        _ => Err(AppError::InvalidInput(format!("非法技能名: {raw}"))),
    }
}

pub fn parse_agents(tokens: &[String]) -> Result<Vec<AgentToken>, AppError> {
    let mut out = Vec::new();
    for token in tokens {
        let parsed = AgentToken::parse(token)?;
        if !out.contains(&parsed) {
            out.push(parsed);
        }
    }
    Ok(out)
}

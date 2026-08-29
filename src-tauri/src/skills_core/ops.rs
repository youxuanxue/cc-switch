use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::database::Database;
use crate::error::AppError;
use crate::services::skill::SkillService;

use super::agent::{
    claude_skills_root, cursor_skills_dir, is_dir_symlink_to, parse_agents, remove_dir_symlink,
    sanitize_skill_name, AgentToken,
};
use super::catalog::{load_catalog, LoadedCatalog};
use super::state::{
    clear_marker, load_state, require_open, save_state, write_marker, CatalogRef, ControlState,
    DoctorReport, FirstOpenPreview, LibraryEntry, LibrarySkill, NameConflict, Projection,
    SkillCandidate,
};

pub fn preview_first_open(_db: &Database, agents: &[String]) -> Result<FirstOpenPreview, AppError> {
    if agents.is_empty() {
        return Ok(FirstOpenPreview {
            candidates: Vec::new(),
            conflicts: Vec::new(),
        });
    }
    let tokens = parse_agents(agents)?;
    let catalog = load_catalog()?;
    build_first_open_preview(&tokens, &catalog)
}

pub fn open(db: &Database, agents: &[String], skills: &[String]) -> Result<(), AppError> {
    let prev = load_state(db)?;
    if prev.is_open() {
        return Err(AppError::InvalidInput("已开张，不能再次 open".into()));
    }
    if agents.is_empty() {
        return Err(AppError::InvalidInput(
            "open 至少需要一个 --agent / 在用 Agent".into(),
        ));
    }
    let tokens = parse_agents(agents)?;
    let catalog = load_catalog()?;
    let preview = build_first_open_preview(&tokens, &catalog)?;
    if !preview.conflicts.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "第一次确认遇到同名冲突: {}",
            preview
                .conflicts
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }

    let wanted: HashSet<&str> = skills.iter().map(String::as_str).collect();
    if skills
        .iter()
        .any(|name| !preview.candidates.iter().any(|c| c.name == *name))
    {
        return Err(AppError::InvalidInput(
            "open --skill 必须来自第一次候选".into(),
        ));
    }

    let selected: Vec<SkillCandidate> = preview
        .candidates
        .into_iter()
        .filter(|c| wanted.is_empty() || wanted.contains(c.name.as_str()))
        .collect();
    let selected = if wanted.is_empty() {
        Vec::new()
    } else {
        selected
    };

    let mut next = ControlState {
        in_use_agents: tokens.iter().map(|t| t.as_str().to_string()).collect(),
        follow_catalog: true,
        catalog_ref: CatalogRef {
            repo: catalog.repo.clone(),
            revision: catalog.revision.clone(),
        },
        library: Vec::new(),
    };

    let scan = scan_field_skills(&tokens)?;
    let result = (|| {
        for cand in &selected {
            let src = resolve_open_source(cand, &scan, &catalog)?;
            ingest_skill(&src, &cand.name)?;
            let hash = content_hash(&library_skill_dir(&cand.name)?)?;
            next.library.push(LibraryEntry {
                name: cand.name.clone(),
                provenance: cand.provenance.clone(),
                content_hash: hash,
                catalog_revision: if cand.provenance == "catalog-managed" {
                    Some(catalog.revision.clone())
                } else {
                    None
                },
            });
        }
        project_all(&next)?;
        save_state(db, &next)?;
        write_marker(&next)?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = rollback_open(db, &selected);
        return Err(err);
    }
    Ok(())
}

pub fn install(db: &Database, names: &[String]) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let catalog = load_catalog()?;
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        for name in names {
            let name = sanitize_skill_name(name)?;
            let skill = catalog
                .get(&name)
                .ok_or_else(|| AppError::InvalidInput(format!("货架没有技能 {name}")))?;
            let src = catalog.source_dir(skill)?;
            reject_local_draft_overwrite(&state, &name, &src)?;
            ingest_skill(&src, &name)?;
            let hash = content_hash(&library_skill_dir(&name)?)?;
            upsert_library(
                &mut state,
                LibraryEntry {
                    name,
                    provenance: "catalog-managed".into(),
                    content_hash: hash,
                    catalog_revision: Some(catalog.revision.clone()),
                },
            );
        }
        state.catalog_ref = CatalogRef {
            repo: catalog.repo.clone(),
            revision: catalog.revision.clone(),
        };
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn uninstall(db: &Database, names: &[String]) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        for name in names {
            let name = sanitize_skill_name(name)?;
            remove_projections_for_skill(&state, &name)?;
            if let Ok(dir) = library_skill_dir(&name) {
                if dir.exists() {
                    fs::remove_dir_all(&dir).map_err(|e| AppError::io(&dir, e))?;
                }
            }
            state.library.retain(|s| s.name != name);
        }
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn import_paths(db: &Database, paths: &[PathBuf]) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        for path in paths {
            if !path.join("SKILL.md").is_file() {
                return Err(AppError::InvalidInput(format!(
                    "导入路径缺少 SKILL.md: {}",
                    path.display()
                )));
            }
            let name = sanitize_skill_name(
                path.file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| AppError::InvalidInput("导入路径无效".into()))?,
            )?;
            ingest_skill(path, &name)?;
            let hash = content_hash(&library_skill_dir(&name)?)?;
            upsert_library(
                &mut state,
                LibraryEntry {
                    name,
                    provenance: "local-draft".into(),
                    content_hash: hash,
                    catalog_revision: None,
                },
            );
        }
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn agents_add(db: &Database, token: &str) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let parsed = AgentToken::parse(token)?;
    if state.in_use_agents.iter().any(|a| a == parsed.as_str()) {
        return Ok(());
    }
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        state.in_use_agents.push(parsed.as_str().to_string());
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn agents_remove(db: &Database, token: &str) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let parsed = AgentToken::parse(token)?;
    state.in_use_agents.retain(|a| a != parsed.as_str());
    if state.in_use_agents.is_empty() {
        let closed = ControlState::closed();
        save_state(db, &closed)?;
        clear_marker()?;
        return Ok(());
    }
    save_state(db, &state)?;
    write_marker(&state)?;
    Ok(())
}

pub fn follow_catalog(db: &Database, on: bool) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    state.follow_catalog = on;
    save_state(db, &state)?;
    write_marker(&state)?;
    Ok(())
}

pub fn sync(db: &Database, check: bool) -> Result<DoctorReport, AppError> {
    if check {
        return doctor(db);
    }
    let mut state = require_open(db)?;
    let catalog = load_catalog()?;
    let snapshot = snapshot_library(&state)?;
    let result: Result<(), AppError> = (|| {
        if state.follow_catalog {
            apply_catalog_updates(&mut state, &catalog, None)?;
        }
        state.catalog_ref.repo = catalog.repo.clone();
        if state.follow_catalog {
            state.catalog_ref.revision = catalog.revision.clone();
        }
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result?;
    doctor(db)
}

pub fn upgrade(db: &Database, name: Option<String>) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let catalog = load_catalog()?;
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        apply_catalog_updates(&mut state, &catalog, name.as_deref())?;
        state.catalog_ref.repo = catalog.repo.clone();
        state.catalog_ref.revision = catalog.revision.clone();
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn save_local_draft(db: &Database, name: &str, body: &str) -> Result<(), AppError> {
    let mut state = require_open(db)?;
    let entry = state
        .library
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| AppError::InvalidInput(format!("库里没有 {name}")))?
        .clone();
    if entry.provenance != "local-draft" {
        return Err(AppError::InvalidInput(
            "catalog-managed 只读，不能走 local-draft 存盘".into(),
        ));
    }
    let dir = library_skill_dir(name)?;
    let skill_md = dir.join("SKILL.md");
    let backup = fs::read(&skill_md).map_err(|e| AppError::io(&skill_md, e))?;
    let snapshot = snapshot_library(&state)?;
    let result = (|| {
        fs::write(
            &skill_md,
            format!("---\nname: {name}\ndescription: {body}\n---\n{body}\n"),
        )
        .map_err(|e| AppError::io(&skill_md, e))?;
        let hash = content_hash(&dir)?;
        if let Some(slot) = state.library.iter_mut().find(|s| s.name == name) {
            slot.content_hash = hash;
        }
        project_all(&state)?;
        save_state(db, &state)?;
        write_marker(&state)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::write(&skill_md, backup);
        restore_snapshot(db, snapshot)?;
    }
    result
}

pub fn doctor(db: &Database) -> Result<DoctorReport, AppError> {
    let state = load_state(db)?;
    let catalog = load_catalog().unwrap_or_else(|_| LoadedCatalog::empty());
    let open = state.is_open();
    let library = if open {
        state
            .library
            .iter()
            .map(|s| LibrarySkill {
                name: s.name.clone(),
                provenance: s.provenance.clone(),
                behind_catalog: is_behind(s, &catalog),
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut projections = Vec::new();
    let mut foreign = Vec::new();
    let mut broken = Vec::new();
    let mut duplicate = Vec::new();
    if open {
        inspect_runtime(
            &state,
            &mut projections,
            &mut foreign,
            &mut broken,
            &mut duplicate,
        )?;
    }

    let marker_ok = super::state::marker_path().is_file();
    let legacy_writers_stopped = if marker_ok && open {
        state.in_use_agents.clone()
    } else {
        Vec::new()
    };

    Ok(DoctorReport {
        schema: 1,
        open,
        follow_catalog: if open { state.follow_catalog } else { true },
        catalog_ref: if open {
            state.catalog_ref
        } else {
            CatalogRef {
                repo: catalog.repo,
                revision: catalog.revision,
            }
        },
        in_use_agents: if open {
            state.in_use_agents
        } else {
            Vec::new()
        },
        library,
        projections,
        foreign,
        broken,
        duplicate,
        legacy_writers_stopped,
        reload: Vec::new(),
    })
}

pub fn doctor_json(db: &Database) -> Result<String, AppError> {
    let report = doctor(db)?;
    serde_json::to_string_pretty(&report).map_err(|e| AppError::JsonSerialize { source: e })
}

fn build_first_open_preview(
    tokens: &[AgentToken],
    catalog: &LoadedCatalog,
) -> Result<FirstOpenPreview, AppError> {
    let field = scan_field_skills(tokens)?;
    let mut conflicts = Vec::new();
    let mut candidates = Vec::new();

    if field.is_empty() {
        for skill in catalog.recommended() {
            let Ok(name) = sanitize_skill_name(&skill.name) else {
                continue;
            };
            candidates.push(SkillCandidate {
                name,
                provenance: "catalog-managed".into(),
            });
        }
        return Ok(FirstOpenPreview {
            candidates,
            conflicts,
        });
    }

    for (name, hashes) in &field {
        let unique: HashSet<&String> = hashes.iter().map(|(_, h)| h).collect();
        if unique.len() > 1 {
            conflicts.push(NameConflict { name: name.clone() });
            continue;
        }
        candidates.push(SkillCandidate {
            name: name.clone(),
            provenance: "local-draft".into(),
        });
    }
    Ok(FirstOpenPreview {
        candidates,
        conflicts,
    })
}

fn scan_field_skills(
    tokens: &[AgentToken],
) -> Result<BTreeMap<String, Vec<(PathBuf, String)>>, AppError> {
    let mut found: BTreeMap<String, Vec<(PathBuf, String)>> = BTreeMap::new();
    for token in tokens {
        for root in scan_roots(*token)? {
            if !root.is_dir() {
                continue;
            }
            for entry in fs::read_dir(&root).map_err(|e| AppError::io(&root, e))? {
                let entry = entry.map_err(|e| AppError::io(&root, e))?;
                let path = entry.path();
                if !path.join("SKILL.md").is_file() {
                    continue;
                }
                let raw_name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                let Ok(name) = sanitize_skill_name(raw_name) else {
                    continue;
                };
                let hash = content_hash(&path)?;
                found.entry(name).or_default().push((path, hash));
            }
        }
    }
    Ok(found)
}

fn scan_roots(token: AgentToken) -> Result<Vec<PathBuf>, AppError> {
    match token {
        AgentToken::ClaudeCursor => {
            let cursor = cursor_skills_dir();
            let claude = claude_skills_root()?;
            if is_dir_symlink_to(&claude, &cursor) {
                Ok(vec![cursor])
            } else {
                Ok(vec![cursor, claude])
            }
        }
        other => Ok(vec![other.projection_root()?]),
    }
}

fn resolve_open_source(
    cand: &SkillCandidate,
    field: &BTreeMap<String, Vec<(PathBuf, String)>>,
    catalog: &LoadedCatalog,
) -> Result<PathBuf, AppError> {
    if cand.provenance == "catalog-managed" {
        let skill = catalog
            .get(&cand.name)
            .ok_or_else(|| AppError::InvalidInput(format!("货架没有 {}", cand.name)))?;
        return catalog.source_dir(skill);
    }
    field
        .get(&cand.name)
        .and_then(|v| v.first())
        .map(|(p, _)| p.clone())
        .ok_or_else(|| AppError::InvalidInput(format!("现场没有 {}", cand.name)))
}

fn ingest_skill(src: &Path, name: &str) -> Result<(), AppError> {
    let name = sanitize_skill_name(name)?;
    let dest = library_skill_dir(&name)?;
    if let (Ok(src_real), Ok(dest_real)) = (fs::canonicalize(src), fs::canonicalize(&dest)) {
        if src_real == dest_real {
            return Ok(());
        }
    }
    let staging = dest.with_file_name(format!(".{name}.ingesting"));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| AppError::io(&staging, e))?;
    }
    copy_dir(src, &staging)?;
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| AppError::io(&dest, e))?;
    }
    fs::rename(&staging, &dest).map_err(|e| AppError::io(&dest, e))
}

fn reject_local_draft_overwrite(
    state: &ControlState,
    name: &str,
    incoming: &Path,
) -> Result<(), AppError> {
    let Some(existing) = state.library.iter().find(|s| s.name == name) else {
        return Ok(());
    };
    if existing.provenance != "local-draft" {
        return Ok(());
    }
    let dest = library_skill_dir(name)?;
    if !dest.exists() {
        return Ok(());
    }
    let current = content_hash(&dest)?;
    let incoming_hash = content_hash(incoming)?;
    if current != incoming_hash {
        return Err(AppError::InvalidInput(format!(
            "货架不得静默覆盖 local-draft: {name}"
        )));
    }
    Ok(())
}

fn library_root() -> Result<PathBuf, AppError> {
    SkillService::get_ssot_dir().map_err(|e| AppError::Message(e.to_string()))
}

fn library_skill_dir(name: &str) -> Result<PathBuf, AppError> {
    Ok(library_root()?.join(sanitize_skill_name(name)?))
}

fn project_all(state: &ControlState) -> Result<(), AppError> {
    for token_s in &state.in_use_agents {
        let token = AgentToken::parse(token_s)?;
        match token {
            AgentToken::ClaudeCursor => project_claude_cursor(state)?,
            other => {
                let root = other.projection_root()?;
                fs::create_dir_all(&root).map_err(|e| AppError::io(&root, e))?;
                for skill in &state.library {
                    let dest = root.join(&skill.name);
                    let src = library_skill_dir(&skill.name)?;
                    replace_with_symlink(&dest, &src)?;
                }
            }
        }
    }
    Ok(())
}

fn project_claude_cursor(state: &ControlState) -> Result<(), AppError> {
    let cursor = cursor_skills_dir();
    fs::create_dir_all(&cursor).map_err(|e| AppError::io(&cursor, e))?;
    for skill in &state.library {
        let dest = cursor.join(&skill.name);
        let src = library_skill_dir(&skill.name)?;
        replace_with_symlink(&dest, &src)?;
    }
    let claude = claude_skills_root()?;
    if is_dir_symlink_to(&claude, &cursor) {
        return Ok(());
    }
    if claude.exists() {
        let meta = fs::symlink_metadata(&claude).map_err(|e| AppError::io(&claude, e))?;
        if meta.file_type().is_symlink() {
            remove_dir_symlink(&claude)?;
        } else if meta.is_dir() {
            let owned: HashSet<_> = state.library.iter().map(|s| s.name.as_str()).collect();
            for entry in fs::read_dir(&claude).map_err(|e| AppError::io(&claude, e))? {
                let entry = entry.map_err(|e| AppError::io(&claude, e))?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !owned.contains(name.as_ref()) {
                    return Err(AppError::InvalidInput(format!(
                        "Claude skills 根含外来物，拒绝替换为 symlink: {name}"
                    )));
                }
            }
            fs::remove_dir_all(&claude).map_err(|e| AppError::io(&claude, e))?;
        } else {
            return Err(AppError::InvalidInput(format!(
                "Claude skills 根被占用: {}",
                claude.display()
            )));
        }
    } else if let Some(parent) = claude.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    symlink_dir(&cursor, &claude)
}

fn remove_projections_for_skill(state: &ControlState, name: &str) -> Result<(), AppError> {
    for token_s in &state.in_use_agents {
        let token = AgentToken::parse(token_s)?;
        let dest = match token {
            AgentToken::ClaudeCursor => cursor_skills_dir().join(name),
            other => other.projection_root()?.join(name),
        };
        if dest.symlink_metadata().is_ok() {
            let meta = fs::symlink_metadata(&dest).map_err(|e| AppError::io(&dest, e))?;
            if meta.file_type().is_symlink() {
                remove_dir_symlink(&dest)?;
            }
        }
    }
    Ok(())
}

fn apply_catalog_updates(
    state: &mut ControlState,
    catalog: &LoadedCatalog,
    only: Option<&str>,
) -> Result<(), AppError> {
    let names: Vec<String> = state
        .library
        .iter()
        .filter(|s| s.provenance == "catalog-managed")
        .filter(|s| only.map(|n| n == s.name).unwrap_or(true))
        .filter(|s| is_behind(s, catalog))
        .map(|s| s.name.clone())
        .collect();
    if names.is_empty() && only.is_some() {
        if let Some(name) = only {
            if !state.library.iter().any(|s| s.name == name) {
                return Err(AppError::InvalidInput(format!("库里没有 {name}")));
            }
        }
    }
    for name in &names {
        let Some(entry) = state.library.iter().find(|s| s.name == *name) else {
            continue;
        };
        let dir = library_skill_dir(name)?;
        if dir.exists() {
            let disk = content_hash(&dir)?;
            if disk != entry.content_hash {
                return Err(AppError::InvalidInput(format!(
                    "catalog-managed 副本被改脏，拒绝覆盖: {name}"
                )));
            }
        }
        let skill = catalog
            .get(name)
            .ok_or_else(|| AppError::InvalidInput(format!("货架没有 {name}")))?;
        let src = catalog.source_dir(skill)?;
        ingest_skill(&src, name)?;
        let hash = content_hash(&library_skill_dir(name)?)?;
        if let Some(slot) = state.library.iter_mut().find(|s| s.name == *name) {
            slot.content_hash = hash;
            slot.catalog_revision = Some(catalog.revision.clone());
        }
    }
    Ok(())
}

fn is_behind(entry: &LibraryEntry, catalog: &LoadedCatalog) -> bool {
    if entry.provenance != "catalog-managed" {
        return false;
    }
    let Some(skill) = catalog.get(&entry.name) else {
        return false;
    };
    if entry.catalog_revision.as_deref() != Some(catalog.revision.as_str()) {
        return true;
    }
    match catalog.source_dir(skill) {
        Ok(src) => content_hash(&src)
            .map(|h| h != entry.content_hash)
            .unwrap_or(true),
        Err(_) => true,
    }
}

fn inspect_runtime(
    state: &ControlState,
    projections: &mut Vec<Projection>,
    foreign: &mut Vec<String>,
    broken: &mut Vec<String>,
    duplicate: &mut Vec<String>,
) -> Result<(), AppError> {
    let lib_names: HashSet<_> = state.library.iter().map(|s| s.name.as_str()).collect();
    for token_s in &state.in_use_agents {
        let token = AgentToken::parse(token_s)?;
        let roots = match token {
            AgentToken::ClaudeCursor => vec![cursor_skills_dir()],
            other => vec![other.projection_root()?],
        };
        let mut aligned = 0usize;
        let mut desc_chars = 0usize;
        let mut seen = HashSet::new();
        for root in roots {
            if !root.exists() {
                continue;
            }
            for entry in fs::read_dir(&root).map_err(|e| AppError::io(&root, e))? {
                let entry = entry.map_err(|e| AppError::io(&root, e))?;
                let path = entry.path();
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                if !seen.insert(name.clone()) {
                    duplicate.push(format!("{token_s}/{name}"));
                }
                let meta = match fs::symlink_metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.file_type().is_symlink() && fs::canonicalize(&path).is_err() {
                    broken.push(path.display().to_string());
                    continue;
                }
                if lib_names.contains(name.as_str()) {
                    aligned += 1;
                    if let Ok(md) = fs::read_to_string(path.join("SKILL.md")) {
                        desc_chars += md.chars().count();
                    }
                } else if path.join("SKILL.md").is_file() {
                    foreign.push(format!("{token_s}/{name}"));
                }
            }
        }
        projections.push(Projection {
            agent: token_s.clone(),
            aligned: aligned == state.library.len(),
            skill_count: aligned,
            description_chars: desc_chars,
        });
    }
    Ok(())
}

#[derive(Clone)]
struct LibrarySnapshot {
    state: ControlState,
    dirs: BTreeMap<String, Option<PathBuf>>,
}

fn snapshot_library(state: &ControlState) -> Result<LibrarySnapshot, AppError> {
    let mut dirs = BTreeMap::new();
    for skill in &state.library {
        let src = library_skill_dir(&skill.name)?;
        if src.exists() {
            let backup = std::env::temp_dir().join(format!(
                "cc-switch-skills-snap-{}-{}",
                std::process::id(),
                skill.name
            ));
            if backup.exists() {
                fs::remove_dir_all(&backup).map_err(|e| AppError::io(&backup, e))?;
            }
            copy_dir(&src, &backup)?;
            dirs.insert(skill.name.clone(), Some(backup));
        } else {
            dirs.insert(skill.name.clone(), None);
        }
    }
    Ok(LibrarySnapshot {
        state: state.clone(),
        dirs,
    })
}

fn restore_snapshot(db: &Database, snapshot: LibrarySnapshot) -> Result<(), AppError> {
    if let Ok(root) = library_root() {
        if root.is_dir() {
            for entry in fs::read_dir(&root).map_err(|e| AppError::io(&root, e))? {
                let entry = entry.map_err(|e| AppError::io(&root, e))?;
                let name = entry.file_name().to_string_lossy().to_string();
                if !snapshot.dirs.contains_key(&name) && entry.path().is_dir() {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    for (name, backup) in snapshot.dirs {
        let dest = library_skill_dir(&name)?;
        if dest.exists() {
            let _ = fs::remove_dir_all(&dest);
        }
        if let Some(backup) = backup {
            let _ = copy_dir(&backup, &dest);
            let _ = fs::remove_dir_all(&backup);
        }
    }
    save_state(db, &snapshot.state)?;
    write_marker(&snapshot.state)?;
    let _ = project_all(&snapshot.state);
    Ok(())
}

fn rollback_open(db: &Database, selected: &[SkillCandidate]) -> Result<(), AppError> {
    for cand in selected {
        if let Ok(dir) = library_skill_dir(&cand.name) {
            if dir.exists() {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }
    let closed = ControlState::closed();
    save_state(db, &closed)?;
    clear_marker()?;
    Ok(())
}

fn upsert_library(state: &mut ControlState, entry: LibraryEntry) {
    if let Some(slot) = state.library.iter_mut().find(|s| s.name == entry.name) {
        *slot = entry;
    } else {
        state.library.push(entry);
    }
}

fn content_hash(dir: &Path) -> Result<String, AppError> {
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for rel in files {
        let abs = dir.join(&rel);
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update([0]);
        let bytes = fs::read(&abs).map_err(|e| AppError::io(&abs, e))?;
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    if !current.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(|e| AppError::io(current, e))? {
        let entry = entry.map_err(|e| AppError::io(current, e))?;
        let path = entry.path();
        reject_dir_symlink(&path)?;
        if path.is_dir() {
            collect_files(root, &path, out)?;
        } else {
            out.push(path.strip_prefix(root).unwrap_or(&path).to_path_buf());
        }
    }
    Ok(())
}

fn reject_dir_symlink(path: &Path) -> Result<(), AppError> {
    let meta = fs::symlink_metadata(path).map_err(|e| AppError::io(path, e))?;
    if meta.file_type().is_symlink() {
        let target_is_dir = fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        if target_is_dir {
            return Err(AppError::InvalidInput(format!(
                "技能包内含目录 symlink，拒绝: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dest).map_err(|e| AppError::io(dest, e))?;
    for entry in fs::read_dir(src).map_err(|e| AppError::io(src, e))? {
        let entry = entry.map_err(|e| AppError::io(src, e))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        reject_dir_symlink(&from)?;
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| AppError::io(&from, e))?;
        }
    }
    Ok(())
}

fn replace_with_symlink(dest: &Path, src: &Path) -> Result<(), AppError> {
    if dest.exists() || dest.symlink_metadata().is_ok() {
        let meta = fs::symlink_metadata(dest).map_err(|e| AppError::io(dest, e))?;
        if meta.file_type().is_symlink() {
            remove_dir_symlink(dest)?;
        } else if meta.is_dir() {
            let dest_hash = content_hash(dest)?;
            let src_hash = content_hash(src)?;
            if dest_hash == src_hash {
                fs::remove_dir_all(dest).map_err(|e| AppError::io(dest, e))?;
            } else {
                return Err(AppError::InvalidInput(format!(
                    "投影目标是外来目录，拒绝覆盖: {}",
                    dest.display()
                )));
            }
        } else {
            return Err(AppError::InvalidInput(format!(
                "投影目标被占用: {}",
                dest.display()
            )));
        }
    } else if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    symlink_dir(src, dest)
}

fn symlink_dir(src: &Path, dest: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(src, dest).map_err(|e| AppError::io(dest, e))
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_dir(src, dest).map_err(|e| AppError::io(dest, e))
    }
}

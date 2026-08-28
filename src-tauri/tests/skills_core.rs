use std::fs;
use std::path::{Path, PathBuf};

use cc_switch_lib::{
    skills_core, AppState, AppType, SkillService, DEFAULT_CATALOG_REPO,
};

#[path = "support.rs"]
mod support;
use support::{create_test_state, ensure_test_home, reset_test_fs, test_mutex};

fn write_skill(dir: &Path, name: &str, body: &str) {
    fs::create_dir_all(dir).expect("create skill dir");
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: {body}\n---\n{body}\n"),
    )
    .expect("write SKILL.md");
}

fn write_catalog(home: &Path, revision: &str, skills: &[(&str, bool, &str)]) -> PathBuf {
    let catalog_dir = home.join("catalog");
    fs::create_dir_all(&catalog_dir).expect("catalog dir");
    let mut yaml = format!("repo: {DEFAULT_CATALOG_REPO}\nrevision: \"{revision}\"\nskills:\n");
    for (name, recommended, body) in skills {
        let skill_dir = catalog_dir.join(name);
        write_skill(&skill_dir, name, body);
        yaml.push_str(&format!(
            "  - name: {name}\n    recommended: {recommended}\n    source:\n      kind: self\n      path: {name}\n"
        ));
    }
    let path = catalog_dir.join("skills.yaml");
    fs::write(&path, yaml).expect("write catalog");
    std::env::set_var("CC_SWITCH_CATALOG", &path);
    path
}

fn marker_path(home: &Path) -> PathBuf {
    home.join(".cc-switch").join("skills-control.json")
}

fn library_dir() -> PathBuf {
    SkillService::get_ssot_dir().expect("ssot")
}

fn read_link(path: &Path) -> PathBuf {
    fs::read_link(path).unwrap_or_else(|e| panic!("read_link {}: {e}", path.display()))
}

fn setup() -> (std::sync::MutexGuard<'static, ()>, PathBuf, AppState) {
    let guard = test_mutex()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    reset_test_fs();
    let home = ensure_test_home().to_path_buf();
    for extra in [".cursor", ".hermes", ".pi", ".agents"] {
        let path = home.join(extra);
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
    }
    std::env::remove_var("CC_SWITCH_CATALOG");
    let state = create_test_state().expect("state");
    (guard, home, state)
}

#[test]
fn closed_shop_rejects_writes_and_allows_readonly() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "a".repeat(40).as_str(), &[("rec-one", true, "rec")]);

    let err = skills_core::install(&db, &["rec-one".into()]).expect_err("install closed");
    assert!(err.to_string().contains("未开张") || err.to_string().contains("closed"));

    assert!(skills_core::import_paths(&db, &[home.join("nope")]).is_err());
    assert!(skills_core::sync(&db, false).is_err());
    assert!(skills_core::upgrade(&db, None).is_err());
    assert!(skills_core::follow_catalog(&db, false).is_err());
    assert!(skills_core::agents_add(&db, "codex").is_err());
    assert!(skills_core::uninstall(&db, &["rec-one".into()]).is_err());

    let report = skills_core::doctor(&db).expect("doctor");
    assert!(!report.open);
    assert!(report.library.is_empty());
    assert!(report.in_use_agents.is_empty());
    assert_eq!(report.schema, 1);
    assert!(report.follow_catalog);
    assert_eq!(report.catalog_ref.repo, DEFAULT_CATALOG_REPO);

    skills_core::sync(&db, true).expect("sync --check is readonly");
    assert!(!marker_path(&home).exists());
}

#[test]
fn open_zero_agents_is_rejected_and_does_not_write() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    let err = skills_core::open(&db, &[], &[]).expect_err("zero agents");
    assert!(err.to_string().contains("agent") || err.to_string().contains("在用"));
    assert!(!marker_path(&home).exists());
    assert!(!skills_core::doctor(&db).unwrap().open);
}

#[test]
fn open_writes_marker_and_rejects_second_open() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "b".repeat(40).as_str(), &[("rec-one", true, "rec")]);

    skills_core::open(&db, &["codex".into()], &[]).expect("open empty bench");
    assert!(marker_path(&home).exists());
    let marker: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(marker_path(&home)).unwrap()).unwrap();
    assert_eq!(marker["owner"], "cc-switch");
    assert_eq!(marker["schema"], 1);
    assert_eq!(marker["in_use_agents"][0], "codex");
    assert_eq!(marker["follow_catalog"], true);

    let report = skills_core::doctor(&db).unwrap();
    assert!(report.open);
    assert_eq!(report.in_use_agents, vec!["codex"]);
    assert!(report.library.is_empty());

    assert!(skills_core::open(&db, &["codex".into()], &[]).is_err());
}

#[test]
fn empty_machine_recommended_is_catalog_managed() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(
        &home,
        "c".repeat(40).as_str(),
        &[("rec-one", true, "rec"), ("extra", false, "no")],
    );

    let preview = skills_core::preview_first_open(&db, &["codex".into()]).unwrap();
    assert_eq!(
        preview
            .candidates
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        vec!["rec-one"]
    );
    assert_eq!(preview.candidates[0].provenance, "catalog-managed");

    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();
    let report = skills_core::doctor(&db).unwrap();
    assert_eq!(report.library.len(), 1);
    assert_eq!(report.library[0].name, "rec-one");
    assert_eq!(report.library[0].provenance, "catalog-managed");
    assert!(!report.library.iter().any(|s| s.provenance == "bundled"));

    let dest = SkillService::get_app_skills_dir(&AppType::Codex)
        .unwrap()
        .join("rec-one");
    assert!(dest.exists());
}

#[test]
fn field_skill_is_local_draft_and_not_promoted() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(
        &home,
        "d".repeat(40).as_str(),
        &[("field-one", true, "same-hash-body")],
    );
    write_skill(
        &home.join(".codex").join("skills").join("field-one"),
        "field-one",
        "same-hash-body",
    );

    let preview = skills_core::preview_first_open(&db, &["codex".into()]).unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].provenance, "local-draft");
    assert!(!preview
        .candidates
        .iter()
        .any(|c| c.provenance == "catalog-managed"));

    skills_core::open(&db, &["codex".into()], &["field-one".into()]).unwrap();
    let report = skills_core::doctor(&db).unwrap();
    assert_eq!(report.library[0].provenance, "local-draft");
}

#[test]
fn leftover_library_is_not_a_candidate_and_does_not_block_recommended() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "e".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    write_skill(&library_dir().join("old-lib"), "old-lib", "leftover");

    let preview = skills_core::preview_first_open(&db, &["codex".into()]).unwrap();
    assert!(!preview.candidates.iter().any(|c| c.name == "old-lib"));
    assert!(preview.candidates.iter().any(|c| c.name == "rec-one"));
}

#[test]
fn first_open_same_name_different_hash_fails_closed() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_skill(
        &home.join(".codex").join("skills").join("shared"),
        "shared",
        "codex-copy",
    );
    write_skill(
        &home.join(".gemini").join("skills").join("shared"),
        "shared",
        "gemini-copy",
    );

    let preview =
        skills_core::preview_first_open(&db, &["codex".into(), "gemini".into()]).unwrap();
    assert!(!preview.conflicts.is_empty());

    let err = skills_core::open(
        &db,
        &["codex".into(), "gemini".into()],
        &["shared".into()],
    )
    .expect_err("conflict");
    assert!(err.to_string().contains("冲突") || err.to_string().contains("conflict"));
    assert!(!skills_core::doctor(&db).unwrap().open);
    assert!(!marker_path(&home).exists());
    assert!(!library_dir().join("shared").exists() || {
        // leftover empty/partial must not be a ledger member
        skills_core::doctor(&db).unwrap().library.is_empty()
    });
}

#[test]
fn claude_cursor_projects_cursor_layout_not_claude_per_skill() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_skill(
        &home.join(".cursor").join("skills").join("cc-skill"),
        "cc-skill",
        "cursor-side",
    );
    write_skill(
        &home.join(".claude").join("skills").join("cc-skill"),
        "cc-skill",
        "cursor-side",
    );

    let preview = skills_core::preview_first_open(&db, &["claude-cursor".into()]).unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].name, "cc-skill");

    skills_core::open(&db, &["claude-cursor".into()], &["cc-skill".into()]).unwrap();

    let cursor_skill = home.join(".cursor").join("skills").join("cc-skill");
    let lib = library_dir().join("cc-skill");
    assert_eq!(
        read_link(&cursor_skill).canonicalize().unwrap(),
        lib.canonicalize().unwrap()
    );

    let claude_root = SkillService::get_app_skills_dir(&AppType::Claude).unwrap();
    let claude_meta = fs::symlink_metadata(&claude_root).unwrap();
    assert!(
        claude_meta.file_type().is_symlink(),
        "claude skills root must be a directory symlink, not a per-skill write target"
    );
    assert_eq!(
        read_link(&claude_root).canonicalize().unwrap(),
        home.join(".cursor").join("skills").canonicalize().unwrap()
    );
}

#[test]
fn close_shop_clears_ledger_keeps_links_and_blocks_agents_add() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "f".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();

    let dest = SkillService::get_app_skills_dir(&AppType::Codex)
        .unwrap()
        .join("rec-one");
    assert!(dest.exists());

    skills_core::agents_remove(&db, "codex").unwrap();
    let report = skills_core::doctor(&db).unwrap();
    assert!(!report.open);
    assert!(report.library.is_empty());
    assert!(!marker_path(&home).exists() || {
        let raw = fs::read_to_string(marker_path(&home)).unwrap_or_default();
        raw.trim().is_empty()
            || serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .map(|v| v.get("in_use_agents").and_then(|a| a.as_array()).map(|a| a.is_empty()).unwrap_or(true))
                .unwrap_or(true)
    });
    assert!(dest.exists(), "关张不拆链接");

    assert!(skills_core::agents_add(&db, "codex").is_err());
    assert!(skills_core::install(&db, &["rec-one".into()]).is_err());

    let leftover = library_dir().join("rec-one");
    assert!(leftover.exists(), "旧库文件可留盘");
    write_skill(&library_dir().join("ghost"), "ghost", "not-a-candidate");
    let preview = skills_core::preview_first_open(&db, &["gemini".into()]).unwrap();
    assert!(
        !preview.candidates.iter().any(|c| c.name == "ghost"),
        "关张后旧库目录不当候选"
    );
    assert!(
        preview
            .candidates
            .iter()
            .any(|c| c.name == "rec-one" && c.provenance == "catalog-managed"),
        "空 Agent 仍只走货架 recommended，不读旧库名单"
    );
}

#[test]
fn reopen_treats_remaining_links_as_field_drafts() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "g".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();
    skills_core::agents_remove(&db, "codex").unwrap();

    let preview = skills_core::preview_first_open(&db, &["codex".into()]).unwrap();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(preview.candidates[0].name, "rec-one");
    assert_eq!(preview.candidates[0].provenance, "local-draft");
}

#[test]
fn install_and_import_are_all_or_nothing() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(
        &home,
        "h".repeat(40).as_str(),
        &[("ok-skill", true, "ok"), ("missing-src", true, "ms")],
    );
    fs::remove_dir_all(home.join("catalog").join("missing-src")).unwrap();
    skills_core::open(&db, &["codex".into()], &[]).unwrap();

    assert!(skills_core::install(&db, &["ok-skill".into(), "missing-src".into()]).is_err());
    let report = skills_core::doctor(&db).unwrap();
    assert!(report.library.is_empty());
    assert!(!library_dir().join("ok-skill").exists());

    let good = home.join("import-good");
    write_skill(&good, "import-good", "ig");
    let bad = home.join("import-bad");
    fs::create_dir_all(&bad).unwrap();
    assert!(skills_core::import_paths(&db, &[good.clone(), bad]).is_err());
    assert!(skills_core::doctor(&db).unwrap().library.is_empty());
    assert!(!library_dir().join("import-good").exists());
}

#[test]
fn follow_catalog_default_on_and_off_skips_upgrade() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    let rev1 = "1".repeat(40);
    write_catalog(&home, &rev1, &[("rec-one", true, "v1")]);
    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();
    assert!(skills_core::doctor(&db).unwrap().follow_catalog);

    write_catalog(&home, &"2".repeat(40), &[("rec-one", true, "v2")]);
    skills_core::follow_catalog(&db, false).unwrap();
    skills_core::sync(&db, false).unwrap();
    let body = fs::read_to_string(library_dir().join("rec-one").join("SKILL.md")).unwrap();
    assert!(body.contains("v1"), "钉死模式 sync 不换版");
    assert!(skills_core::doctor(&db).unwrap().library[0].behind_catalog);

    skills_core::upgrade(&db, Some("rec-one".into())).unwrap();
    let body = fs::read_to_string(library_dir().join("rec-one").join("SKILL.md")).unwrap();
    assert!(body.contains("v2"));
}

#[test]
fn follow_on_sync_upgrades_and_rolls_back_as_one_batch() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(
        &home,
        "3".repeat(40).as_str(),
        &[("keep", true, "v1"), ("boom", true, "v1")],
    );
    skills_core::open(
        &db,
        &["codex".into()],
        &["keep".into(), "boom".into()],
    )
    .unwrap();

    write_catalog(
        &home,
        "4".repeat(40).as_str(),
        &[("keep", true, "v2"), ("boom", true, "v2")],
    );
    fs::remove_dir_all(home.join("catalog").join("boom")).unwrap();

    assert!(skills_core::sync(&db, false).is_err());
    let keep = fs::read_to_string(library_dir().join("keep").join("SKILL.md")).unwrap();
    assert!(keep.contains("v1"), "自动跟上失败整笔回滚");
}

#[test]
fn local_draft_save_rolls_back_library_on_projection_failure() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    skills_core::open(&db, &["codex".into()], &[]).unwrap();
    let src = home.join("draft-skill");
    write_skill(&src, "draft-skill", "original");
    skills_core::import_paths(&db, &[src]).unwrap();
    assert_eq!(
        skills_core::doctor(&db).unwrap().library[0].provenance,
        "local-draft"
    );

    let dest = SkillService::get_app_skills_dir(&AppType::Codex)
        .unwrap()
        .join("draft-skill");
    fs::remove_file(&dest).ok();
    fs::remove_dir_all(&dest).ok();
    fs::write(&dest, "blocked").unwrap();

    let err = skills_core::save_local_draft(&db, "draft-skill", "changed-body").expect_err("blocked");
    assert!(!err.to_string().is_empty());
    let body = fs::read_to_string(library_dir().join("draft-skill").join("SKILL.md")).unwrap();
    assert!(body.contains("original"), "库内副本必须回滚");
    assert!(!body.contains("changed-body"));
}

#[test]
fn catalog_new_entries_do_not_enter_library_on_sync() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "5".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();
    write_catalog(
        &home,
        "6".repeat(40).as_str(),
        &[("rec-one", true, "rec"), ("new-one", true, "new")],
    );
    skills_core::sync(&db, false).unwrap();
    let names: Vec<_> = skills_core::doctor(&db)
        .unwrap()
        .library
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, vec!["rec-one"]);
}

#[test]
fn doctor_json_fields_are_stable() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "7".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    skills_core::open(&db, &["codex".into()], &["rec-one".into()]).unwrap();
    let json = skills_core::doctor_json(&db).unwrap();
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for key in [
        "schema",
        "open",
        "follow_catalog",
        "catalog_ref",
        "in_use_agents",
        "library",
        "projections",
        "foreign",
        "broken",
        "duplicate",
        "legacy_writers_stopped",
        "reload",
    ] {
        assert!(v.get(key).is_some(), "missing doctor field {key}");
    }
    assert_eq!(v["library"][0]["provenance"], "catalog-managed");
    assert!(v["library"][0].get("behind_catalog").is_some());
    assert_eq!(v["projections"][0]["agent"], "codex");
}

#[test]
fn cli_doctor_and_closed_install_exit_codes() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "8".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    let _ = db;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let code = skills_core::run_cli(
        &["skills".into(), "doctor".into(), "--json".into()],
        &mut stdout,
        &mut stderr,
    );
    assert_eq!(code, 0);
    let v: serde_json::Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(v["open"], false);

    stdout.clear();
    let code = skills_core::run_cli(
        &["skills".into(), "install".into(), "rec-one".into()],
        &mut stdout,
        &mut stderr,
    );
    assert_ne!(code, 0);

    stdout.clear();
    let code = skills_core::run_cli(
        &[
            "skills".into(),
            "open".into(),
            "--agent".into(),
            "codex".into(),
            "--skill".into(),
            "rec-one".into(),
        ],
        &mut stdout,
        &mut stderr,
    );
    assert_eq!(code, 0, "{}", String::from_utf8_lossy(&stderr));
    assert!(skills_core::doctor(&create_test_state().unwrap().db)
        .unwrap()
        .open);
}

#[test]
fn pi_in_use_follows_library() {
    let (_guard, home, state) = setup();
    let db = &*state.db;
    write_catalog(&home, "9".repeat(40).as_str(), &[("rec-one", true, "rec")]);
    skills_core::open(&db, &["pi".into()], &["rec-one".into()]).unwrap();
    let dest = SkillService::get_app_skills_dir(&AppType::Pi)
        .unwrap()
        .join("rec-one");
    assert!(dest.exists());
    assert_eq!(
        read_link(&dest).canonicalize().unwrap(),
        library_dir().join("rec-one").canonicalize().unwrap()
    );
}

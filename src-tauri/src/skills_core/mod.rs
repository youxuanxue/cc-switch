//! CC Switch Skills Core：库 + 在用名单控制面。
//!
//! 施工图：`docs/approved/design-skills-core.md`。

mod agent;
mod catalog;
mod cli;
mod ops;
mod state;

pub use cli::run_cli;
pub use ops::{
    agents_add, agents_remove, doctor, doctor_json, follow_catalog, import_paths, install, open,
    preview_first_open, save_local_draft, sync, uninstall, upgrade,
};
pub use state::{
    CatalogRef, DoctorReport, FirstOpenPreview, LibrarySkill, NameConflict, Projection,
    SkillCandidate, DEFAULT_CATALOG_REPO,
};

# Pinned Git Skill Sources

## Background

The agent-skills catalog delegates host-clean to infra-skills at an exact commit.
Skills Core could previously install only catalog-local sources, leaving an
imported host-clean as a local draft that could not follow catalog updates.

## Delta

- Support `source.kind: git` with an HTTPS GitHub `repo`, full lowercase commit
  `revision`, and repository-relative `path`. Fetch the exact commit into
  `~/.cc-switch/catalog-sources`; validate commit, clean checkout, path containment,
  package symlinks, and the SKILL.md name before installation.
- Use noninteractive Git authentication, with an equivalent GitHub SSH fallback,
  bounded command duration, and atomic cache publication. Never run package hooks.
- Install, initial catalog selection, and upgrades may fetch. Doctor and
  `sync --check` inspect only cached content and report unavailable sources as behind.
- Resolve symlinked catalog paths before resolving local sources. Use catalog Git
  HEAD when its YAML does not specify a top-level revision.
- Explicitly installing a matching local draft promotes it to catalog-managed.
  Different draft content remains protected. Generated `__pycache__` and `.git`
  directories are excluded from package copying and content comparisons.
- Existing transaction rollback, follow-catalog, and per-agent projections apply
  equally to Git sources. A catalog entry never installs itself merely by appearing.

## Scenarios And Validation

`cargo test --manifest-path src-tauri/Cargo.toml --test skills_core` exercises real
offline Git repositories: branch movement cannot change a pin, read-only checks do
not fetch, matching draft promotion, follow-catalog off/on, and rejection of invalid
revisions, escaping paths, missing packages, mismatched names, and symlinks.

# Cursor Official Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add officially supported Cursor Login/User API Key management plus Cursor Agent CLI session indexing, directory grouping, and safe macOS resume to CC Switch without introducing a Project entity or a generic Cursor provider app.

**Architecture:** A Rust Cursor metadata adapter maps `~/.cursor/chats/*/*/meta.json` into the existing `SessionMeta` model and owns deterministic chat-ID deduplication. A separate Cursor Official service owns private local settings, CLI status probing, official-environment isolation, workspace revalidation, and 0700 self-deleting launchers. The renderer consumes narrow Cursor APIs through shared auth, index, resume-state, and delete-capability owners; `SessionManagerPage` remains the composition layer.

**Tech Stack:** Rust 2021, Tauri 2, serde/serde_json, uuid, tempfile, React 18, TypeScript, TanStack Query, Vitest/Testing Library, Playwright, pnpm.

**Spec:** `docs/approved/design-cursor-official-sessions.md`

## Global Constraints

- Do not add Cursor to `AppType`, `APP_IDS`, ProviderManager, Proxy, MCP, Prompt, Skills, SQLite, or provider CRUD.
- Do not add a Project entity, project table, project ID, project CRUD, or worktree lifecycle.
- Map Cursor metadata `cwd` directly to `SessionMeta.projectDir`; keep `sourcePath` and `resumeCommand` absent.
- Support only Cursor Login and Cursor User API Key. Do not add TokenKey, custom Base URL, Desktop BYOK, `agent-local`, or `agent-cli-local`.
- Keep data-source state separate from current-session resume state.
- Derive resume state in this exact order: platform → CLI → workspace → authentication → ready.
- Resume only through the fixed backend-owned shape `agent --workspace <workspace> --resume <chat-id>`; never route Cursor through `launch_session_terminal`.
- On macOS, launcher files must be mode `0700`, self-delete before invoking Cursor, omit secrets from argv/logs/results, and be removed immediately when terminal launch fails.
- Windows/Linux may index Cursor sessions but must expose resume as platform unavailable.
- Store `cursorOfficial.authMode` and `cursorOfficial.userApiKey` only in local `~/.cc-switch/settings.json`; generic settings DTOs must neither return nor overwrite them.
- Save `settings.json` with `config::atomic_write_private`; Unix new and replacement files must end at `0600`.
- Cursor sessions are never deletable in this release. Hide item, group, and batch deletion affordances instead of rendering disabled controls.
- Do not read Cursor transcripts or render transcript/message-count/TOC shells for Cursor.
- Add behavior tests and a mechanical SSOT contract check; the contract check supplements rather than replaces Rust, Vitest, and Playwright coverage.
- Real UI e2e must use Playwright against the actual renderer; injected backend state must cross the Tauri IPC boundary.

---

### Task 0: Establish high-risk Story-to-test traceability

**Files:**
- Create: `.testing/user-stories/index.md`
- Create: `.testing/user-stories/stories/US-001-cursor-session-discovery.md`
- Create: `.testing/user-stories/stories/US-002-cursor-session-resume.md`
- Create: `.testing/user-stories/stories/US-003-cursor-official-auth.md`
- Create: `.testing/user-stories/stories/US-004-cursor-unsupported-capabilities.md`

**Interfaces:**
- The approved design remains the sole product baseline.
- Every Story starts at `Ready`, covers positive, negative, and regression ACs, declares all four risk categories, and binds each AC to exact planned test identifiers plus executable commands.
- The test identifiers recorded in the Stories are implementation contracts; Tasks 1–12 must use them or update the Story in the same commit.

- [x] **Step 1: Write the four Ready Stories and index**

Cover discovery/grouping, safe resume, official authentication, and intentionally unsupported capabilities without introducing a Project entity or expanding Cursor into a generic provider app.

- [x] **Step 2: Review Story coverage against the approved design**

Confirm every completion criterion in design section 13 maps to at least one Story AC, and every Story includes logic-error, behavior-regression, security, and runtime risk treatment or an explicit not-applicable reason.

- [x] **Step 3: Run deterministic Story document checks**

Run:

    rg -n "^# US-|^- Status: Ready$|^## Acceptance Criteria$|^## Linked Tests$" .testing/user-stories
    if rg -n "\\b(TOD[O]|TB[D]|FIXM[E]|PLACEHOLDE[R])\\b" .testing/user-stories docs/superpowers/plans/2026-08-28-cursor-official-sessions.md; then exit 1; fi
    git diff --check
    python3 /Users/feng/Codes/dev-rules/scripts/check_approved_docs.py

Expected: four indexed Stories, no placeholders, no whitespace errors, and the approved design remains valid.

- [x] **Step 4: Run preflight and commit the execution baseline**

Run:

    PREFLIGHT_REPO_ROOT=/Users/feng/Codes/dev/cc-switch-wt-cursor-official-sessions bash /Users/feng/Codes/dev-rules/templates/preflight.sh

Then commit:

    git add .testing/user-stories docs/superpowers/plans/2026-08-28-cursor-official-sessions.md
    git commit -m "docs(cursor): bind approved design to acceptance stories"

---

### Task 1: Make Cursor secrets a private local settings boundary

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/commands/settings.rs`

**Interfaces:**
- Produces: `CursorOfficialAuthMode::{Login, UserApiKey}` serialized as `login | userApiKey`.
- Produces: `CursorOfficialSettings { auth_mode: CursorOfficialAuthMode, user_api_key: Option<String> }`.
- Produces: `get_cursor_official_settings() -> CursorOfficialSettings`.
- Produces: `update_cursor_official_settings(auth_mode, user_api_key) -> Result<(), AppError>` and `clear_cursor_user_api_key() -> Result<(), AppError>`.
- Preserves: generic `get_settings()` returns `cursorOfficial: null/omitted`; generic `save_settings()` always retains the backend value.

- [x] **Step 1: Write failing settings tests**

Add Rust tests proving the frontend copy is redacted, generic save preserves private Cursor settings, omitted keys preserve an existing key, explicit clear removes it, empty replacement is rejected by the service layer, and private file writes replace a pre-existing `0644` file with `0600` content.

```rust
#[test]
fn frontend_settings_omit_cursor_official_credentials() {
    let settings = AppSettings {
        cursor_official: Some(CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some("cursor-secret".into()),
        }),
        ..AppSettings::default()
    };
    let visible = settings_for_frontend(settings);
    assert!(visible.cursor_official.is_none());
}

#[test]
fn generic_save_preserves_backend_owned_cursor_settings() {
    let existing = AppSettings {
        cursor_official: Some(CursorOfficialSettings {
            auth_mode: CursorOfficialAuthMode::UserApiKey,
            user_api_key: Some("cursor-secret".into()),
        }),
        ..AppSettings::default()
    };
    let merged = merge_settings_for_save(AppSettings::default(), &existing);
    assert_eq!(merged.cursor_official, existing.cursor_official);
}
```

- [x] **Step 2: Run the focused Rust tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml frontend_settings_omit_cursor_official_credentials -- --nocapture`

Run: `cargo test --manifest-path src-tauri/Cargo.toml generic_save_preserves_backend_owned_cursor_settings -- --nocapture`

Expected: FAIL because Cursor settings types/fields and redaction/preservation behavior do not exist.

- [x] **Step 3: Implement the minimal private settings model**

Add the enums/struct, an optional `cursor_official` field on `AppSettings`, default it to `None`, normalize empty keys to `None` only when loading legacy data, extract `settings_for_frontend(mut settings: AppSettings)`, and have `get_settings_for_frontend()` call it. Replace the manual truncate/write block with:

```rust
crate::config::atomic_write_private(&path, json.as_bytes())?;
```

In `merge_settings_for_save`, add:

```rust
incoming.cursor_official = existing.cursor_official.clone();
```

Keep specific updates behind `mutate_settings`; reject `Some(key)` when `key.trim().is_empty()` and require callers to use explicit clear.

- [x] **Step 4: Run focused and module tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings:: -- --nocapture`

Expected: PASS; on Unix both newly created and replaced fixture files report `mode & 0o777 == 0o600`.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/commands/settings.rs
git commit -m "feat(cursor): secure official auth settings"
```

### Task 2: Add deterministic Cursor metadata indexing

**Files:**
- Create: `src-tauri/src/session_manager/providers/cursor.rs`
- Modify: `src-tauri/src/session_manager/providers/mod.rs`
- Modify: `src-tauri/src/session_manager/mod.rs`

**Interfaces:**
- Produces: `CursorIndexStatus::{IndexReady, IndexUnavailable { reason: String }}`.
- Produces: `scan_sessions() -> Vec<SessionMeta>` for aggregation.
- Produces: `index_status() -> CursorIndexStatus` using the same layout resolver.
- Produces: `find_session(session_id: &str) -> Result<CursorSessionRecord, String>` using the same scan/dedup function as listing.
- Produces: `CursorSessionRecord { chat_id, title, cwd, created_at_ms, updated_at_ms, metadata_path }` for resume resolution.

- [x] **Step 1: Write failing adapter tests with real temporary directory layouts**

Cover valid mapping, `hasConversation=false`, malformed JSON isolation, invalid UUID directory names, empty/missing `cwd`, missing directories, duplicate chat IDs, equal timestamps, and non-existent/unreadable/unrecognized roots.

```rust
#[test]
fn duplicate_chat_ids_choose_newest_then_lexicographically_smallest_path() {
    let root = tempdir().unwrap();
    write_meta(root.path(), "z-bucket", CHAT_ID, 20, true, "/workspace/z");
    write_meta(root.path(), "a-bucket", CHAT_ID, 20, true, "/workspace/a");
    let records = scan_records_in(root.path()).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].cwd.as_deref(), Some("/workspace/a"));
}

#[test]
fn winning_non_conversation_record_suppresses_older_conversation_record() {
    let root = tempdir().unwrap();
    write_meta(root.path(), "old", CHAT_ID, 10, true, "/workspace/old");
    write_meta(root.path(), "new", CHAT_ID, 20, false, "/workspace/new");
    assert!(scan_records_in(root.path()).unwrap().is_empty());
}
```

- [x] **Step 2: Run adapter tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_manager::providers::cursor::tests -- --nocapture`

Expected: compile failure because the Cursor provider module and interfaces do not exist.

- [x] **Step 3: Implement the scanner and shared resolver**

Walk exactly `<root>/<workspace-bucket>/<chat-id>/meta.json`, require `uuid::Uuid::parse_str(chat_id)`, canonicalize metadata paths for tie-breaking, skip individual read/parse failures, deduplicate before applying the winning record's `hasConversation`, and map records as:

```rust
SessionMeta {
    provider_id: "cursor".into(),
    session_id: record.chat_id.clone(),
    title: record.title.as_deref().map(|s| truncate_summary(s, TITLE_MAX_CHARS)),
    summary: None,
    project_dir: record.cwd.clone(),
    created_at: record.created_at_ms,
    last_active_at: record.updated_at_ms,
    source_path: None,
    resume_command: None,
}
```

Add Cursor as the ninth scoped scan thread. Log an unavailable Cursor index at debug/warn level and return an empty Cursor slice without changing `scan_sessions() -> Vec<SessionMeta>`.

- [x] **Step 4: Add deletion/message dispatch protection tests**

Add tests in `session_manager/mod.rs` asserting `load_messages("cursor", ...)` and `delete_session("cursor", ...)` return `Unsupported provider: cursor` before any filesystem mutation.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture`

Expected: PASS; Cursor sessions have no source or resume command and other provider tests remain green.

- [x] **Step 6: Commit**

```bash
git add src-tauri/src/session_manager/providers/cursor.rs src-tauri/src/session_manager/providers/mod.rs src-tauri/src/session_manager/mod.rs
git commit -m "feat(cursor): index agent sessions"
```

### Task 3: Build the Cursor Official CLI status and environment service

**Files:**
- Create: `src-tauri/src/services/cursor_official.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Interfaces:**
- Produces: `CursorOfficialStatus { installed, version, auth_mode, has_user_api_key, authenticated, account, state, error }` with no key body.
- Produces: `CursorOfficialRuntimeState::{Ready, NeedsLogin, NeedsApiKey, CliMissing, StatusUnavailable}`.
- Produces: `get_status() -> CursorOfficialStatus`.
- Produces testable pure helpers `official_env(auth_mode, key)`, `parse_status_json`, `sanitize_cursor_error`, and command construction through a runner abstraction.

- [x] **Step 1: Write failing service tests**

Use a fake command runner to prove `--version` then `status --format json` order, Login removal of inherited `CURSOR_API_KEY`, User API Key injection through env only, removal of all five non-official endpoint variables, status schema parsing, malformed JSON handling, error redaction/truncation, and DTO serialization without the literal secret.

```rust
#[test]
fn user_api_key_is_env_only_and_official_endpoints_are_removed() {
    let policy = official_env(CursorOfficialAuthMode::UserApiKey, Some("secret-key"));
    assert_eq!(policy.set.get("CURSOR_API_KEY").map(String::as_str), Some("secret-key"));
    assert!(policy.remove.contains(&"CURSOR_API_ENDPOINT"));
    assert!(!build_status_args().iter().any(|arg| arg.contains("secret-key")));
}
```

- [x] **Step 2: Run service tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture`

Expected: compile failure because the service does not exist.

- [x] **Step 3: Implement command discovery, bounded probing, parsing, and redaction**

Resolve the executable without trusting the project working directory: inspect the effective PATH and, on POSIX, fall back to the user's login shell `command -v agent`; canonicalize the selected executable. Run version/status with closed stdin and bounded capture. Apply this exact cleanup set:

```rust
const OFFICIAL_ENV_REMOVALS: [&str; 5] = [
    "CURSOR_API_ENDPOINT",
    "CURSOR_LOCAL_AGENT_BASE_URL",
    "CURSOR_LOCAL_AGENT_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
];
```

Login also removes `CURSOR_API_KEY`; User API Key sets it only through `Command::env`. Return only `email`, `firstName`, and `lastName` as optional display fields; omit access/refresh token booleans and IDs from the renderer DTO.

- [x] **Step 4: Run service tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture`

Expected: PASS and no captured diagnostic string contains the fixture key.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/services/cursor_official.rs src-tauri/src/services/mod.rs
git commit -m "feat(cursor): probe official cli authentication"
```

### Task 4: Add workspace resolution and secure macOS launchers

**Files:**
- Modify: `src-tauri/src/services/cursor_official.rs`
- Modify: `src-tauri/src/session_manager/terminal/mod.rs`

**Interfaces:**
- Produces: `CursorResumeContext::{Ready { workspace: String }, WorkspaceRequired}`.
- Produces: `CursorLaunchResult::{Launched, WorkspaceRequired}`.
- Produces: `get_resume_context(session_id, workspace_override) -> Result<CursorResumeContext, String>`.
- Produces: `launch_session`, `launch_login`, and `launch_login_and_session`.
- Consumes: `cursor::find_session`, private settings, preferred terminal, and the Cursor executable resolver.

- [x] **Step 1: Write failing workspace and launcher tests**

Cover metadata cwd precedence, required workspace, canonical override acceptance, file/missing-path rejection, fixed argv order, login-success chaining, Login/API-key environments, no key in terminal command/result/error, `0700` permissions, self-delete prologue, failed-terminal cleanup, and stale launcher cleanup.

```rust
#[test]
fn resume_argv_is_fixed_and_cannot_accept_renderer_commands() {
    let argv = resume_argv(Path::new("/workspace/app"), CHAT_ID);
    assert_eq!(argv, ["--workspace", "/workspace/app", "--resume", CHAT_ID]);
}

#[cfg(unix)]
#[test]
fn launcher_is_private_and_deletes_itself_before_cursor_runs() {
    let launcher = create_launcher_in(temp.path(), &spec).unwrap();
    assert_eq!(launcher.metadata().unwrap().permissions().mode() & 0o777, 0o700);
    let text = std::fs::read_to_string(&launcher).unwrap();
    assert!(text.find("/bin/rm").unwrap() < text.find("exec ").unwrap());
}
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture`

Expected: FAIL because resume and launcher helpers do not exist.

- [x] **Step 3: Implement canonical workspace resolution**

Re-read and deduplicate metadata on every context/launch request. Prefer a canonical existing metadata `cwd`; otherwise validate the override. Return `WorkspaceRequired` for no path or a path removed after a prior context check, but return an error for an existing non-directory or a canonicalization failure. Validate the UUID before scanning.

- [x] **Step 4: Implement a terminal launcher-path entry point**

Add a narrow terminal helper that receives the already-created launcher path and workspace, maps the existing preferred terminal, and invokes the existing terminal launch code. The command passed to terminals must be only `shell_escape(launcher_path)`; the key and Cursor argv remain inside the private file.

- [x] **Step 5: Implement launcher lifecycle**

Create a random private directory and `cursor-launcher.sh` using `tempfile`, set the directory and file to `0700`, write an `unset` block, optional `export CURSOR_API_KEY=<shell-escaped-key>`, self-delete/rmdir lines, and either:

```sh
exec '<absolute-agent>' --workspace '<workspace>' --resume '<chat-id>'
```

or:

```sh
if '<absolute-agent>' login; then
  exec '<absolute-agent>' --workspace '<workspace>' --resume '<chat-id>'
else
  exit $?
fi
```

Delete the launcher directory immediately when terminal launch returns an error. Before creation, remove only CC Switch-owned launcher directories older than 24 hours whose names match the generated prefix.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture`

Run: `cargo test --manifest-path src-tauri/Cargo.toml session_manager::terminal::tests -- --nocapture`

Expected: PASS on all platforms; macOS-only launch execution remains cfg-gated, while pure launcher tests run on Unix.

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/services/cursor_official.rs src-tauri/src/session_manager/terminal/mod.rs
git commit -m "feat(cursor): resume sessions through private launchers"
```

### Task 5: Expose narrow Cursor Tauri commands

**Files:**
- Create: `src-tauri/src/commands/cursor.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces commands: `get_cursor_official_status`, `update_cursor_official_auth`, `clear_cursor_user_api_key`, `get_cursor_session_index_status`, `get_cursor_session_resume_context`, `launch_cursor_session`, `launch_cursor_login`, `launch_cursor_login_and_session`.
- Command parameters use camelCase names `authMode`, `userApiKey`, `sessionId`, `workspaceOverride`.

- [x] **Step 1: Write failing command-layer tests for validation and serialization**

Factor command input validation into ordinary functions so tests can call them without a Tauri runtime. Assert unknown auth mode and empty key fail, omitted key preserves, clear is explicit, and all launch results serialize to the approved structured states.

- [x] **Step 2: Run command tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::cursor::tests -- --nocapture`

Expected: compile failure because the command module is absent.

- [x] **Step 3: Implement commands and registration**

Use `spawn_blocking` for filesystem/process work. Register all eight commands in `tauri::generate_handler!`; do not register Cursor as an app or provider.

- [x] **Step 4: Run command tests and a compile check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::cursor::tests -- --nocapture`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/commands/cursor.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(cursor): expose official session commands"
```

### Task 6: Add renderer Cursor contracts and shared state owners

**Files:**
- Create: `src/config/cursorCapabilities.ts`
- Create: `src/lib/api/cursor.ts`
- Modify: `src/lib/api/index.ts`
- Create: `src/hooks/useCursorOfficial.ts`
- Create: `src/hooks/useCursorSessionIndex.ts`
- Create: `src/components/sessions/cursorResumeState.ts`
- Create: `tests/config/cursorCapabilities.test.ts`
- Create: `tests/hooks/useCursorOfficial.test.tsx`
- Create: `tests/components/cursorResumeState.test.ts`

**Interfaces:**
- Produces capability values `supported | conditional | unsupported`.
- Produces exact Cursor API DTOs mirroring Rust string states.
- Produces `useCursorOfficial()` as the sole query/mutation owner for status, auth update, key clear, refresh, and login launch.
- Produces `useCursorSessionIndex()` as the sole index-status query owner.
- Produces `deriveCursorResumeState(input) -> platformUnavailable | cliMissing | workspaceRequired | needsLogin | needsApiKey | ready`.

- [x] **Step 1: Write failing capability and resume-priority tests**

Use table-driven literals for every capability and every priority collision, including platform+CLI+workspace+auth all unavailable resolving to `platformUnavailable`.

```ts
expect(
  deriveCursorResumeState({
    isMac: false,
    installed: false,
    workspaceState: "required",
    authMode: "login",
    authenticated: false,
  }),
).toBe("platformUnavailable");
```

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm test:unit -- tests/config/cursorCapabilities.test.ts tests/components/cursorResumeState.test.ts`

Expected: FAIL because modules do not exist.

- [x] **Step 3: Implement API, capability registry, pure resume derivation, and hooks**

Keep secrets only in `cursorApi.updateOfficialAuth({ authMode, userApiKey })`; status DTO exposes only `hasUserApiKey`. Use query keys `['cursor-official-status']` and `['cursor-session-index']`. On mutation success, replace/invalidate the shared status query rather than maintaining component-local copies.

- [x] **Step 4: Write and run hook behavior tests**

Assert status sharing, replacement without key echo, clear, refresh, and login calls. Mock only the IPC API boundary; assert hook-visible state and cache outcomes.

Run: `pnpm test:unit -- tests/hooks/useCursorOfficial.test.tsx`

Expected: PASS after implementation.

- [x] **Step 5: Commit**

```bash
git add src/config/cursorCapabilities.ts src/lib/api/cursor.ts src/lib/api/index.ts src/hooks/useCursorOfficial.ts src/hooks/useCursorSessionIndex.ts src/components/sessions/cursorResumeState.ts tests/config/cursorCapabilities.test.ts tests/hooks/useCursorOfficial.test.tsx tests/components/cursorResumeState.test.ts
git commit -m "feat(cursor): add renderer state owners"
```

### Task 7: Add the shared Cursor Official auth control and Auth Center section

**Files:**
- Create: `src/components/cursor/CursorOfficialAuthControl.tsx`
- Create: `src/components/settings/CursorOfficialAuthSection.tsx`
- Modify: `src/components/settings/AuthCenterPanel.tsx`
- Create: `tests/components/CursorOfficialAuthControl.test.tsx`
- Modify: `tests/components/SettingsDialog.test.tsx`

**Interfaces:**
- `CursorOfficialAuthControl` accepts `variant: 'full' | 'compact'`, optional `onLogin`, and optional `onApiKeyReady`; it always consumes `useCursorOfficial` for auth state/mutations.
- `CursorOfficialAuthSection` only composes heading/icon/copy plus the full shared control.

- [x] **Step 1: Write failing component tests**

Assert Auth Center title is “官方认证中心”, the center-level Beta badge is absent, Cursor section is present, Login is primary, “其他方式” reveals the User API Key field, saved state shows only a mask/`hasUserApiKey`, and capability words (`supported`, `conditional`, `unsupported`) never render.

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm test:unit -- tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx`

Expected: FAIL because Cursor UI and revised header do not exist.

- [x] **Step 3: Implement the shared auth UI**

Render runtime states only. Login mode shows the login button and status; User API Key remains collapsed under “其他方式” until selected/expanded. Clear uses the explicit command. Keep the input value local only until save completes, then clear it and render a masked configured state from `hasUserApiKey`.

- [x] **Step 4: Integrate Auth Center and verify GREEN**

Run: `pnpm test:unit -- tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx`

Expected: PASS and existing Copilot/Codex/xAI sections retain their tests.

- [x] **Step 5: Commit**

```bash
git add src/components/cursor/CursorOfficialAuthControl.tsx src/components/settings/CursorOfficialAuthSection.tsx src/components/settings/AuthCenterPanel.tsx tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx
git commit -m "feat(cursor): add official authentication center"
```

### Task 8: Centralize session delete capability and add Cursor filtering

**Files:**
- Create: `src/components/sessions/sessionCapabilities.ts`
- Modify: `src/components/sessions/SessionItem.tsx`
- Modify: `src/components/sessions/SessionManagerPage.tsx`
- Modify: `src/components/sessions/utils.ts`
- Modify: `tests/components/SessionManagerPage.test.tsx`
- Modify: `tests/components/sessionUtils.test.ts`

**Interfaces:**
- Produces: `isSessionDeletable(session: SessionMeta): boolean`, returning false for Cursor and preserving `Boolean(sourcePath)` for existing providers.
- `SessionItem` receives `showSelectionControl` rather than a disabled-delete interpretation.

- [x] **Step 1: Write failing deletion-visibility tests**

Add Cursor fixtures with no `sourcePath` and assert the Cursor provider filter exists, grouping uses `cwd/projectDir`, single delete is absent, item/group checkboxes are absent, batch mode exits and clears selection when switching to a filter with zero deletable sessions, and existing providers remain deletable.

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm test:unit -- tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts`

Expected: FAIL because Cursor filter and shared capability do not exist and controls are currently disabled rather than hidden.

- [x] **Step 3: Implement the delete-capability owner and wire every consumer**

Replace all direct `Boolean(session.sourcePath)` eligibility decisions in the manager with `isSessionDeletable`. Render item and group checkboxes only when at least one eligible session exists. Render the single delete action only for eligible sessions. Exit selection mode when the selected provider has no deletable sessions; preserve the existing exit control when a search temporarily hides all results.

- [x] **Step 4: Add Cursor provider label/icon/filter**

Add `cursor` to the local `ProviderFilter` union and filter menu, map it to a stable icon name/fallback, and add `apps.cursor` translations later. Do not add it to `APP_IDS` or `AppType`.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm test:unit -- tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/components/sessions/sessionCapabilities.ts src/components/sessions/SessionItem.tsx src/components/sessions/SessionManagerPage.tsx src/components/sessions/utils.ts tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts
git commit -m "feat(cursor): add safe session capability filtering"
```

### Task 9: Add Cursor resume gate and Cursor-specific detail body

**Files:**
- Create: `src/components/sessions/CursorResumeGate.tsx`
- Modify: `src/components/sessions/SessionManagerPage.tsx`
- Modify: `tests/components/SessionManagerPage.test.tsx`
- Create: `tests/components/CursorResumeGate.test.tsx`

**Interfaces:**
- `CursorResumeGate({ session }: { session: SessionMeta })` owns only selected-session override and resume orchestration.
- Consumes: `useCursorOfficial`, `cursorApi.getSessionResumeContext`, `cursorApi.launchSession`, `cursorApi.launchLoginAndSession`, `settingsApi.pickDirectory`, and shared compact `CursorOfficialAuthControl`.

- [x] **Step 1: Write failing resume-gate tests**

Cover ready launch, login-and-continue, API-key save-and-continue, workspace selection/cancel, workspace+auth combination retaining one override, session switch clearing override, CLI/platform/index diagnoses, final `workspaceRequired` returning to directory selection, and technical details collapsed by default.

For the ready path, assert the observable IPC boundary:

```ts
expect(launchSession).toHaveBeenCalledWith({
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceOverride: undefined,
});
expect(launchTerminal).not.toHaveBeenCalled();
```

- [x] **Step 2: Run tests and verify RED**

Run: `pnpm test:unit -- tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx`

Expected: FAIL because Cursor resume composition is absent.

- [x] **Step 3: Implement the gate with fixed priority and override lifecycle**

Fetch resume context by `[sessionId, workspaceOverride]`. On directory cancel, do nothing and show no toast. On valid selection, persist the override in component state, then either launch immediately when auth is ready or render the compact auth remediation. Route Login through `launchLoginAndSession`. After User API Key save, call `launchSession` with the retained override.

- [x] **Step 4: Replace Cursor transcript/detail behavior in the manager**

Disable `useSessionMessagesQuery` for Cursor by passing undefined provider/source. In the selected-session branch, render `CursorResumeGate` instead of generic resume command preview, transcript header, message count, empty transcript state, and TOC. Keep title, directory basename, and last-active time in the main header; move full path, chat ID, and fixed command preview into the gate's collapsed technical details.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm test:unit -- tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx`

Expected: PASS; no call to `get_session_messages` or `launch_session_terminal` occurs for Cursor.

- [x] **Step 6: Commit**

```bash
git add src/components/sessions/CursorResumeGate.tsx src/components/sessions/SessionManagerPage.tsx tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx
git commit -m "feat(cursor): add inline session resume flow"
```

### Task 10: Complete locale coverage and IPC test fixtures

**Files:**
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/ja.json`
- Modify: `tests/config/localeCoverage.test.ts`
- Modify: `tests/msw/state.ts`
- Modify: `tests/msw/handlers.ts`

**Interfaces:**
- Adds `apps.cursor`, `settings.authCenter.cursor*`, and `sessionManager.cursor*` keys with identical interpolation variables in all locales.
- Adds stateful mock Cursor status/index/context/launch handlers without ever storing a literal production-like key in returned DTOs or call records.

- [ ] **Step 1: Write failing locale coverage tests**

Create a Cursor key selection analogous to the Pi coverage test and require all non-English locales to contain every Cursor key and matching interpolation variables.

- [ ] **Step 2: Run locale tests and verify RED**

Run: `pnpm test:unit -- tests/config/localeCoverage.test.ts`

Expected: FAIL with the missing Cursor key list.

- [ ] **Step 3: Add concise runtime-focused copy in four locales**

Include labels for Official Auth Center, Login, Other methods, User API Key, configured mask, CLI missing, status unavailable, index unavailable, choose directory and continue, login and continue, configure and continue, platform unavailable, technical details, local-settings backup boundary, and fixed command labels. Do not expose capability-level words in rendered copy.

- [ ] **Step 4: Extend MSW IPC fixtures and run focused tests**

Run: `pnpm test:unit -- tests/config/localeCoverage.test.ts tests/components/SessionManagerPage.test.tsx tests/components/SettingsDialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/locales/en.json src/i18n/locales/zh.json src/i18n/locales/zh-TW.json src/i18n/locales/ja.json tests/config/localeCoverage.test.ts tests/msw/state.ts tests/msw/handlers.ts
git commit -m "feat(cursor): localize official session flows"
```

### Task 11: Add the Cursor SSOT mechanical contract to preflight

**Files:**
- Create: `scripts/check-cursor-session-ssot.mjs`
- Create: `.preflight/local-lint.conf`
- Create: `tests/scripts/check-cursor-session-ssot.test.ts`

**Interfaces:**
- Script exits 0 for the repository and nonzero with deterministic finding codes for fixture violations.
- Required owner imports: auth consumers import `CursorOfficialAuthControl`/`useCursorOfficial`; resume composition imports `CursorResumeGate`/`deriveCursorResumeState`; delete decisions import `isSessionDeletable`.
- Forbidden Cursor path: no Cursor component/API may call `sessionsApi.launchTerminal` or invoke `launch_session_terminal`.

- [ ] **Step 1: Write failing executable contract tests**

Create temporary fixture trees and run the script as a process. Assert violations for duplicated resume-state derivation, direct `sourcePath` Cursor deletion eligibility, direct auth API use from page components, and generic terminal launch from Cursor code. Assert a conforming fixture exits 0.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test:unit -- tests/scripts/check-cursor-session-ssot.test.ts`

Expected: FAIL because the checker does not exist.

- [ ] **Step 3: Implement the deterministic checker**

Parse imports/calls with bounded source-pattern checks anchored to the named owner files and emit stable codes such as `CURSOR_AUTH_OWNER_BYPASS`, `CURSOR_RESUME_OWNER_BYPASS`, `CURSOR_DELETE_OWNER_BYPASS`, and `CURSOR_GENERIC_TERMINAL_BYPASS`. Accept `--root <path>` for fixture tests; default to repository root.

- [ ] **Step 4: Register the checker in preflight**

Write `.preflight/local-lint.conf` with one command:

```text
node scripts/check-cursor-session-ssot.mjs
```

- [ ] **Step 5: Run checker tests and repository checker**

Run: `pnpm test:unit -- tests/scripts/check-cursor-session-ssot.test.ts`

Run: `node scripts/check-cursor-session-ssot.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-cursor-session-ssot.mjs .preflight/local-lint.conf tests/scripts/check-cursor-session-ssot.test.ts
git commit -m "test(cursor): guard session state owners"
```

### Task 12: Add Playwright real-renderer acceptance coverage

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `playwright.config.ts`
- Create: `tests/e2e/tauriIpcHarness.ts`
- Create: `tests/e2e/cursor-official-sessions.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Adds `pnpm test:e2e` using `playwright test` and Chromium.
- The IPC harness installs `window.__TAURI_INTERNALS__` before renderer modules execute, records command/payload calls, supports event callbacks, and returns stateful command results.
- Test state never records or returns the submitted User API Key body after `update_cursor_official_auth` resolves.

- [ ] **Step 1: Add Playwright and write the failing browser spec**

Install `@playwright/test` as a dev dependency. Drive the full renderer by setting existing localStorage navigation keys before load, then cover Auth Center, Cursor filtering/grouping, ready resume, workspace remediation, login/API-key combinations, hidden transcript/delete/capability labels, and collapsed technical details.

- [ ] **Step 2: Run e2e and verify RED**

Run: `pnpm exec playwright install chromium`

Run: `pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts`

Expected: FAIL until the IPC harness and UI contracts are complete.

- [ ] **Step 3: Implement the Tauri IPC browser harness**

Use `page.addInitScript` to install Tauri metadata, callback registration, event listen/unlisten behavior, and an async `invoke(cmd, payload)` switch. Return safe defaults for normal App bootstrap commands and explicit Cursor fixtures for the acceptance paths. Expose only a sanitized call log to assertions:

```ts
type RecordedInvoke = { command: string; payloadKeys: string[]; payload: unknown };
```

For auth update, record `payloadKeys` and replace `userApiKey` with `"[REDACTED]"` before storage.

- [ ] **Step 4: Make the browser spec GREEN and add CI execution**

Run: `pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts`

Expected: PASS in Chromium against the Vite renderer. Add a frontend CI step that installs Chromium and runs `pnpm test:e2e` after unit/type checks.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml playwright.config.ts tests/e2e/tauriIpcHarness.ts tests/e2e/cursor-official-sessions.spec.ts .github/workflows/ci.yml
git commit -m "test(cursor): cover official sessions in real UI"
```

### Task 13: Run private local smoke probes and full verification

**Files:**
- Modify only if verification exposes a defect in files already owned by Tasks 1–12.

**Interfaces:**
- No login, session resume, session creation, transcript read, or secret output is permitted in smoke probes.

- [ ] **Step 1: Run the safe local CLI probe**

Run `agent --version`. Run `agent status --format json` into a private temporary file and report only exit status, top-level field names, authentication boolean presence, and nested `userInfo` field names; delete the temporary directory afterward.

- [ ] **Step 2: Run the safe local metadata probe**

Scan `/Users/feng/.cursor/chats/*/*/meta.json` and report only counts: files, parse failures, unique/duplicate chat IDs, `hasConversation=true`, missing cwd, and invalid UUIDs. Do not print title, cwd, account details, transcript, or chat ID values.

- [ ] **Step 3: Run focused test suites**

```bash
cargo test --manifest-path src-tauri/Cargo.toml session_manager::providers::cursor::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture
pnpm test:unit -- tests/config/cursorCapabilities.test.ts tests/hooks/useCursorOfficial.test.tsx tests/components/CursorOfficialAuthControl.test.tsx tests/components/cursorResumeState.test.ts tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx tests/config/localeCoverage.test.ts tests/scripts/check-cursor-session-ssot.test.ts
pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Run full mechanical gates**

```bash
pnpm typecheck
pnpm format:check
pnpm test:unit
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
python3 /Users/feng/Codes/dev-rules/scripts/check_approved_docs.py
PREFLIGHT_REPO_ROOT=/Users/feng/Codes/dev/cc-switch-wt-cursor-official-sessions bash /Users/feng/Codes/dev-rules/templates/preflight.sh
```

Expected: all commands exit 0. The approved-doc checker may print the already-approved non-prototype branch notice but must not fail.

- [ ] **Step 5: Run review and fix every actionable finding**

Use `$xj-review` on `origin/main...HEAD`, rerun all affected focused tests after each fix, then rerun Step 4.

- [ ] **Step 6: Commit final verification-only fixes if needed**

```bash
git add -u
git commit -m "fix(cursor): close review findings"
```

Do not create an empty commit when review requires no changes.

# US-003-cursor-official-auth

- ID: US-003
- Title: Use Cursor Official authentication without leaking credentials
- As a: Cursor user who may authenticate by Login or User API Key
- I want: one shared official authentication flow in settings and session recovery
- So that: I can restore sessions without exposing credentials or silently using a third-party endpoint
- Trace: [Approved design sections 4.3, 5, 6, 8.2, 10.4–10.5, 12, and 13](../../../docs/approved/design-cursor-official-sessions.md)
- Risk Focus:
  - 逻辑错误: login and userApiKey modes must have distinct validation, preservation, explicit-clear, status, and launch semantics.
  - 行为回归: the Auth Center and inline resume remediation must share one hook/control/service while existing Copilot, Codex, and xAI auth behavior remains unchanged.
  - 安全问题: the key is local-only, omitted from generic DTOs and sync/database artifacts, written atomically with private permissions, removed from Login environments, and never returned, logged, or placed in argv.
  - 运行时问题: missing CLI, malformed status JSON, failed probes, failed login, and inherited endpoint variables must produce bounded sanitized states without corrupting settings.

## Acceptance Criteria

1. AC-001 (正向): Given the default Login mode, When status is probed, Then CC Switch resolves the official agent executable, runs version then status --format json, removes CURSOR_API_KEY and all non-official endpoint variables, and returns only sanitized runtime/account fields.
2. AC-002 (正向): Given User API Key mode and a non-empty submitted key, When settings are updated or status/resume runs, Then the key is saved only in local settings.json, injected only through CURSOR_API_KEY, never placed in argv, and the renderer receives only hasUserApiKey.
3. AC-003 (正向): Given settings or the inline resume gate renders Cursor authentication, When the user interacts, Then Login is primary, User API Key is under Other methods, saved input is cleared, and both surfaces consume the same state/mutation owner.
4. AC-004 (负向): Given an unknown auth mode, an empty replacement key, or a generic settings save omitting/altering cursorOfficial, When persistence runs, Then invalid input is rejected, explicit clear remains the only clear path, and the backend-owned Cursor settings are preserved.
5. AC-005 (负向): Given settings.json already has mode 0644 or a save is interrupted before replacement, When Cursor settings are saved, Then atomic private write prevents a half file and the resulting Unix file mode is 0600.
6. AC-006 (负向): Given process output contains a configured key or excessive/error text, When status or launch errors are returned, Then the key is redacted, output is bounded, and serialization contains no credential body or private token/ID fields.
7. AC-007 (回归): Given WebDAV/S3, database export/restore, generic settings APIs, and existing Auth Center sections, When Cursor auth is added, Then no Cursor key enters sync/database payloads and existing auth capabilities keep their behavior.

## Assertions

- AC-001 fails if probe order changes, inherited unofficial endpoints remain, or private Cursor token fields reach the DTO.
- AC-002 fails if a key appears in argv, status responses, invoke call records, logs, or any persistence boundary other than local settings.json.
- AC-003 fails if the two UI surfaces fork local auth state or capability-level support words render.
- AC-004 fails if generic settings can overwrite Cursor credentials, omission clears a key, or an empty string is treated as clear.
- AC-005 fails if replacement keeps permissive mode or writes directly into the destination file.
- AC-006 fails if fixture secrets survive sanitization or diagnostics exceed the bounded display contract.
- AC-007 fails if existing backup/auth behavior changes or a synchronized/database artifact contains cursorOfficial credentials.

## Linked Tests

- src-tauri/src/commands/settings.rs::tests::us003_generic_settings_redact_and_preserve_cursor_credentials
- src-tauri/src/settings.rs::tests::us003_sync_and_sql_export_exclude_cursor_official_credentials
- src-tauri/src/settings.rs::tests::us003_private_settings_write_restricts_existing_file_to_0600
- src-tauri/src/services/cursor_official.rs::tests::us003_official_env_isolates_login_and_user_api_key_modes
- src-tauri/src/services/cursor_official.rs::tests::us003_status_dto_redacts_credentials_and_errors
- src-tauri/src/services/cursor_official.rs::tests::us003_status_dto_sanitizes_every_command_derived_display_field
- src-tauri/src/commands/cursor.rs::tests::us003_auth_update_rejects_unknown_mode_and_empty_key
- tests/hooks/useCursorOfficial.test.tsx::US-003 shares Cursor auth state without returning the key
- tests/components/CursorOfficialAuthControl.test.tsx::US-003 keeps Login primary and User API Key secondary
- tests/components/SettingsDialog.test.tsx::US-003 renders Cursor Official in the official authentication center
- tests/msw/cursorFixtures.test.ts::Cursor MSW IPC fixtures never store or return the submitted User API Key body
- tests/e2e/cursor-official-sessions.spec.ts::US-003 manages Cursor Official authentication without key echo

Run:

    cargo test --manifest-path src-tauri/Cargo.toml us003_ -- --nocapture
    pnpm exec vitest run tests/hooks/useCursorOfficial.test.tsx tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx tests/msw/cursorFixtures.test.ts
    pnpm test:e2e tests/e2e/cursor-official-sessions.spec.ts --grep "US-003"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- 2026-08-28 RED: `cargo test --manifest-path src-tauri/Cargo.toml us003_ -- --nocapture` exited 101 because the approved Cursor settings types, field, redaction helper, update helpers, and private path writer did not exist.
- 2026-08-28 RED (security self-review): `cargo test --manifest-path src-tauri/Cargo.toml cursor_official_debug_output_never_contains_the_key -- --nocapture` failed because derived Debug exposed the fixture key.
- 2026-08-28 GREEN (settings slice): `cargo test --manifest-path src-tauri/Cargo.toml settings:: -- --nocapture` passed 18 tests without warnings, including generic DTO/Debug redaction, preservation semantics, and new/replacement Unix mode 0600 assertions.
- 2026-08-28 RED (CLI service): `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture` exited 101 because the runner, official environment, status parser, runtime DTO, and sanitization interfaces did not exist.
- 2026-08-28 RED (runtime hardening): the same suite then exposed blank legacy Key handling and a descendant process surviving output timeout.
- 2026-08-28 GREEN (CLI service): the same command passed 9 tests without warnings, covering command order, bounded execution, official-only environment, safe status schema, remediation states, and credential redaction.
- 2026-08-28 RED (command boundary): `cargo test --manifest-path src-tauri/Cargo.toml commands::cursor::tests -- --nocapture` exited 101 because the narrow auth-mode/key validator did not exist; DTO serialization assertions were already bound to the approved structured states.
- 2026-08-28 GREEN (command boundary): the same command passed 2 tests, `cargo check --manifest-path src-tauri/Cargo.toml` exited 0, and `cargo test --manifest-path src-tauri/Cargo.toml us003_ -- --nocapture` passed all 5 cross-boundary US-003 Rust tests. Eight registered commands now expose only Login/User API Key, redacted status/index/context, and dedicated launch actions.
- 2026-08-28 command gate: Rust formatting, `git diff --check`, and external project preflight exited 0 with only the repository's known integration skips and approved-doc branch warning.
- 2026-08-28 RED (renderer credential cache): the first hook implementation stored the submitted User API Key in TanStack MutationCache; the focused hook test failed after inspecting mutation variables and proved the renderer-level leak.
- 2026-08-28 GREEN (renderer auth owner): `useCursorOfficial.updateAuth` now invokes the IPC boundary directly, stores only the redacted status in QueryCache, and keeps the key out of MutationCache. The 4 hook behavior tests plus `pnpm typecheck` passed.
- 2026-08-28 RED (shared auth UI): the focused component run failed because `CursorOfficialAuthControl` did not exist; the settings integration test also exposed the old “OAuth 认证中心” title, center-level Beta, and missing Cursor section. A separate explicit-clear test failed until the control wired the dedicated clear action.
- 2026-08-28 GREEN (shared auth UI): `pnpm exec vitest run tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx` passed 15 tests. Coverage keeps Login visible as the primary path, places User API Key under “其他方式”, clears submitted input, renders only the configured mask, routes compact continuation callbacks, uses explicit clear, removes the center-level Beta, and preserves existing auth sections through thin composition; `pnpm typecheck` and `git diff --check` exited 0.
- 2026-08-28 RED (locale and IPC fixtures): four locale contract cases failed with the missing Cursor key set; the Cursor IPC fixture test then failed because state setters and the `update_cursor_official_auth` MSW handler did not exist.
- 2026-08-28 GREEN (locale and IPC fixtures): `pnpm exec vitest run tests/config/localeCoverage.test.ts tests/msw/cursorFixtures.test.ts tests/components/SessionManagerPage.test.tsx tests/components/SettingsDialog.test.tsx` passed 47 tests. Four locales now carry the complete Cursor runtime copy contract, and the stateful `cursorApi → invoke → MSW` fixture immediately redacts `userApiKey` in its recorded call while returning only `hasUserApiKey`. `pnpm typecheck`, targeted Prettier, and `git diff --check` exited 0.
- 2026-08-28 GREEN (real renderer): Playwright opened Settings → Auth, kept Login primary and User API Key under “其他方式”, cleared the submitted input, displayed only the configured mask, and proved the browser IPC call log stores `[REDACTED]` rather than the submitted key body.
- 2026-08-28 RED (review R-001): serialization still exposed the configured User API Key when CLI-derived version or account display fields echoed it.
- 2026-08-28 GREEN (review R-001): the status DTO boundary now compacts whitespace, strictly redacts known secrets, drops blank account fields, and bounds version, account, and error display values. The 16-test Cursor Official service suite exited 0 with no fixture key in serialized output.
- 2026-08-28 FINAL: the private CLI smoke reported Agent CLI version `2026.08.25-3e8eec8`, successful parse/exit status, only top-level and `userInfo` field names, and the presence of the `isAuthenticated` boolean; it emitted no account values or credentials. Vitest passed 1,073/1,073, Cargo passed 2,911 tests with 5 ignored, Playwright passed 5/5, and full type, format, approved-doc, diff, and preflight gates exited 0 before final review.

- Status: Done

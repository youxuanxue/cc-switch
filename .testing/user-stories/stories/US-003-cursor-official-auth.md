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
- src-tauri/src/settings.rs::tests::us003_private_settings_write_restricts_existing_file_to_0600
- src-tauri/src/services/cursor_official.rs::tests::us003_official_env_isolates_login_and_user_api_key_modes
- src-tauri/src/services/cursor_official.rs::tests::us003_status_dto_redacts_credentials_and_errors
- src-tauri/src/commands/cursor.rs::tests::us003_auth_update_rejects_unknown_mode_and_empty_key
- tests/hooks/useCursorOfficial.test.tsx::US-003 shares Cursor auth state without returning the key
- tests/components/CursorOfficialAuthControl.test.tsx::US-003 keeps Login primary and User API Key secondary
- tests/components/SettingsDialog.test.tsx::US-003 renders Cursor Official in the official authentication center
- tests/e2e/cursor-official-sessions.spec.ts::US-003 manages Cursor Official authentication without key echo

Run:

    cargo test --manifest-path src-tauri/Cargo.toml us003_ -- --nocapture
    pnpm test:unit -- tests/hooks/useCursorOfficial.test.tsx tests/components/CursorOfficialAuthControl.test.tsx tests/components/SettingsDialog.test.tsx
    pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts --grep "US-003"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- 2026-08-28 RED: `cargo test --manifest-path src-tauri/Cargo.toml us003_ -- --nocapture` exited 101 because the approved Cursor settings types, field, redaction helper, update helpers, and private path writer did not exist.
- 2026-08-28 RED (security self-review): `cargo test --manifest-path src-tauri/Cargo.toml cursor_official_debug_output_never_contains_the_key -- --nocapture` failed because derived Debug exposed the fixture key.
- 2026-08-28 GREEN (settings slice): `cargo test --manifest-path src-tauri/Cargo.toml settings:: -- --nocapture` passed 18 tests without warnings, including generic DTO/Debug redaction, preservation semantics, and new/replacement Unix mode 0600 assertions.
- Remaining auth service, command, renderer, and e2e evidence is recorded before this Story advances to Done.

- Status: InTest

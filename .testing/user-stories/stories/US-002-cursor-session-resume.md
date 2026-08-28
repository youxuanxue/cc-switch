# US-002-cursor-session-resume

- ID: US-002
- Title: Resume a Cursor session safely in context
- As a: user who has found a prior Cursor session
- I want: one contextual action that resumes it or resolves the next blocking condition inline
- So that: I continue the intended conversation without reconstructing commands or losing the selected session
- Trace: [Approved design sections 4, 8, 10.2–10.3, 11, 12, and 13](../../../docs/approved/design-cursor-official-sessions.md)
- Risk Focus:
  - 逻辑错误: resume state must use platform → CLI → workspace → authentication → ready priority and preserve a selected workspace override only for the current session.
  - 行为回归: Cursor must use dedicated IPC and a fixed agent --workspace … --resume … shape while existing providers keep the generic terminal path.
  - 安全问题: chat IDs and workspace overrides require backend validation; renderer-supplied commands or environment values are never accepted; secrets never enter the terminal command.
  - 运行时问题: workspace paths are revalidated at launch, terminal failures clean private launchers, stale launchers are bounded, and non-macOS platforms index but do not resume.

## Acceptance Criteria

1. AC-001 (正向): Given macOS, an installed/authenticated Cursor CLI, and a valid metadata cwd, When the user chooses Continue session, Then CC Switch launches exactly agent --workspace <canonical-workspace> --resume <chat-id> through the dedicated Cursor backend API.
2. AC-002 (正向): Given the metadata cwd is absent or no longer a directory, When the user chooses Select directory and continue, Then cancel leaves the selected session unchanged, while a valid chosen directory is canonicalized, retained for that session, and used to continue.
3. AC-003 (正向): Given workspace and authentication are both unresolved, When the user selects a valid workspace and completes Login or User API Key remediation, Then the same override and chat ID are used without asking for the directory again.
4. AC-004 (负向): Given an invalid UUID, missing path, file path, non-canonicalizable override, renderer-supplied command, or renderer-supplied environment value, When resume is requested, Then the backend rejects it or returns workspaceRequired without starting a terminal.
5. AC-005 (负向): Given the platform is unsupported, the CLI is missing, authentication is unresolved, or a launch-time workspace recheck fails, When the gate derives its action, Then the highest-priority safe remediation is shown and no lower-priority launch occurs.
6. AC-006 (回归): Given a Cursor session is selected or the selected session changes, When details render, Then Cursor never calls get_session_messages or launch_session_terminal, technical details remain collapsed by default, and stale workspace overrides are cleared on session change.
7. AC-007 (运行时): Given a private launcher is created, When it runs or terminal startup fails, Then it has mode 0700, removes itself before Cursor executes, reveals no key in terminal arguments/results/errors, and is cleaned immediately on launch failure.

## Assertions

- AC-001 fails if argument order changes, the workspace is not canonical, or generic terminal IPC is used.
- AC-002 fails if cancellation emits an error, an invalid path is accepted, or the override is persisted outside the selected gate.
- AC-003 fails if authentication completion loses the selected workspace or resumes a different chat.
- AC-004 fails if arbitrary renderer command/environment data reaches process construction or filesystem validation is skipped.
- AC-005 fails if a lower-priority state masks platform, CLI, or workspace safety.
- AC-006 fails if transcript plumbing runs for Cursor, details open by default, or a previous session's override survives selection change.
- AC-007 fails if launcher permissions, deletion order, cleanup, or credential redaction regress.

## Linked Tests

- src-tauri/src/services/cursor_official.rs::tests::us002_resolves_workspace_and_builds_fixed_resume_argv
- src-tauri/src/services/cursor_official.rs::tests::us002_rejects_invalid_workspace_overrides
- src-tauri/src/services/cursor_official.rs::tests::us002_private_launcher_self_deletes_and_never_exposes_key
- src-tauri/src/services/cursor_official.rs::tests::us002_revalidates_workspace_and_cleans_failed_launch
- tests/components/cursorResumeState.test.ts::US-002 derives resume state in fixed priority order
- tests/components/CursorResumeGate.test.tsx::US-002 resumes a ready session through dedicated Cursor IPC
- tests/components/CursorResumeGate.test.tsx::US-002 retains one workspace override through authentication remediation
- tests/components/CursorResumeGate.test.tsx::US-002 resets workspace override when the selected session changes
- tests/e2e/cursor-official-sessions.spec.ts::US-002 resumes Cursor sessions through inline remediation

Run:

    cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture
    cargo test --manifest-path src-tauri/Cargo.toml session_manager::terminal::tests -- --nocapture
    pnpm test:unit -- tests/components/cursorResumeState.test.ts tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx
    pnpm test:e2e tests/e2e/cursor-official-sessions.spec.ts --grep "US-002"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- 2026-08-28 RED: `cargo test --manifest-path src-tauri/Cargo.toml services::cursor_official::tests -- --nocapture` exited 101 because the approved workspace resolver, fixed resume argv, private launcher lifecycle, lookup revalidation, launch result, and narrow terminal launcher interfaces did not exist.
- 2026-08-28 GREEN (backend resume): the same focused service command passed 15 tests; `cargo test --manifest-path src-tauri/Cargo.toml session_manager::terminal::tests -- --nocapture` passed 11 tests; `cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture` passed 91 tests. Coverage includes canonical metadata/override selection, fixed argv, Login chaining, official environment cleanup, private self-deleting launchers, 24-hour owned-prefix cleanup, TOCTOU revalidation, sanitized terminal failures, and the launcher-path-only terminal boundary.
- 2026-08-28 backend resume gate: Rust formatting, `git diff --check`, `cargo check`, and the external project preflight all exited 0; preflight retained only the repository's known dev-rules integration skips and approved-doc branch warning.
- 2026-08-28 RED (renderer state): the approved `pnpm test:unit -- ...` command exposed a repository script quirk and ran the full Vitest suite; 1,012 existing tests passed while the two new Cursor suites failed only because `cursorCapabilities` and `cursorResumeState` did not exist. Subsequent focused commands use `pnpm exec vitest run <files>`.
- 2026-08-28 GREEN (renderer state): `pnpm exec vitest run tests/hooks/useCursorOfficial.test.tsx tests/config/cursorCapabilities.test.ts tests/components/cursorResumeState.test.ts` passed 7 tests, including the fixed platform → CLI → workspace → authentication → ready priority; `pnpm typecheck`, targeted Prettier, and `git diff --check` exited 0.
- 2026-08-28 RED (inline resume): `pnpm exec vitest run tests/components/CursorResumeGate.test.tsx tests/components/SessionManagerPage.test.tsx` exited 1 because `CursorResumeGate` did not exist and the Cursor detail still lacked the dedicated Continue action. A second focused RED proved that a selected path had to be replaced by the canonical workspace returned from resume-context validation before launch.
- 2026-08-28 GREEN (inline resume): the same focused command passed 31 tests. Coverage includes dedicated ready/Login/User API Key launch IPC, silent directory cancellation, canonical override retention through authentication, per-session override reset, fixed state priority, separate index diagnostics, launch-time `workspaceRequired` recovery, collapsed technical details, and the absence of Cursor message/generic-terminal calls. `pnpm typecheck`, targeted Prettier, and `git diff --check` exited 0.
- 2026-08-28 GREEN (real renderer): Playwright verified one-click ready resume calls only `launch_cursor_session`, while a moved workspace is selected once, canonicalized through resume context, retained through Login remediation, and launched only through `launch_cursor_login_and_session`; no generic terminal IPC is recorded.
- Remaining final full-suite evidence is recorded before this Story advances to Done.

- Status: InTest

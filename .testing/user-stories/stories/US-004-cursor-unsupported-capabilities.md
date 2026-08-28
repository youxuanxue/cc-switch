# US-004-cursor-unsupported-capabilities

- ID: US-004
- Title: Keep unsupported Cursor capabilities absent and explicit
- As a: CC Switch user evaluating Cursor support
- I want: the product to expose only capabilities it can safely and officially deliver
- So that: I am not misled into relying on destructive, private, third-party, or platform-unsupported behavior
- Trace: [Approved design sections 2, 3.2–3.3, 7.4, 9, 10, 12, and 13](../../../docs/approved/design-cursor-official-sessions.md)
- Risk Focus:
  - 逻辑错误: the capability registry must distinguish supported, conditional, and unsupported promises without confusing them with runtime state.
  - 行为回归: Cursor must not enter AppType/provider CRUD or cause existing provider controls to disappear; only Cursor-specific unsupported affordances are absent.
  - 安全问题: Cursor message loading, transcript/source access, deletion, generic terminal commands, custom endpoints, TokenKey, Desktop BYOK, and agent-local paths must remain unreachable.
  - 运行时问题: Windows/Linux may index sessions but must resolve resume to platformUnavailable; missing index and CLI states remain isolated diagnostics.

## Acceptance Criteria

1. AC-001 (正向): Given the static Cursor capability registry, When product code queries it, Then Login, User API Key, and fixed session resume are supported, local indexing is conditional, and transcript preview plus deletion are unsupported.
2. AC-002 (正向): Given a Cursor session on any platform, When the session list renders, Then the Cursor filter and cwd grouping are available while runtime status—not capability vocabulary—is shown to the user.
3. AC-003 (负向): Given a Cursor session, When item, group, selection, detail, and bulk actions render, Then every delete checkbox/action and every transcript/message-count/TOC shell is absent rather than disabled.
4. AC-004 (负向): Given a direct backend request to load Cursor messages or delete a Cursor session, When dispatch runs, Then it returns Unsupported provider: cursor before any filesystem mutation.
5. AC-005 (负向): Given Cursor-specific renderer code, When mechanical contracts run, Then direct auth duplication, local resume-state duplication, sourcePath-based Cursor deletion, and generic launch_session_terminal usage fail with stable finding codes.
6. AC-006 (负向): Given configuration or UI surfaces, When Cursor support is inspected, Then Cursor is absent from AppType, APP_IDS, ProviderManager, Proxy, MCP, Prompt, Skills, SQLite, TokenKey, custom Base URL, Desktop BYOK, agent-local, and agent-cli-local flows.
7. AC-007 (回归): Given existing non-Cursor sessions and Auth Center capabilities, When Cursor support is enabled, Then their provider switching, transcript, resume, deletion, and authentication behavior remains unchanged.
8. AC-008 (运行时): Given Windows or Linux, When Cursor sessions are indexed and selected, Then discovery still works but resume is platformUnavailable and no unsafe command-copy fallback appears.

## Assertions

- AC-001 fails if a support promise drifts or if runtime readiness is stored in the static registry.
- AC-002 fails if capability words render or Cursor is incorrectly registered as a generic app/provider.
- AC-003 fails if any destructive or transcript affordance remains visible for Cursor.
- AC-004 fails if dispatch reaches a Cursor path or filesystem mutation before rejecting the provider.
- AC-005 fails if a page bypasses an auth, resume, or delete owner or uses generic terminal IPC.
- AC-006 fails if an explicitly excluded integration surface gains Cursor entries.
- AC-007 fails on any existing provider/auth behavior regression.
- AC-008 fails if non-macOS resume launches, copies a command, or hides indexed sessions.

## Linked Tests

- tests/config/cursorCapabilities.test.ts::US-004 declares the approved Cursor capability boundaries
- src-tauri/src/session_manager/mod.rs::tests::us004_rejects_cursor_message_loading_and_deletion
- tests/components/SessionManagerPage.test.tsx::US-002/US-004 renders Cursor resume without transcript or generic terminal plumbing
- tests/components/SessionManagerPage.test.tsx::US-004 exposes the Cursor filter while hiding unsupported delete actions
- tests/components/SessionManagerPage.test.tsx::US-004 hides Cursor item and group checkboxes in grouped batch mode
- tests/components/cursorResumeState.test.ts::US-004 blocks Cursor resume outside macOS without blocking indexing
- tests/scripts/check-cursor-session-ssot.test.ts::US-004 rejects Cursor owner and generic-terminal bypasses
- tests/e2e/cursor-official-sessions.spec.ts::US-004 keeps unsupported Cursor capabilities absent from the UI

Run:

    cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture
    pnpm exec vitest run tests/config/cursorCapabilities.test.ts tests/components/cursorResumeState.test.ts tests/components/SessionManagerPage.test.tsx tests/scripts/check-cursor-session-ssot.test.ts
    node scripts/check-cursor-session-ssot.mjs
    pnpm test:e2e tests/e2e/cursor-official-sessions.spec.ts --grep "US-004"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- 2026-08-28 RED context: the Cursor provider test module was introduced with backend message/deletion rejection coverage while discovery interfaces were still absent; the combined focused suite exited 101 on those missing discovery interfaces.
- 2026-08-28 GREEN (backend unsupported paths): `cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture` passed 90 tests, including exact `Unsupported provider: cursor` rejection before message loading or deletion.
- 2026-08-28 RED (capability contract): the full Vitest run kept 1,012 existing tests green and failed the new Cursor capability/resume suites only because their approved SSOT modules did not exist.
- 2026-08-28 GREEN (capability contract): the focused capability and resume-state suites passed 3 tests with literal expectations for supported Login/User API Key/fixed resume, conditional local indexing, unsupported transcript/deletion, and non-macOS `platformUnavailable`; capability vocabulary remains an internal contract only.
- 2026-08-28 GREEN (auth presentation boundary): Auth Center integration coverage asserts that `supported`, `conditional`, and `unsupported` never render while Cursor runtime state and actions remain visible.
- 2026-08-28 RED (delete presentation): the Session Manager tests failed because the Cursor filter and `sessionCapabilities` owner did not exist, and grouped selection rendered disabled Cursor provider/item checkboxes instead of hiding them.
- 2026-08-28 GREEN (delete presentation): `pnpm exec vitest run tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts` passed 31 tests. `isSessionDeletable` rejects Cursor even with a defensive `sourcePath`, every single/item/group/batch delete affordance is absent for Cursor, switching to Cursor exits and clears batch selection, search-only empty results retain the explicit exit control, and existing source-backed providers remain deletable; `pnpm typecheck`, targeted Prettier, and `git diff --check` exited 0.
- 2026-08-28 GREEN (detail boundary): the Cursor-specific detail integration test supplies defensive `sourcePath` and `resumeCommand` values yet renders only `CursorResumeGate`; it does not request messages, show transcript/empty/count/TOC shells, expose the generic command preview, or call `launch_session_terminal`.
- 2026-08-28 RED (mechanical SSOT contract): `pnpm exec vitest run tests/scripts/check-cursor-session-ssot.test.ts` failed all 5 executable fixture cases because `scripts/check-cursor-session-ssot.mjs` did not exist.
- 2026-08-28 GREEN (mechanical SSOT contract): the same command passed 5 tests after the checker gained stable auth, resume, delete, and generic-terminal finding codes. `node scripts/check-cursor-session-ssot.mjs` returned `cursor-session-ssot: PASS` for the real repository, and project preflight executed the same command from `.preflight/local-lint.conf` successfully.
- 2026-08-28 GREEN (real renderer): Playwright confirmed Cursor exposes no delete button, batch-management action, checkbox, transcript/message shell, generic terminal launch, or `supported | conditional | unsupported` label, and keeps technical details collapsed by default.
- 2026-08-28 RED (review R-002/R-004): the checker accepted generic Cursor resume polling and allowed index-status consumption outside the list owner; the real empty-state journey also lacked any index diagnostic.
- 2026-08-28 GREEN (review R-002/R-004): the checker now passes 9 executable fixtures and reports stable `CURSOR_RESUME_OWNER_BYPASS` or `CURSOR_INDEX_OWNER_BYPASS` findings for generic polling, missing list ownership, out-of-owner hook use, or direct index API use. The real repository contract and five browser journeys exit 0.
- 2026-08-28 GREEN (review R-005): all four unused `settings.authCenter.beta` locale entries were removed while the Settings integration test continues to prove that no center-level Beta or capability vocabulary renders.
- 2026-08-28 RED (final review R-002/R-003): 3 of 12 checker tests failed because mixed guarded/unguarded generic resume calls and an unconditional index query were accepted, while sentinel-only changes did not route to the frontend CI job.
- 2026-08-28 GREEN (final review R-002/R-003): the checker validates every relevant call site, the frontend path filter includes both `scripts/check-cursor-session-ssot.mjs` and `.preflight/local-lint.conf`, and the 12-test checker suite plus real repository contract pass.
- 2026-08-28 FINAL: the Cursor SSOT checker remains registered in preflight and CI routing; Vitest excludes the Playwright tree from unit collection. Vitest passed 1,073/1,073, Cargo passed 2,911 tests with 5 ignored, Playwright passed 5/5, and approved-doc, diff, formatting, type, and preflight gates exited 0 before final review.

- Status: Done

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
- tests/components/SessionManagerPage.test.tsx::US-004 hides Cursor transcript and every delete affordance
- tests/components/cursorResumeState.test.ts::US-004 blocks Cursor resume outside macOS without blocking indexing
- tests/scripts/check-cursor-session-ssot.test.ts::US-004 rejects Cursor owner and generic-terminal bypasses
- tests/e2e/cursor-official-sessions.spec.ts::US-004 keeps unsupported Cursor capabilities absent from the UI

Run:

    cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture
    pnpm test:unit -- tests/config/cursorCapabilities.test.ts tests/components/cursorResumeState.test.ts tests/components/SessionManagerPage.test.tsx tests/scripts/check-cursor-session-ssot.test.ts
    node scripts/check-cursor-session-ssot.mjs
    pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts --grep "US-004"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- Execution evidence is recorded when the Story advances to InTest and Done.

- Status: Ready

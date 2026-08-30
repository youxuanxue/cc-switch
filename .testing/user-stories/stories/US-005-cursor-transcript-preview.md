# US-005-cursor-transcript-preview

- ID: US-005
- Title: Preview Cursor conversation history through shared chrome
- As a: user returning to a prior Cursor session
- I want: to read the same conversation history chrome used by other sessions
- So that: I can locate the right turn before resuming, while deletion stays scoped to Agent CLI local chats
- Trace: [Approved design sections 3.3, 4.1, 7.3–7.4, 9, 12, and 13](../../../docs/approved/design-cursor-official-sessions.md)
- Risk Focus:
  - 逻辑错误: only store.db is a valid Cursor transcript source; system blobs and unreferenced blobs stay out of the ordered preview.
  - 行为回归: Cursor resume stays on dedicated IPC; existing providers keep their message and delete behavior.
  - 安全问题: store.db sourcePath authorizes read-only preview; non-store paths are rejected for message loading. Deletion is a separate Agent CLI chat-directory action, never Desktop-store mutation.
  - 运行时问题: missing store.db yields an empty shared conversation state instead of a Cursor-only empty card.

## Acceptance Criteria

1. AC-001 (正向): Given a Cursor chat directory that contains store.db, When sessions are scanned, Then sourcePath points at that store.db and the shared conversation query loads ordered user/assistant turns.
2. AC-002 (正向): Given a selected Cursor session with messages, When the detail pane renders, Then the shared 对话记录 chrome and TOC are used, resume stays a header action, and user_info envelopes are omitted from the TOC.
3. AC-003 (负向): Given a non-store path, When message loading runs, Then it rejects the path without parsing Desktop or jsonl files.
4. AC-004 (回归): Given Cursor transcript preview is enabled, When the user resumes, Then launch_session_terminal is not used; Agent CLI local delete may appear, but generic terminal plumbing stays absent.

## Assertions

- AC-001 fails if a store.db session leaves sourcePath unset, or if system/unreferenced blobs appear in order.
- AC-002 fails if Cursor still owns a separate empty conversation card or hides the shared chrome.
- AC-003 fails if a jsonl/other path is parsed as a Cursor transcript.
- AC-004 fails if generic terminal resume appears.

## Linked Tests

- src-tauri/src/session_manager/providers/cursor.rs::tests::us005_sets_source_path_only_when_store_exists
- src-tauri/src/session_manager/providers/cursor.rs::tests::us005_loads_ordered_conversation_and_skips_system_and_unreferenced_blobs
- src-tauri/src/session_manager/providers/cursor.rs::tests::us005_rejects_non_store_transcript_paths
- src-tauri/src/session_manager/mod.rs::tests::us005_rejects_non_store_cursor_transcript_through_dispatch
- src-tauri/src/session_manager/mod.rs::tests::us004_rejects_cursor_deletion_outside_agent_cli_chats
- tests/components/SessionManagerPage.test.tsx::US-002/US-005 renders Cursor transcript through shared chrome without generic terminal plumbing
- tests/components/sessionUtils.test.ts::hides Cursor user_info envelopes from the TOC
- tests/e2e/cursor-official-sessions.spec.ts::US-005 reads Cursor conversation history through the shared session chrome

Run:

    cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture
    pnpm exec vitest run tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts tests/config/cursorCapabilities.test.ts tests/components/CursorResumeGate.test.tsx
    pnpm test:e2e tests/e2e/cursor-official-sessions.spec.ts --grep "US-005"

## Evidence

- 2026-08-29 GREEN: `cargo test --manifest-path src-tauri/Cargo.toml session_manager::` passed 113 tests, including store.db sourcePath, ordered preview, non-store rejection, and delete rejection.
- 2026-08-29 GREEN: focused Vitest suites passed 71 tests; `node scripts/check-cursor-session-ssot.mjs` returned `cursor-session-ssot: PASS`.
- 2026-08-29 GREEN: Playwright `tests/e2e/cursor-official-sessions.spec.ts` passed 6/6, including the shared conversation chrome journey.

- Status: Done

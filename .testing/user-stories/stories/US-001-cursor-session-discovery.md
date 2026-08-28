# US-001-cursor-session-discovery

- ID: US-001
- Title: Discover Cursor sessions by project directory
- As a: user returning to prior Cursor work
- I want: CC Switch to index Cursor Agent CLI sessions and group them by their metadata cwd
- So that: I can find the right conversation without CC Switch inventing a separate Project entity
- Trace: [Approved design sections 3.1, 4.1, 7, 10.1, 12, and 13](../../../docs/approved/design-cursor-official-sessions.md)
- Risk Focus:
  - 逻辑错误: duplicate chat IDs must select the newest metadata record, use normalized-path order as the deterministic tie-breaker, and apply hasConversation only after selecting the winner.
  - 行为回归: Cursor must join the existing session list and cwd grouping without changing SessionMeta semantics or another provider's scan result.
  - 安全问题: malformed metadata, invalid UUID directory names, and unexpected directory depth must be ignored without enabling traversal or transcript access.
  - 运行时问题: missing, unreadable, or unrecognized index roots and isolated corrupt files must degrade deterministically without blocking other providers.

## Acceptance Criteria

1. AC-001 (正向): Given valid Cursor metadata with hasConversation=true, When sessions are scanned, Then one cursor SessionMeta is returned with chat ID, title, timestamps, and cwd mapped directly to projectDir while sourcePath and resumeCommand are absent.
2. AC-002 (正向): Given multiple Cursor sessions sharing a cwd, When the user selects the Cursor filter, Then the existing tool → project directory → session hierarchy groups them under that cwd without creating or reading a Project ID.
3. AC-003 (负向): Given duplicate metadata for one chat ID, When records are resolved, Then updatedAtMs descending and normalized metadata-path ascending choose exactly one winner before the winner's hasConversation value is applied.
4. AC-004 (负向): Given malformed JSON, an invalid UUID directory, an isolated unreadable file, empty cwd, or a moved workspace, When the index is scanned, Then invalid records are skipped while valid history remains discoverable and missing workspace paths do not erase the session.
5. AC-005 (负向): Given a missing, unreadable, or structurally unrecognized Cursor index root, When index status and the global session scan run, Then Cursor reports indexUnavailable and contributes an empty slice without failing other providers.
6. AC-006 (回归): Given the full existing session-manager suite, When Cursor discovery is enabled, Then existing providers retain their prior scan, grouping, message, and deletion behavior.

## Assertions

- AC-001 fails if cwd is not copied to projectDir, a Cursor sourcePath/resumeCommand is populated, or valid metadata is omitted.
- AC-002 fails if grouping uses a new project record or if the Cursor filter cannot expose multiple sessions under one directory.
- AC-003 fails if duplicate resolution depends on traversal order or filters hasConversation before choosing the winner.
- AC-004 fails if one bad record aborts the scan or if a missing workspace removes otherwise valid history.
- AC-005 fails if index diagnostics and scanning use divergent root/layout rules or if another provider is blocked.
- AC-006 fails on any existing session-manager regression.

## Linked Tests

- src-tauri/src/session_manager/providers/cursor.rs::tests::us001_maps_metadata_cwd_into_session_project_dir
- src-tauri/src/session_manager/providers/cursor.rs::tests::us001_deduplicates_chat_ids_before_conversation_filter
- src-tauri/src/session_manager/providers/cursor.rs::tests::us001_skips_bad_metadata_without_losing_valid_sessions
- src-tauri/src/session_manager/providers/cursor.rs::tests::us001_reports_unavailable_index_without_breaking_global_scan
- tests/components/SessionManagerPage.test.tsx::US-001 groups Cursor sessions by metadata cwd
- tests/e2e/cursor-official-sessions.spec.ts::US-001 discovers Cursor sessions by project directory

Run:

    cargo test --manifest-path src-tauri/Cargo.toml session_manager::providers::cursor::tests -- --nocapture
    cargo test --manifest-path src-tauri/Cargo.toml session_manager:: -- --nocapture
    pnpm test:unit -- tests/components/SessionManagerPage.test.tsx tests/components/sessionUtils.test.ts
    pnpm test:e2e -- tests/e2e/cursor-official-sessions.spec.ts --grep "US-001"

## Evidence

- Approval evidence: design status approved by user-chat-2026-08-28.
- Execution evidence is recorded when the Story advances to InTest and Done.

- Status: Ready

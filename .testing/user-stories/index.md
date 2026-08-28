# Cursor Official Sessions User Stories

- Risk level: High
- Approval baseline: [Cursor Official 与 Cursor Agent CLI 会话接入设计](../../../docs/approved/design-cursor-official-sessions.md)
- Scope rule: metadata cwd is a directory grouping key; this release does not introduce a Project entity.

| ID | Title | Status | Primary trace |
| --- | --- | --- | --- |
| [US-001](stories/US-001-cursor-session-discovery.md) | Discover Cursor sessions by project directory | Ready | Design sections 3, 7, 10, 12.1, 13 |
| [US-002](stories/US-002-cursor-session-resume.md) | Resume a Cursor session safely in context | Ready | Design sections 4, 8, 10, 11, 12.1–12.4, 13 |
| [US-003](stories/US-003-cursor-official-auth.md) | Use Cursor Official authentication without leaking credentials | Ready | Design sections 5, 6, 8.2, 10, 12.1–12.4, 13 |
| [US-004](stories/US-004-cursor-unsupported-capabilities.md) | Keep unsupported Cursor capabilities absent and explicit | Ready | Design sections 2, 3.2–3.3, 7.4, 9, 10, 12.1–12.3, 13 |

## Coverage map

| Approved completion outcome | Story |
| --- | --- |
| Cursor sessions are indexed, deterministically deduplicated, and grouped directly by cwd | US-001 |
| Existing sessions resume through a fixed backend-owned command with inline workspace remediation | US-002 |
| Login and User API Key are supported through a private, official-only authentication boundary | US-003 |
| No Project entity, generic Cursor provider app, transcript preview, deletion, TokenKey, custom endpoint, Desktop BYOK, or agent-local capability is introduced | US-004 |
| Index failure is isolated from other providers and non-macOS resume is explicitly unavailable | US-001, US-002, US-004 |
| User API Key never returns to the renderer or enters argv, logs, command previews, database backup, or sync artifacts | US-003 |
| Shared auth, resume, and delete owners are protected by behavior tests and a mechanical contract check | US-002, US-003, US-004 |

Stories advance from Ready to InTest when their first failing test is observed, and to Done only after every linked test and command succeeds with evidence recorded in the Story.

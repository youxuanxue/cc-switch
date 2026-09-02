import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  excludeLiveSessions,
  getSessionActivityAt,
  getSessionLiveKey,
  normalizeStaleCleanupDays,
  sessionMessageSourcePath,
  summarizeCleanupCandidates,
  summarizeStaleCleanup,
} from "@/components/sessions/sessionCapabilities";
import type { SessionMeta } from "@/types";

const NOW = 1_700_000_000_000;

const session = (
  overrides: Partial<SessionMeta> & Pick<SessionMeta, "sessionId">,
): SessionMeta => ({
  providerId: "codex",
  ...overrides,
});

describe("session message source path", () => {
  it("only previews Cursor transcripts from store.db", () => {
    expect(
      sessionMessageSourcePath({
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sourcePath:
          "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
      }),
    ).toBe(
      "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
    );
    expect(
      sessionMessageSourcePath({
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sourcePath:
          "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/meta.json",
      }),
    ).toBeUndefined();
    expect(
      sessionMessageSourcePath({
        providerId: "codex",
        sessionId: "codex-1",
        sourcePath: "/tmp/session.jsonl",
      }),
    ).toBe("/tmp/session.jsonl");
  });
});

describe("stale session cleanup", () => {
  it("selects stale deletable sessions and uses createdAt when lastActiveAt is missing", () => {
    const sessions = [
      session({
        sessionId: "stale-active",
        sourcePath: "/tmp/stale.jsonl",
        lastActiveAt: NOW - 31 * MS_PER_DAY,
      }),
      session({
        sessionId: "stale-created",
        sourcePath: "/tmp/created.jsonl",
        createdAt: NOW - 40 * MS_PER_DAY,
      }),
      session({
        sessionId: "fresh",
        sourcePath: "/tmp/fresh.jsonl",
        lastActiveAt: NOW - MS_PER_DAY,
      }),
    ];

    const { targets, skipped } = summarizeStaleCleanup(sessions, 30, NOW);

    expect(targets.map((item) => item.sessionId)).toEqual([
      "stale-active",
      "stale-created",
    ]);
    expect(skipped).toBe(0);
    expect(getSessionActivityAt(sessions[1])).toBe(NOW - 40 * MS_PER_DAY);
  });

  it("includes stale Cursor Agent CLI chats and skips missing timestamps or source paths", () => {
    const sessions = [
      session({
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
        sourcePath:
          "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
      }),
      session({
        providerId: "cursor",
        sessionId: "not-a-uuid",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
        sourcePath: "/tmp/must-not-delete.jsonl",
      }),
      session({
        sessionId: "no-timestamp",
        sourcePath: "/tmp/no-time.jsonl",
      }),
      session({
        sessionId: "no-source",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
      }),
    ];

    const { targets, skipped } = summarizeStaleCleanup(sessions, 30, NOW);

    expect(targets.map((item) => item.sessionId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(skipped).toBe(2);
  });

  it("rejects invalid day counts instead of guessing a cutoff", () => {
    const sessions = [
      session({
        sessionId: "stale",
        sourcePath: "/tmp/stale.jsonl",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
      }),
    ];

    expect(normalizeStaleCleanupDays(0)).toBeNull();
    expect(normalizeStaleCleanupDays(1.5)).toBeNull();
    expect(normalizeStaleCleanupDays(3651)).toBeNull();
    expect(summarizeStaleCleanup(sessions, 0, NOW)).toEqual({
      targets: [],
      skipped: 0,
    });
    expect(summarizeStaleCleanup(sessions, 1.5, NOW)).toEqual({
      targets: [],
      skipped: 0,
    });
  });
});

describe("inactive session cleanup", () => {
  it("selects all deletable sessions in inactive mode", () => {
    const sessions = [
      session({
        sessionId: "old",
        sourcePath: "/tmp/old.jsonl",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
      }),
      session({
        sessionId: "fresh",
        sourcePath: "/tmp/fresh.jsonl",
        lastActiveAt: NOW - MS_PER_DAY,
      }),
      session({
        sessionId: "no-source",
        lastActiveAt: NOW - 40 * MS_PER_DAY,
      }),
    ];

    const { candidates, skippedNotDeletable } = summarizeCleanupCandidates(
      sessions,
      "inactive",
      30,
      NOW,
    );

    expect(candidates.map((item) => item.sessionId)).toEqual(["old", "fresh"]);
    expect(skippedNotDeletable).toBe(1);
  });

  it("excludes live sessions from cleanup targets", () => {
    const sessions = [
      session({ sessionId: "idle", sourcePath: "/tmp/idle.jsonl" }),
      session({ sessionId: "live", sourcePath: "/tmp/live.jsonl" }),
    ];
    const liveKeys = new Set([getSessionLiveKey(sessions[1])]);

    const { targets, skippedLive } = excludeLiveSessions(sessions, liveKeys);

    expect(targets.map((item) => item.sessionId)).toEqual(["idle"]);
    expect(skippedLive).toBe(1);
  });
});

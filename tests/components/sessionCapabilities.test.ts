import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  getSessionActivityAt,
  normalizeStaleCleanupDays,
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

  it("skips Cursor, missing timestamps, and sessions without a source path", () => {
    const sessions = [
      session({
        providerId: "cursor",
        sessionId: "cursor-stale",
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

    expect(targets).toEqual([]);
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

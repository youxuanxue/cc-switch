import { describe, expect, it } from "vitest";
import { APP_IDS } from "@/config/appConfig";
import {
  APP_SWITCHER_RECENT_WINDOW_MS,
  sortAppsByRecentSessionCount,
} from "@/components/appSwitcherOrder";
import type { SessionMeta } from "@/types";

const NOW = 1_700_000_000_000;

const session = (
  overrides: Partial<SessionMeta> &
    Pick<SessionMeta, "providerId" | "sessionId">,
): SessionMeta => ({
  ...overrides,
});

describe("sortAppsByRecentSessionCount", () => {
  it("orders apps by recent local session count descending", () => {
    const sessions = [
      session({
        providerId: "codex",
        sessionId: "codex-1",
        lastActiveAt: NOW - APP_SWITCHER_RECENT_WINDOW_MS + 1,
      }),
      session({
        providerId: "codex",
        sessionId: "codex-2",
        lastActiveAt: NOW,
      }),
      session({
        providerId: "gemini",
        sessionId: "gemini-1",
        lastActiveAt: NOW,
      }),
    ];

    expect(
      sortAppsByRecentSessionCount(
        ["claude", "codex", "gemini", "pi"],
        sessions,
        NOW,
      ),
    ).toEqual(["codex", "gemini", "claude", "pi"]);
  });

  it("ignores stale sessions, missing timestamps, and non-app providers", () => {
    const sessions = [
      session({
        providerId: "claude",
        sessionId: "old",
        lastActiveAt: NOW - APP_SWITCHER_RECENT_WINDOW_MS - 1,
      }),
      session({
        providerId: "codex",
        sessionId: "no-time",
      }),
      session({
        providerId: "cursor",
        sessionId: "cursor-recent",
        lastActiveAt: NOW,
      }),
      session({
        providerId: "gemini",
        sessionId: "fresh",
        createdAt: NOW - 1,
      }),
    ];

    expect(sortAppsByRecentSessionCount(APP_IDS, sessions, NOW)[0]).toBe(
      "gemini",
    );
  });

  it("keeps catalog order when counts tie or session data is unavailable", () => {
    const sessions = [
      session({
        providerId: "claude",
        sessionId: "claude-1",
        lastActiveAt: NOW,
      }),
      session({
        providerId: "codex",
        sessionId: "codex-1",
        lastActiveAt: NOW,
      }),
    ];

    expect(
      sortAppsByRecentSessionCount(
        ["claude", "claude-desktop", "codex"],
        sessions,
        NOW,
      ),
    ).toEqual(["claude", "codex", "claude-desktop"]);
    expect(
      sortAppsByRecentSessionCount(["pi", "claude", "codex"], undefined, NOW),
    ).toEqual(["pi", "claude", "codex"]);
  });
});

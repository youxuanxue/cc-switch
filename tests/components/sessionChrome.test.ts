import { describe, expect, it } from "vitest";
import {
  buildSessionTocItems,
  shouldRenderSessionTocDialog,
  shouldRenderSessionTocSidebar,
  toDisplayMessages,
} from "@/components/sessions/sessionChrome";
import type { SessionMessage } from "@/types";

const user = (content: string, ts = 1): SessionMessage => ({
  role: "user",
  content,
  ts,
});

const assistant = (content: string, ts = 2): SessionMessage => ({
  role: "assistant",
  content,
  ts,
});

describe("session chrome SSOT", () => {
  it("shows TOC for Claude (and unknown agents) even with a single user turn", () => {
    const items = buildSessionTocItems(
      [
        user("<command-message>loop</command-message>"),
        assistant("[Tool: CronCreate]"),
        { role: "tool", content: "Every 30 minutes", ts: 3 },
      ],
      "claude",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.preview).toContain("loop");
    expect(shouldRenderSessionTocSidebar(items)).toBe(true);
    expect(shouldRenderSessionTocDialog(items)).toBe(true);
  });

  it("uses the default presentation for agents that have no special chrome", () => {
    const messages = [user("ship the gemini adapter")];

    expect(toDisplayMessages(messages, "gemini")).toEqual(messages);
    expect(buildSessionTocItems(messages, "gemini")).toEqual(
      buildSessionTocItems(messages, "claude"),
    );
  });

  it("keeps Codex hide/preview rules behind the shared owner", () => {
    const items = buildSessionTocItems(
      [
        user("# AGENTS.md instructions for /tmp/project"),
        user("Fix the session title preview"),
        assistant("done"),
      ],
      "codex",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.preview).toBe("Fix the session title preview");
  });

  it("rewrites Cursor envelopes only through the shared owner", () => {
    const envelope = [
      "<user_info>os: darwin</user_info>",
      "<user_query>Align the session panel</user_query>",
    ].join("\n");
    const messages = [user(envelope), assistant("ok")];

    expect(toDisplayMessages(messages, "cursor")).toEqual([
      { role: "user", content: "Align the session panel", ts: 1 },
      { role: "assistant", content: "ok", ts: 2 },
    ]);
    expect(buildSessionTocItems(messages, "cursor")[0]?.preview).toBe(
      "Align the session panel",
    );
  });

  it("always reserves the sidebar chrome and only floats the dialog when there is a jump target", () => {
    expect(shouldRenderSessionTocSidebar([])).toBe(true);
    expect(shouldRenderSessionTocDialog([])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { toDisplayMessages } from "@/components/sessions/sessionChrome";
import { getAgentReaderStyle } from "@/components/sessions/reader/agentStyles";
import { buildTurns } from "@/components/sessions/reader/turns";
import type { SessionMessage } from "@/types";

describe("SessionReader display pipeline", () => {
  it("strips Cursor envelopes before building reader turns", () => {
    const raw: SessionMessage[] = [
      {
        role: "user",
        content: [
          "<user_info>os: darwin</user_info>",
          "<user_query>Show only the real prompt</user_query>",
        ].join("\n"),
        ts: 1,
      },
      { role: "assistant", content: "done", ts: 2 },
    ];
    const style = getAgentReaderStyle("cursor");
    const turns = buildTurns(toDisplayMessages(raw, "cursor"), { style });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.question?.text).toBe("Show only the real prompt");
    expect(turns[0]?.question?.text).not.toContain("user_info");
  });
});

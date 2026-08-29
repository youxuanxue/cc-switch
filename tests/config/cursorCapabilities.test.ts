import { describe, expect, it } from "vitest";
import { isSessionDeletable } from "@/components/sessions/sessionCapabilities";
import { cursorCapabilities } from "@/config/cursorCapabilities";

describe("Cursor capability registry", () => {
  it("US-004 declares the approved Cursor capability boundaries", () => {
    expect(cursorCapabilities).toEqual({
      officialLogin: "supported",
      userApiKey: "supported",
      fixedSessionResume: "supported",
      localSessionIndex: "conditional",
      transcriptPreview: "supported",
      sessionDeletion: "unsupported",
    });
  });

  it("US-004 drives Cursor deletion eligibility from the capability registry", () => {
    const mutableCapabilities = cursorCapabilities as {
      sessionDeletion: "supported" | "conditional" | "unsupported";
    };
    const original = mutableCapabilities.sessionDeletion;
    mutableCapabilities.sessionDeletion = "supported";

    try {
      expect(
        isSessionDeletable({
          providerId: "cursor",
          sessionId: "cursor-with-source",
          sourcePath: "/tmp/cursor-session.jsonl",
        }),
      ).toBe(true);
    } finally {
      mutableCapabilities.sessionDeletion = original;
    }
  });
});

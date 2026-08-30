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
      sessionDeletion: "supported",
    });
  });

  it("US-004 drives Cursor deletion eligibility from the capability registry", () => {
    expect(
      isSessionDeletable({
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sourcePath:
          "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
      }),
    ).toBe(true);
    expect(
      isSessionDeletable({
        providerId: "cursor",
        sessionId: "not-a-uuid",
        sourcePath: "/tmp/cursor-session.jsonl",
      }),
    ).toBe(false);
  });
});

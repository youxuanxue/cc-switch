import { describe, expect, it } from "vitest";
import { cursorCapabilities } from "@/config/cursorCapabilities";

describe("Cursor capability registry", () => {
  it("US-004 declares the approved Cursor capability boundaries", () => {
    expect(cursorCapabilities).toEqual({
      officialLogin: "supported",
      userApiKey: "supported",
      fixedSessionResume: "supported",
      localSessionIndex: "conditional",
      transcriptPreview: "unsupported",
      sessionDeletion: "unsupported",
    });
  });
});

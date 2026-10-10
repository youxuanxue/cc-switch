import { describe, expect, it } from "vitest";
import {
  isGlobalPage,
  parseView,
  type GlobalPage,
} from "@/lib/navigation";

describe("navigation universal global page", () => {
  it("accepts universal as a global page", () => {
    expect(parseView("universal")).toBe("universal");
    expect(isGlobalPage("universal")).toBe(true);
  });

  it("rejects unknown views", () => {
    expect(parseView("not-a-real-view")).toBeNull();
  });

  it("keeps other global pages intact", () => {
    const pages: GlobalPage[] = [
      "universal",
      "usage",
      "auth",
      "mcp",
      "skills",
      "prompts",
      "sessions",
      "apps",
    ];
    for (const page of pages) {
      expect(parseView(page)).toBe(page);
      expect(isGlobalPage(page)).toBe(true);
    }
  });
});

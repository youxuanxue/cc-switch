import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW,
  isGlobalPage,
  parseView,
  readStoredView,
  storeView,
  VIEW_STORAGE_KEY,
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

describe("navigation default workbench", () => {
  afterEach(() => {
    localStorage.removeItem(VIEW_STORAGE_KEY);
  });

  it("defaults to universal when nothing is stored", () => {
    localStorage.removeItem(VIEW_STORAGE_KEY);
    expect(DEFAULT_VIEW).toBe("universal");
    expect(readStoredView()).toBe("universal");
  });

  it("respects a stored app providers view", () => {
    storeView("providers");
    expect(readStoredView()).toBe("providers");
  });

  it("respects a stored universal view", () => {
    storeView("universal");
    expect(readStoredView()).toBe("universal");
  });
});

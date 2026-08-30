import { describe, expect, it } from "vitest";

import { getIcon, hasIcon } from "@/icons/extracted";
import { getProviderIconName } from "@/components/sessions/utils";

describe("Cursor icon", () => {
  it("registers the official prism mark for session provider icons", () => {
    const icon = getIcon("cursor");

    expect(hasIcon(getProviderIconName("cursor"))).toBe(true);
    expect(icon).toContain("<title>Cursor</title>");
    expect(icon).toContain('viewBox="0 0 24 24"');
    expect(icon).toContain("M11.925 24l10.425-6-10.425-6L1.5 18l10.425 6z");
    expect(icon).not.toContain(">C<");
  });

  it("does not treat an unknown session provider as a catalog icon", () => {
    expect(getProviderIconName("unknown-agent")).toBe("unknown-agent");
    expect(hasIcon("unknown-agent")).toBe(false);
  });
});

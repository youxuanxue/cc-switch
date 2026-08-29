import { describe, expect, it } from "vitest";

import { SKILLS_CORE_AGENTS } from "./skillsCore";

describe("skills core agent tokens", () => {
  it("does not treat Claude Desktop or OpenClaw as in-use agents", () => {
    expect(SKILLS_CORE_AGENTS).not.toContain("claude-desktop");
    expect(SKILLS_CORE_AGENTS).not.toContain("openclaw");
    expect(SKILLS_CORE_AGENTS).not.toContain("claude");
  });
});

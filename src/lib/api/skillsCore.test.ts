import { describe, expect, it } from "vitest";

import {
  SKILLS_CORE_AGENT_LABELS,
  SKILLS_CORE_AGENTS,
  skillsCoreAgentLabel,
} from "./skillsCore";

describe("skills core agent tokens", () => {
  it("does not treat Claude Desktop or OpenClaw as in-use agents", () => {
    expect(SKILLS_CORE_AGENTS).not.toContain("claude-desktop");
    expect(SKILLS_CORE_AGENTS).not.toContain("openclaw");
    expect(SKILLS_CORE_AGENTS).not.toContain("claude-cursor");
  });

  it("lists Claude Code and Cursor as separate agents", () => {
    expect(SKILLS_CORE_AGENTS).toContain("claude");
    expect(SKILLS_CORE_AGENTS).toContain("cursor");
    expect(skillsCoreAgentLabel("claude")).toBe("Claude");
    expect(skillsCoreAgentLabel("cursor")).toBe("Cursor");
    expect(skillsCoreAgentLabel("grokbuild")).toBe("Grok Build");
    expect(Object.keys(SKILLS_CORE_AGENT_LABELS).sort()).toEqual(
      [...SKILLS_CORE_AGENTS].sort(),
    );
  });
});

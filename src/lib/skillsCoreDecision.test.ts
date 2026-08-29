import { describe, expect, it } from "vitest";

import { skillDecisionCopy } from "./skillsCoreDecision";

const copy: Record<string, string> = {
  "skills.core.decision.git-worktree-submodule": "curated-summary",
  "skills.core.decisionFallback": "fallback-{{name}}",
};

function t(key: string, options?: Record<string, unknown>): string {
  if (!(key in copy)) {
    if (options && "defaultValue" in options) {
      return String(options.defaultValue ?? "");
    }
    return key;
  }
  return copy[key].replace("{{name}}", String(options?.name ?? ""));
}

describe("skillDecisionCopy", () => {
  it("uses one curated sentence for known workbench skills", () => {
    const decision = skillDecisionCopy(
      "git-worktree-submodule",
      "ignored frontmatter",
      t,
    );

    expect(decision.curated).toBe(true);
    expect(decision.summary).toBe("curated-summary");
  });

  it("falls back to the skill description for unknown names", () => {
    const decision = skillDecisionCopy(
      "unknown-local",
      "Do a one-off thing",
      t,
    );

    expect(decision.curated).toBe(false);
    expect(decision.summary).toBe("Do a one-off thing");
  });

  it("does not treat an unknown name as curated just because a description exists", () => {
    const decision = skillDecisionCopy("writing-skills", "Write skills", t);

    expect(decision.curated).toBe(false);
    expect(decision.summary).not.toBe("curated-summary");
    expect(decision.summary).toBe("Write skills");
  });

  it("uses the product fallback when an unknown skill has no description", () => {
    const decision = skillDecisionCopy("mystery", "  ", t);

    expect(decision.curated).toBe(false);
    expect(decision.summary).toBe("fallback-mystery");
  });
});

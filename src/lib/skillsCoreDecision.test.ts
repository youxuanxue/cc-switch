import { describe, expect, it } from "vitest";

import { skillDecisionCopy } from "./skillsCoreDecision";

const copy: Record<string, string> = {
  "skills.core.decision.git-worktree-submodule.job": "curated-job",
  "skills.core.decision.git-worktree-submodule.whenNot": "curated-when-not",
  "skills.core.decision.git-worktree-submodule.consequence":
    "curated-consequence",
  "skills.core.decisionFallback.job": "fallback-{{name}}",
  "skills.core.decisionFallback.whenNot": "fallback-when-not",
  "skills.core.decisionFallback.consequence": "fallback-consequence",
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
  it("uses curated job / when-not / consequence for known workbench skills", () => {
    const decision = skillDecisionCopy(
      "git-worktree-submodule",
      "ignored frontmatter",
      t,
    );

    expect(decision.curated).toBe(true);
    expect(decision.job).toBe("curated-job");
    expect(decision.whenNot).toBe("curated-when-not");
    expect(decision.consequence).toBe("curated-consequence");
  });

  it("falls back to the skill description for unknown names", () => {
    const decision = skillDecisionCopy(
      "unknown-local",
      "Do a one-off thing",
      t,
    );

    expect(decision.curated).toBe(false);
    expect(decision.job).toBe("Do a one-off thing");
    expect(decision.whenNot).toBe("fallback-when-not");
    expect(decision.consequence).toBe("fallback-consequence");
  });

  it("does not treat an unknown name as curated just because a description exists", () => {
    const decision = skillDecisionCopy("writing-skills", "Write skills", t);

    expect(decision.curated).toBe(false);
    expect(decision.job).not.toBe("curated-job");
    expect(decision.job).toBe("Write skills");
  });
});

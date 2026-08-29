export const CURATED_SKILL_DECISIONS = [
  "git-worktree-submodule",
  "xj-review",
  "twin",
  "dev-rules-fanout",
] as const;

export type CuratedSkillDecision = (typeof CURATED_SKILL_DECISIONS)[number];

export interface SkillDecisionCopy {
  job: string;
  whenNot: string;
  consequence: string;
  curated: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function isCuratedSkillDecision(name: string): name is CuratedSkillDecision {
  return (CURATED_SKILL_DECISIONS as readonly string[]).includes(name);
}

export function skillDecisionCopy(
  name: string,
  description: string | undefined,
  t: Translate,
): SkillDecisionCopy {
  if (isCuratedSkillDecision(name)) {
    return {
      job: t(`skills.core.decision.${name}.job`),
      whenNot: t(`skills.core.decision.${name}.whenNot`),
      consequence: t(`skills.core.decision.${name}.consequence`),
      curated: true,
    };
  }

  const trimmed = description?.trim() ?? "";
  return {
    job: trimmed || t("skills.core.decisionFallback.job", { name }),
    whenNot: t("skills.core.decisionFallback.whenNot"),
    consequence: t("skills.core.decisionFallback.consequence"),
    curated: false,
  };
}

export interface SkillDecisionCopy {
  job: string;
  whenNot: string;
  consequence: string;
  curated: boolean;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function translatedOrEmpty(t: Translate, key: string): string {
  const value = t(key, { defaultValue: "" });
  return value === key ? "" : value;
}

export function skillDecisionCopy(
  name: string,
  description: string | undefined,
  t: Translate,
): SkillDecisionCopy {
  const job = translatedOrEmpty(t, `skills.core.decision.${name}.job`);
  const whenNot = translatedOrEmpty(t, `skills.core.decision.${name}.whenNot`);
  const consequence = translatedOrEmpty(
    t,
    `skills.core.decision.${name}.consequence`,
  );
  if (job && whenNot && consequence) {
    return { job, whenNot, consequence, curated: true };
  }

  const trimmed = description?.trim() ?? "";
  return {
    job: trimmed || t("skills.core.decisionFallback.job", { name }),
    whenNot: t("skills.core.decisionFallback.whenNot"),
    consequence: t("skills.core.decisionFallback.consequence"),
    curated: false,
  };
}

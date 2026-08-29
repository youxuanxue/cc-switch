export interface SkillDecisionCopy {
  summary: string;
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
  const curated = translatedOrEmpty(t, `skills.core.decision.${name}`);
  if (curated) {
    return { summary: curated, curated: true };
  }

  const trimmed = description?.trim() ?? "";
  return {
    summary: trimmed || t("skills.core.decisionFallback", { name }),
    curated: false,
  };
}

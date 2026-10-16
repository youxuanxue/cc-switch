import type { FullResult, Reporter, Suite } from "@playwright/test/reporter";

// Stable feature IDs; owners and behaviors: docs/fork-session-contracts.md.
export const REQUIRED_FORK_CONTRACTS = [
  "@fork-session-actions",
  "@fork-session-empty-cleanup",
  "@fork-session-live-cleanup",
  "@fork-session-cleanup-probe-failure",
  "@fork-session-projects",
  "@fork-session-cursor-resume",
  "@fork-session-codex-resume-provider",
] as const;

export default class ForkContractReporter implements Reporter {
  private suite?: Suite;

  onBegin(_config: unknown, suite: Suite) {
    this.suite = suite;
  }

  async onEnd(result: FullResult): Promise<{ status: "failed" } | undefined> {
    const tests = this.suite?.allTests() ?? [];
    const missing = REQUIRED_FORK_CONTRACTS.filter((tag) => {
      const matching = tests.filter((test) => test.tags.includes(tag));
      return (
        matching.length === 0 ||
        matching.some(
          (test) =>
            test.expectedStatus !== "passed" ||
            test.results[test.results.length - 1]?.status !== "passed",
        )
      );
    });
    if (missing.length > 0) {
      console.error(
        `fork-contracts: FAIL — mandatory journeys missing, skipped or failed: ${missing.join(", ")}`,
      );
      return { status: "failed" };
    }
    if (result.status === "passed") console.log("fork-contracts: PASS");
  }
}

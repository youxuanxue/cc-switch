import { afterEach, describe, expect, it, vi } from "vitest";
import type { FullResult, Suite, TestCase } from "@playwright/test/reporter";
import ForkContractReporter, {
  REQUIRED_FORK_CONTRACTS,
} from "../fork-contract-reporter";

function passingTests() {
  return REQUIRED_FORK_CONTRACTS.map((tag) => ({
    tags: [tag],
    expectedStatus: "passed",
    results: [{ status: "passed" }],
  })) as TestCase[];
}

function finish(tests: TestCase[]) {
  const reporter = new ForkContractReporter();
  reporter.onBegin({}, { allTests: () => tests } as Suite);
  return reporter.onEnd({ status: "passed" } as FullResult);
}

afterEach(() => vi.restoreAllMocks());

describe("mandatory fork journey gate", () => {
  it("allows a completed contract suite", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(finish(passingTests())).resolves.toBeUndefined();
  });

  it("fails when a contract test is deleted or filtered out despite an otherwise green suite", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(finish(passingTests().slice(1))).resolves.toEqual({
      status: "failed",
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(REQUIRED_FORK_CONTRACTS[0]),
    );
  });

  it.each(["skipped", "failed", "timedOut", "interrupted"] as const)(
    "fails when a required journey is %s",
    async (status) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const tests = passingTests();
      tests[0].results[0].status = status;
      await expect(finish(tests)).resolves.toEqual({ status: "failed" });
    },
  );

  it("rejects expected failures and unexecuted tests", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tests = passingTests();
    tests[0].expectedStatus = "failed";
    await expect(finish(tests)).resolves.toEqual({ status: "failed" });
    tests[0].expectedStatus = "passed";
    tests[0].results = [];
    await expect(finish(tests)).resolves.toEqual({ status: "failed" });
  });
});

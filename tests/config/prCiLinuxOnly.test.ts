import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS_DIR = path.resolve(__dirname, "..", "..", ".github", "workflows");

const PR_RUNNER_BLOCKLIST =
  /\b(windows-latest|windows-2022|windows-2025|macos-latest|macos-14|macos-13)\b/;

function isPullRequestWorkflow(source: string): boolean {
  return /^\s+pull_request:/m.test(source);
}

function withoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

function backendJob(source: string): string {
  const start = source.search(/^  backend:\s*$/m);
  expect(start, "ci.yml must define a backend job").toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const next = rest.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

describe("PR CI stays Linux-only", () => {
  const ciSource = fs.readFileSync(path.join(WORKFLOWS_DIR, "ci.yml"), "utf8");

  it("schedules backend checks on ubuntu-22.04", () => {
    expect(backendJob(ciSource)).toMatch(/^\s+runs-on:\s+ubuntu-22\.04\s*$/m);
  });

  it("does not put Windows, macOS, or WSL2 on a pull_request workflow", () => {
    const offenders = fs
      .readdirSync(WORKFLOWS_DIR)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .flatMap((name) => {
        const source = fs.readFileSync(path.join(WORKFLOWS_DIR, name), "utf8");
        if (!isPullRequestWorkflow(source)) {
          return [];
        }
        const body = withoutComments(source);
        const hits = body.match(PR_RUNNER_BLOCKLIST) ?? [];
        const wsl2Job = /^  backend-windows-wsl2:\s*$/m.test(body);
        if (hits.length === 0 && !wsl2Job) {
          return [];
        }
        return [
          {
            file: name,
            runners: [...new Set(hits)],
            wsl2Job,
          },
        ];
      });

    expect(offenders).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];

function runPreflight(area?: string, failCommand?: string) {
  const root = mkdtempSync(resolve(tmpdir(), "cc-switch-preflight-"));
  roots.push(root);
  mkdirSync(resolve(root, "scripts/upstream"), { recursive: true });
  mkdirSync(resolve(root, "bin"));
  const script = resolve(root, "scripts/preflight.sh");
  writeFileSync(
    script,
    readFileSync(resolve(process.cwd(), "scripts/preflight.sh")),
  );
  writeFileSync(
    resolve(root, "scripts/upstream/notify-merge-needed.py"),
    "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n",
    { mode: 0o755 },
  );
  const log = resolve(root, "commands.log");
  writeFileSync(log, "");
  for (const name of ["git", "pnpm", "node", "cargo", "python3"]) {
    writeFileSync(
      resolve(root, "bin", name),
      '#!/bin/bash\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$PREFLIGHT_TEST_LOG"\n' +
        'if [[ "${0##*/} $*" == "${PREFLIGHT_TEST_FAIL:-}" ]]; then exit 7; fi\n',
      { mode: 0o755 },
    );
  }
  const result = spawnSync("/bin/bash", [script, ...(area ? [area] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${resolve(root, "bin")}:${process.env.PATH}`,
      PREFLIGHT_TEST_LOG: log,
      PREFLIGHT_TEST_FAIL: failCommand ?? "",
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    commands: readFileSync(log, "utf8"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("preflight exit gate", () => {
  it("runs both stacks by default", () => {
    const result = runPreflight();
    expect(result.status).toBe(0);
    expect(result.commands).toContain("pnpm test:e2e");
    expect(result.commands).toContain(
      "cargo test --manifest-path src-tauri/Cargo.toml",
    );
    expect(result.commands).toContain(
      "python3 scripts/upstream/notify-merge-needed.py --selftest",
    );
    expect(result.output).not.toContain("FAIL:");
  });

  it("preserves a failed check while collecting later results", () => {
    const result = runPreflight(undefined, "pnpm typecheck");
    expect(result.status).toBe(1);
    expect(result.output).toContain("FAIL: typecheck");
    expect(result.output).toContain("PASS: rust-tests");
  });

  it("lets CI run each stack without requiring the other toolchain", () => {
    const frontend = runPreflight("frontend");
    expect(frontend.status).toBe(0);
    expect(frontend.commands).toContain("pnpm test:unit");
    expect(frontend.commands).not.toContain("cargo ");
    const backend = runPreflight("backend");
    expect(backend.status).toBe(0);
    expect(backend.commands).toContain("cargo clippy");
    expect(backend.commands).not.toContain("pnpm ");
  });

  it("rejects an unknown area without silently skipping checks", () => {
    const result = runPreflight("frontned");
    expect(result.status).toBe(2);
    expect(result.commands).toBe("");
  });
});

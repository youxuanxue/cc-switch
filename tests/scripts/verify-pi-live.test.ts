import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const credential = "fixture-credential-never-export";

function runLiveVerifier(mode = "success", only = "test-provider") {
  const root = mkdtempSync(resolve(tmpdir(), "pi-live-verifier-"));
  roots.push(root);
  const agent = resolve(root, "agent");
  mkdirSync(agent);
  const original = {
    "models.json": JSON.stringify({
      providers: {
        "test-provider": {
          apiKey: credential,
          models: [{ id: "test-model" }],
        },
      },
    }),
    "settings.json": '{"defaultProvider":"original","theme":"dark"}',
    "auth.json": "{}",
  };
  for (const [name, value] of Object.entries(original))
    writeFileSync(resolve(agent, name), value);
  const audit = resolve(root, "audit.json");
  const wts = resolve(root, "wts");
  writeFileSync(
    wts,
    '#!/usr/bin/env python3\nimport os,sys\nassert sys.argv[1:] == ["open", os.getcwd(), "pi"]\nos.execv(os.environ["PI_BIN"], [os.environ["PI_BIN"]])\n',
    { mode: 0o755 },
  );
  const pi = resolve(root, "pi mock");
  writeFileSync(
    pi,
    `#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ["PI_CODING_AGENT_DIR"])
settings=json.loads((root/"settings.json").read_text())
config=json.loads((root/"models.json").read_text())
provider=settings["defaultProvider"]
assert all(flag in sys.argv for flag in ["--no-tools", "--no-session", "--no-context-files", "--no-mcp", "--no-extensions"])
assert "--model" not in sys.argv and "--provider" not in sys.argv
Path(os.environ["PI_TEST_AUDIT"]).write_text(json.dumps({"cwd":os.getcwd(),"temp":str(root),"defaultProvider":provider,"defaultModel":settings["defaultModel"]}))
mode=os.environ["PI_TEST_MODE"]
message={"role":"assistant","provider":provider,"model":settings["defaultModel"],"stopReason":"stop","content":[{"type":"text","text":"PI_SMOKE_OK"}]}
if mode=="error":
 message["stopReason"]="error"
 message["errorMessage"]="401: " + config["providers"][provider]["apiKey"]
if mode=="mismatch":message["provider"]="wrong-provider"
print(json.dumps({"type":"message_end","message":message}))
`,
    { mode: 0o755 },
  );
  const report = resolve(root, "report.json");
  const result = spawnSync(
    "python3",
    [
      resolve(process.cwd(), "scripts/verify-pi-live.py"),
      "--agent-dir",
      agent,
      "--worktree",
      root,
      "--wts",
      wts,
      "--pi",
      pi,
      "--only",
      only,
      "--report",
      report,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, PI_TEST_MODE: mode, PI_TEST_AUDIT: audit },
    },
  );
  return { root, agent, original, report, audit, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("opt-in Pi live verifier", () => {
  it("uses isolated native defaults, checks the selected model, and cleans credential copies", () => {
    const run = runLiveVerifier();
    expect(run.result.status).toBe(0);
    const report = JSON.parse(readFileSync(run.report, "utf8"));
    expect(report.results[0]).toMatchObject({
      status: "PASS",
      selectedProvider: "test-provider",
      selectedModel: "test-model",
      detail: "PI_SMOKE_OK",
    });
    const audit = JSON.parse(readFileSync(run.audit, "utf8"));
    expect(audit.cwd).toBe(realpathSync(run.root));
    expect(audit.defaultProvider).toBe("test-provider");
    expect(audit.defaultModel).toBe("test-model");
    expect(existsSync(audit.temp)).toBe(false);
    expect(report.originalFilesUnchanged).toBe(true);
    for (const [name, value] of Object.entries(run.original))
      expect(readFileSync(resolve(run.agent, name), "utf8")).toBe(value);
  });

  it("reports a provider failure without exporting its credential, even on exit zero", () => {
    const run = runLiveVerifier("error");
    expect(run.result.status).toBe(1);
    const raw = readFileSync(run.report, "utf8");
    const report = JSON.parse(raw);
    expect(report.results[0]).toMatchObject({
      status: "FAIL",
      stopReason: "error",
      detail: "401: [REDACTED]",
    });
    expect(raw + run.result.stdout + run.result.stderr).not.toContain(
      credential,
    );
  });

  it("rejects a successful reply from a different provider", () => {
    const run = runLiveVerifier("mismatch");
    expect(run.result.status).toBe(1);
    const report = JSON.parse(readFileSync(run.report, "utf8"));
    expect(report.results[0]).toMatchObject({
      status: "FAIL",
      selectedProvider: "wrong-provider",
      detail: "PI_SMOKE_OK",
    });
  });

  it("rejects unknown selection before launching a client", () => {
    const run = runLiveVerifier("success", "missing-provider");
    expect(run.result.status).toBe(2);
    expect(run.result.stderr).toContain(
      "Unknown provider IDs: missing-provider",
    );
    expect(existsSync(run.audit)).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = resolve(
  process.cwd(),
  "scripts/check-session-live-ssot.mjs",
);
const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, source: string) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function conformingSources(): Record<string, string> {
  return {
    "src-tauri/src/session_manager/resume.rs": `
fn is_cc_switch_binary_command(command: &str) -> bool {
    command_basename(first) == "cc-switch"
}
pub fn is_inspector_noise(command: &str) -> bool {
    if is_cc_switch_binary_command(command) {
        return true;
    }
    false
}
pub fn find_live_writer() {}
pub fn decide_resume() {}
pub fn resume_decision_for_session() {}
#[cfg(test)]
mod tests {
    fn one_live_body_invariant_holds_for_every_session_runner_with_cc_switch_workspace() {}
}
`,
    "src-tauri/src/commands/session_manager.rs": `
#[tauri::command]
pub async fn launch_session_terminal() {
    let decision = resume_decision_for_session();
}

#[tauri::command]
pub async fn spawn_session_pty() {
    let decision = resume_decision_for_session();
}
`,
    "src-tauri/src/services/cursor_official.rs": `
fn reuse_live_session() {
    let decision = resume_decision_for_session();
}
fn launch_resume_with() {
    let live_source = live_writer_source_path(&record.metadata_path);
    if let Some(result) = reuse_live_session(session_id, Some(&live_source)) {}
}
`,
    "src/components/sessions/LiveTerminalPane.tsx": `
export function LiveTerminalPane({ onBlocked }) {
  if (result.kind === "focused") {
    toast.error(t("sessionManager.liveTerminalAlreadyLive"));
    onBlocked?.();
  }
  if (result.kind === "occupied") {
    toast.error("occupied");
    onBlocked?.();
  }
}
`,
    "src/components/sessions/liveTerminalSpawn.ts": `
export async function spawnCursorLiveTerminal() {
  return cursorApi.spawnSessionPty({});
}
export async function spawnProviderLiveTerminal() {
  return sessionsApi.spawnPty({});
}
`,
  };
}

function createFixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "cc-switch-live-ssot-"));
  fixtureRoots.push(root);
  const sources = { ...conformingSources(), ...overrides };
  for (const [path, source] of Object.entries(sources)) {
    writeFixtureFile(root, path, source);
  }
  return root;
}

function runChecker(root: string) {
  const result = spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("check-session-live-ssot", () => {
  it("passes against the real repository", () => {
    const result = runChecker(process.cwd());
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("session-live-ssot: PASS");
    expect(result.status).toBe(0);
  });

  it("passes a conforming fixture", () => {
    const result = runChecker(createFixture());
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("session-live-ssot: PASS");
    expect(result.status).toBe(0);
  });

  it("rejects contains(cc-switch) inspector-noise antipattern", () => {
    const result = runChecker(
      createFixture({
        "src-tauri/src/session_manager/resume.rs": `
pub fn is_inspector_noise(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    if lower.contains("cc-switch") {
        return true;
    }
    false
}
pub fn find_live_writer() {}
pub fn decide_resume() {}
pub fn resume_decision_for_session() {}
#[cfg(test)]
mod tests {
    fn one_live_body_invariant_holds_for_every_session_runner_with_cc_switch_workspace() {}
}
`,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SESSION_LIVE_NOISE_ANTIPATTERN");
  });

  it("rejects launch paths that skip resume_decision_for_session", () => {
    const result = runChecker(
      createFixture({
        "src-tauri/src/commands/session_manager.rs": `
#[tauri::command]
pub async fn launch_session_terminal() {
    launch_terminal();
}

#[tauri::command]
pub async fn spawn_session_pty() {
    let decision = resume_decision_for_session();
}
`,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SESSION_LIVE_LAUNCH_CONSUMER");
  });

  it("rejects LiveTerminalPane that does not block focused live sessions", () => {
    const result = runChecker(
      createFixture({
        "src/components/sessions/LiveTerminalPane.tsx": `
export function LiveTerminalPane({ onBlocked }) {
  if (result.kind === "focused") {
    toast.success("focused");
  }
  if (result.kind === "occupied") {
    onBlocked?.();
  }
}
`,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SESSION_LIVE_TERMINAL_BLOCK");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = resolve(
  process.cwd(),
  "scripts/check-cursor-session-ssot.mjs",
);
const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, source: string) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function createConformingFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cc-switch-cursor-ssot-"));
  fixtureRoots.push(root);

  writeFixtureFile(
    root,
    "src/hooks/useCursorOfficial.ts",
    "export function useCursorOfficial() { return { status: null }; }\n",
  );
  writeFixtureFile(
    root,
    "src/components/cursor/CursorOfficialAuthControl.tsx",
    [
      'import { useCursorOfficial } from "../../../hooks/useCursorOfficial";',
      "export function CursorOfficialAuthControl() {",
      "  useCursorOfficial();",
      "  return null;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/settings/CursorOfficialAuthSection.tsx",
    [
      'import { CursorOfficialAuthControl } from "../cursor/CursorOfficialAuthControl";',
      "export function CursorOfficialAuthSection() {",
      "  return <CursorOfficialAuthControl />;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/cursorResumeState.ts",
    [
      "export function deriveCursorResumeState(input: { ready: boolean }) {",
      '  return input.ready ? "ready" : "workspaceRequired";',
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/CursorResumeGate.tsx",
    [
      'import { CursorOfficialAuthControl } from "../cursor/CursorOfficialAuthControl";',
      'import { useCursorOfficial } from "../../../hooks/useCursorOfficial";',
      'import { deriveCursorResumeState } from "./cursorResumeState";',
      "export function CursorResumeGate() {",
      "  useCursorOfficial();",
      "  deriveCursorResumeState({ ready: true });",
      "  return <CursorOfficialAuthControl />;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/sessionCapabilities.ts",
    [
      "export function isSessionDeletable(session: { providerId: string; sourcePath?: string }) {",
      '  return session.providerId !== "cursor" && Boolean(session.sourcePath);',
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/SessionManagerPage.tsx",
    [
      'import { CursorResumeGate } from "./CursorResumeGate";',
      'import { isSessionDeletable } from "./sessionCapabilities";',
      "export function SessionManagerPage({ session }: { session: any }) {",
      "  return isSessionDeletable(session) ? <CursorResumeGate /> : null;",
      "}",
    ].join("\n"),
  );

  return root;
}

function runChecker(root: string) {
  const result = spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
  });

  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

afterEach(() => {
  while (fixtureRoots.length > 0) {
    rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
  }
});

describe("US-004 Cursor session SSOT checker", () => {
  it("accepts a fixture that composes the shared Cursor owners", () => {
    const result = runChecker(createConformingFixture());

    expect(result.status).toBe(0);
    expect(result.output).toContain("cursor-session-ssot: PASS");
  });

  it("rejects duplicated Cursor resume-state derivation", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/CursorResumeClone.tsx",
      [
        "export function deriveAgain(input: any) {",
        '  if (!input.isMac) return "platformUnavailable";',
        '  if (!input.installed) return "cliMissing";',
        '  if (input.workspaceState === "required") return "workspaceRequired";',
        '  return input.authenticated ? "ready" : "needsLogin";',
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CURSOR_RESUME_OWNER_BYPASS");
    expect(result.output).toContain("CursorResumeClone.tsx");
  });

  it("rejects direct Cursor authentication API use from page components", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/settings/CursorAuthPage.tsx",
      [
        'import { cursorApi } from "../../lib/api/cursor";',
        "export async function CursorAuthPage() {",
        '  await cursorApi.updateOfficialAuth({ authMode: "login" });',
        "  return null;",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CURSOR_AUTH_OWNER_BYPASS");
    expect(result.output).toContain("CursorAuthPage.tsx");
  });

  it("rejects direct sourcePath-based Cursor deletion eligibility", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/CursorDeletePanel.tsx",
      [
        "export function canDelete(session: any) {",
        '  return session.providerId !== "cursor" && Boolean(session.sourcePath);',
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CURSOR_DELETE_OWNER_BYPASS");
    expect(result.output).toContain("CursorDeletePanel.tsx");
  });

  it("rejects generic terminal launch from Cursor code", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/CursorTerminalPanel.tsx",
      [
        'import { sessionsApi } from "../../lib/api/sessions";',
        "export async function resumeCursor() {",
        '  await sessionsApi.launchTerminal({ command: "agent --resume chat" });',
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("CURSOR_GENERIC_TERMINAL_BYPASS");
    expect(result.output).toContain("CursorTerminalPanel.tsx");
  });
});

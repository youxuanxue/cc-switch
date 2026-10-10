import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = resolve(
  process.cwd(),
  "scripts/check-skills-core-ssot.mjs",
);
const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, source: string) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function createConformingFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cc-switch-skills-core-ssot-"));
  fixtureRoots.push(root);

  writeFixtureFile(
    root,
    "src/App.tsx",
    [
      'import SkillsCorePanel from "@/components/skills/SkillsCorePanel";',
      "export function App() {",
      "  return <SkillsCorePanel onOpenDiscovery={() => undefined} />;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src-tauri/src/lib.rs",
    [
      "pub fn register() {",
      '  ["skills_core_preview_open", "skills_core_open", "skills_core_doctor",',
      '   "skills_core_install", "skills_core_uninstall", "skills_core_import",',
      '   "skills_core_sync", "skills_core_upgrade", "skills_core_follow_catalog",',
      '   "skills_core_agents_add", "skills_core_agents_remove",',
      '   "skills_core_save_local_draft"].iter().for_each(|_| {});',
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

describe("skills core SSOT checker", () => {
  it("accepts a fixture that wires SkillsCorePanel and Tauri commands", () => {
    const result = runChecker(createConformingFixture());

    expect(result.status).toBe(0);
    expect(result.output).toContain("skills-core-ssot: PASS");
  });

  it("passes against the real repository", () => {
    const result = runChecker(process.cwd());

    expect(result.status).toBe(0);
    expect(result.output).toContain("skills-core-ssot: PASS");
  });

  it("rejects App that resurrects UnifiedSkillsPanel", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/App.tsx",
      [
        'import SkillsCorePanel from "@/components/skills/SkillsCorePanel";',
        'import { UnifiedSkillsPanel } from "@/legacy/UnifiedSkillsPanel";',
        "export function App() {",
        "  return <SkillsCorePanel onOpenDiscovery={() => undefined} />;",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SKILLS_CORE_LEGACY_PANEL");
  });

  it("rejects App without SkillsCorePanel render", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/App.tsx",
      'export function App() { return <div />; }',
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SKILLS_CORE_APP");
  });
});

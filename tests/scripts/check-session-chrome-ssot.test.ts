import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = resolve(
  process.cwd(),
  "scripts/check-session-chrome-ssot.mjs",
);
const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, source: string) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function createConformingFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cc-switch-session-chrome-ssot-"));
  fixtureRoots.push(root);

  writeFixtureFile(
    root,
    "src/components/sessions/sessionChrome.ts",
    [
      "export function toDisplayMessages(messages: unknown[]) { return messages; }",
      "export function buildSessionTocItems() { return []; }",
      "export function shouldRenderSessionTocSidebar() { return true; }",
      "export function shouldRenderSessionTocDialog(items: unknown[]) { return items.length > 0; }",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/reader/SessionOutline.tsx",
    "export function SessionOutline() { return <nav />; }",
  );
  writeFixtureFile(
    root,
    "src/components/sessions/reader/SessionReader.tsx",
    [
      'import { toDisplayMessages } from "../sessionChrome";',
      'import { SessionOutline } from "./SessionOutline";',
      "export function SessionReader({ messages = [] }) {",
      "  const displayMessages = toDisplayMessages(messages, 'cursor');",
      "  return (",
      "    <section data-count={displayMessages.length}>",
      "      <SessionOutline />",
      "    </section>",
      "  );",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/SessionManagerPage.tsx",
    [
      'import { SessionReader } from "./reader/SessionReader";',
      "export function SessionManagerPage() {",
      "  return <SessionReader />;",
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

describe("session chrome SSOT checker", () => {
  it("accepts a fixture that consumes SessionReader outline chrome", () => {
    const result = runChecker(createConformingFixture());

    expect(result.status).toBe(0);
    expect(result.output).toContain("session-chrome-ssot: PASS");
  });

  it("passes against the real repository", () => {
    const result = runChecker(process.cwd());

    expect(result.status).toBe(0);
    expect(result.output).toContain("session-chrome-ssot: PASS");
  });

  it("rejects Session Manager that skips SessionReader", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/SessionManagerPage.tsx",
      "export function SessionManagerPage() { return <div />; }",
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_PAGE_CHROME_FORK");
  });

  it("rejects resurrecting legacy SessionToc on the page", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/SessionManagerPage.tsx",
      [
        'import { SessionTocSidebar } from "./SessionToc";',
        'import { SessionReader } from "./reader/SessionReader";',
        "export function SessionManagerPage() {",
        "  return (",
        "    <>",
        "      <SessionTocSidebar items={[]} />",
        "      <SessionReader />",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_PAGE_CHROME_FORK");
  });

  it("rejects SessionReader without SessionOutline", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/reader/SessionReader.tsx",
      "export function SessionReader() { return <section />; }",
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_READER_CHROME_FORK");
  });

  it("rejects SessionReader that skips toDisplayMessages", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/reader/SessionReader.tsx",
      [
        'import { SessionOutline } from "./SessionOutline";',
        "export function SessionReader() {",
        "  return <SessionOutline />;",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_READER_CHROME_FORK");
    expect(result.output).toContain("toDisplayMessages");
  });
});

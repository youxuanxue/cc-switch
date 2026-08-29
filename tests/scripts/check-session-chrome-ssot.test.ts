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
    "src/components/sessions/SessionToc.tsx",
    [
      'import { shouldRenderSessionTocDialog, shouldRenderSessionTocSidebar } from "./sessionChrome";',
      "export function SessionTocSidebar({ items }: { items: unknown[] }) {",
      "  if (!shouldRenderSessionTocSidebar(items)) return null;",
      "  return <aside />;",
      "}",
      "export function SessionTocDialog({ items }: { items: unknown[] }) {",
      "  if (!shouldRenderSessionTocDialog(items)) return null;",
      "  return <dialog />;",
      "}",
    ].join("\n"),
  );
  writeFixtureFile(
    root,
    "src/components/sessions/SessionManagerPage.tsx",
    [
      'import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";',
      'import { buildSessionTocItems, toDisplayMessages } from "./sessionChrome";',
      "export function SessionManagerPage({ messages }: { messages: unknown[] }) {",
      "  const displayMessages = toDisplayMessages(messages);",
      "  const items = buildSessionTocItems(displayMessages);",
      "  return (",
      "    <>",
      "      <SessionTocSidebar items={items} />",
      "      <SessionTocDialog items={items} />",
      "    </>",
      "  );",
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
  it("accepts a fixture that consumes the shared chrome owner", () => {
    const result = runChecker(createConformingFixture());

    expect(result.status).toBe(0);
    expect(result.output).toContain("session-chrome-ssot: PASS");
  });

  it("passes against the real repository", () => {
    const result = runChecker(process.cwd());

    expect(result.status).toBe(0);
    expect(result.output).toContain("session-chrome-ssot: PASS");
  });

  it("rejects hiding the TOC behind an item-count threshold", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/SessionToc.tsx",
      [
        'import { shouldRenderSessionTocDialog, shouldRenderSessionTocSidebar } from "./sessionChrome";',
        "export function SessionTocSidebar({ items }: { items: unknown[] }) {",
        "  if (items.length <= 2) return null;",
        "  if (!shouldRenderSessionTocSidebar(items)) return null;",
        "  return <aside />;",
        "}",
        "export function SessionTocDialog({ items }: { items: unknown[] }) {",
        "  if (!shouldRenderSessionTocDialog(items)) return null;",
        "  return <dialog />;",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_TOC_VISIBILITY_BYPASS");
  });

  it("rejects rebuilding chrome from provider-specific helpers on the page", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/SessionManagerPage.tsx",
      [
        'import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";',
        'import { extractCursorDisplayContent, shouldHideCodexMessageFromToc } from "./utils";',
        "export function SessionManagerPage() {",
        "  return (",
        "    <>",
        "      <SessionTocSidebar items={[]} />",
        "      <SessionTocDialog items={[]} />",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_PAGE_CHROME_FORK");
  });

  it("rejects gating the shared TOC by provider", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src/components/sessions/SessionManagerPage.tsx",
      [
        'import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";',
        'import { buildSessionTocItems, toDisplayMessages } from "./sessionChrome";',
        "export function SessionManagerPage({ providerId }: { providerId: string }) {",
        "  const displayMessages = toDisplayMessages([]);",
        "  const items = buildSessionTocItems(displayMessages);",
        "  return (",
        "    <>",
        "      {providerId === 'codex' && <SessionTocSidebar items={items} />}",
        "      <SessionTocDialog items={items} />",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("SESSION_PAGE_CHROME_FORK");
  });
});

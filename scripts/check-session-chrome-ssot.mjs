#!/usr/bin/env node

/**
 * Plan A chrome SSOT (post upstream sidebar + sessions reader):
 * - SessionManagerPage must consume SessionReader (not resurrect SessionToc)
 * - SessionReader must render SessionOutline for directory chrome
 * - Provider message presentation helpers stay owned by sessionChrome.ts
 *   (toDisplayMessages / buildSessionTocItems remain for non-reader callers)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const FINDING_CODES = {
  owner: "SESSION_CHROME_OWNER_BYPASS",
  reader: "SESSION_READER_CHROME_FORK",
  page: "SESSION_PAGE_CHROME_FORK",
};

const OWNER_EXPORTS = [
  "toDisplayMessages",
  "buildSessionTocItems",
  "shouldRenderSessionTocSidebar",
  "shouldRenderSessionTocDialog",
];

const PAGE_FORBIDDEN_CHROME_IMPORTS = [
  "shouldHideCodexMessageFromToc",
  "shouldHideCursorMessageFromToc",
  "extractCodexPromptPreview",
  "extractCursorPromptPreview",
  "extractCursorDisplayContent",
  "formatSessionMessagePreview",
  "SessionTocSidebar",
  "SessionTocDialog",
];

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }

  process.stderr.write(
    "usage: node scripts/check-session-chrome-ssot.mjs [--root <path>]\n",
  );
  process.exit(2);
}

function sourceExtension(path) {
  const match = path.match(/\.(?:jsx?|tsx?)$/);
  return match?.[0] ?? "";
}

function walkSourceFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walkSourceFiles(path);
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(sourceExtension(path))) {
        return [];
      }
      return [path];
    });
}

function importedSymbols(source) {
  const symbols = new Set();
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["'];?/g,
  )) {
    for (const symbol of match[1].matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (symbol[0] !== "as" && symbol[0] !== "type") {
        symbols.add(symbol[0]);
      }
    }
  }
  return symbols;
}

function exportedSymbols(source) {
  const symbols = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  )) {
    symbols.add(match[1]);
  }
  for (const match of source.matchAll(
    /export\s+(?:const|let|var|type|interface|class)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    symbols.add(match[1]);
  }
  return symbols;
}

function lineNumber(source, index) {
  return source.slice(0, Math.max(index, 0)).split("\n").length;
}

const root = parseRoot(process.argv.slice(2));
const sourceRoot = resolve(root, "src");
const sources = new Map(
  walkSourceFiles(sourceRoot).map((absolutePath) => [
    relative(root, absolutePath).split("\\").join("/"),
    readFileSync(absolutePath, "utf8"),
  ]),
);
const findings = [];

function addFinding(code, file, message, line) {
  findings.push({ code, file, message, line });
}

function requireFile(file, code, message) {
  if (!sources.has(file)) {
    addFinding(code, file, `${message}; owner file is missing`);
    return undefined;
  }
  return sources.get(file);
}

function requireImports(file, symbols, code, message) {
  const source = requireFile(file, code, message);
  if (source === undefined) return;

  const imports = importedSymbols(source);
  const missing = symbols.filter((symbol) => !imports.has(symbol));
  if (missing.length > 0) {
    addFinding(
      code,
      file,
      `${message}; missing import(s): ${missing.join(", ")}`,
    );
  }
}

function requireExports(file, symbols, code, message) {
  const source = requireFile(file, code, message);
  if (source === undefined) return;

  const exports = exportedSymbols(source);
  const missing = symbols.filter((symbol) => !exports.has(symbol));
  if (missing.length > 0) {
    addFinding(
      code,
      file,
      `${message}; missing export(s): ${missing.join(", ")}`,
    );
  }
}

const ownerPath = "src/components/sessions/sessionChrome.ts";
const readerPath = "src/components/sessions/reader/SessionReader.tsx";
const outlinePath = "src/components/sessions/reader/SessionOutline.tsx";
const pagePath = "src/components/sessions/SessionManagerPage.tsx";

requireExports(
  ownerPath,
  OWNER_EXPORTS,
  FINDING_CODES.owner,
  "Session chrome owner must export the shared display/TOC APIs",
);

requireFile(
  outlinePath,
  FINDING_CODES.reader,
  "Session reader outline chrome owner must exist",
);

requireImports(
  readerPath,
  ["SessionOutline"],
  FINDING_CODES.reader,
  "SessionReader must render the shared outline chrome",
);

requireImports(
  pagePath,
  ["SessionReader"],
  FINDING_CODES.page,
  "Session Manager must consume the shared SessionReader chrome",
);

const readerSource = sources.get(readerPath);
if (readerSource !== undefined) {
  if (!/<SessionOutline\b/.test(readerSource)) {
    addFinding(
      FINDING_CODES.reader,
      readerPath,
      "SessionReader must render <SessionOutline> for directory chrome",
    );
  }
}

const pageSource = sources.get(pagePath);
if (pageSource !== undefined) {
  const imports = importedSymbols(pageSource);
  const forbidden = PAGE_FORBIDDEN_CHROME_IMPORTS.filter((symbol) =>
    imports.has(symbol),
  );
  if (forbidden.length > 0) {
    addFinding(
      FINDING_CODES.page,
      pagePath,
      `Session Manager must not rebuild or resurrect legacy TOC chrome: ${forbidden.join(", ")}`,
    );
  }

  if (!/<SessionReader\b/.test(pageSource)) {
    addFinding(
      FINDING_CODES.page,
      pagePath,
      "Session Manager must unconditionally render <SessionReader>",
    );
  }
}

const presentationOwnerFiles = new Set([ownerPath]);

for (const [file, source] of sources) {
  if (!file.startsWith("src/components/sessions/")) continue;

  if (!presentationOwnerFiles.has(file)) {
    const match = source.match(/\bSESSION_MESSAGE_PRESENTATION\b/);
    if (match) {
      addFinding(
        FINDING_CODES.owner,
        file,
        "Provider message presentation must be owned by sessionChrome.ts",
        lineNumber(source, match.index),
      );
    }
  }
}

const uniqueFindings = [
  ...new Map(
    findings.map((finding) => [
      `${finding.code}\0${finding.file}\0${finding.message}`,
      finding,
    ]),
  ).values(),
].sort(
  (left, right) =>
    left.code.localeCompare(right.code) ||
    left.file.localeCompare(right.file) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.message.localeCompare(right.message),
);

if (uniqueFindings.length === 0) {
  process.stdout.write("session-chrome-ssot: PASS\n");
} else {
  process.stderr.write(
    `session-chrome-ssot: FAIL (${uniqueFindings.length} finding(s))\n`,
  );
  for (const finding of uniqueFindings) {
    const location = finding.line
      ? `${finding.file}:${finding.line}`
      : finding.file;
    process.stderr.write(
      `[${finding.code}] ${location} — ${finding.message}\n`,
    );
  }
  process.exitCode = 1;
}

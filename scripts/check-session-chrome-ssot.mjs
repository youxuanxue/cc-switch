#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const FINDING_CODES = {
  owner: "SESSION_CHROME_OWNER_BYPASS",
  visibility: "SESSION_TOC_VISIBILITY_BYPASS",
  page: "SESSION_PAGE_CHROME_FORK",
};

const OWNER_EXPORTS = [
  "toDisplayMessages",
  "buildSessionTocItems",
  "shouldRenderSessionTocSidebar",
  "shouldRenderSessionTocDialog",
];

const PAGE_CHROME_IMPORTS = ["toDisplayMessages", "buildSessionTocItems"];
const TOC_VISIBILITY_IMPORTS = [
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
const tocPath = "src/components/sessions/SessionToc.tsx";
const pagePath = "src/components/sessions/SessionManagerPage.tsx";

requireExports(
  ownerPath,
  OWNER_EXPORTS,
  FINDING_CODES.owner,
  "Session chrome owner must export the shared display/TOC APIs",
);

requireImports(
  tocPath,
  TOC_VISIBILITY_IMPORTS,
  FINDING_CODES.visibility,
  "SessionToc must consume the shared TOC visibility owner",
);

requireImports(
  pagePath,
  PAGE_CHROME_IMPORTS,
  FINDING_CODES.page,
  "Session Manager must consume the shared session chrome owner",
);

requireImports(
  pagePath,
  ["SessionTocSidebar", "SessionTocDialog"],
  FINDING_CODES.page,
  "Session Manager must render the shared TOC chrome",
);

const tocSource = sources.get(tocPath);
if (tocSource !== undefined) {
  const threshold = tocSource.match(/items\.length\s*(?:<=|<)\s*[1-9]\d*/);
  if (threshold) {
    addFinding(
      FINDING_CODES.visibility,
      tocPath,
      "SessionToc must not hide the directory behind a provider-sensitive item-count threshold",
      lineNumber(tocSource, threshold.index),
    );
  }

  for (const symbol of TOC_VISIBILITY_IMPORTS) {
    const call = tocSource.match(new RegExp(`\\b${symbol}\\s*\\(\\s*items`));
    if (!call) {
      addFinding(
        FINDING_CODES.visibility,
        tocPath,
        `SessionToc must call ${symbol}(items)`,
      );
    }
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
      `Session Manager must not rebuild chrome from provider helpers: ${forbidden.join(", ")}`,
    );
  }

  for (const component of ["SessionTocSidebar", "SessionTocDialog"]) {
    const tag = pageSource.match(new RegExp(`<${component}\\b`));
    if (!tag) {
      addFinding(
        FINDING_CODES.page,
        pagePath,
        `Session Manager must unconditionally render <${component}>`,
      );
      continue;
    }

    const prefix = pageSource.slice(Math.max(0, tag.index - 240), tag.index);
    if (
      /(?:providerId|isCodexSession|isCursorSession|isClaudeSession)\b/.test(
        prefix,
      )
    ) {
      addFinding(
        FINDING_CODES.page,
        pagePath,
        `<${component}> must not be gated by provider-specific chrome`,
        lineNumber(pageSource, tag.index),
      );
    }
  }

  if (!/\btoDisplayMessages\s*\(/.test(pageSource)) {
    addFinding(
      FINDING_CODES.page,
      pagePath,
      "Session Manager must call toDisplayMessages",
    );
  }
  if (!/\bbuildSessionTocItems\s*\(/.test(pageSource)) {
    addFinding(
      FINDING_CODES.page,
      pagePath,
      "Session Manager must call buildSessionTocItems",
    );
  }
}

const visibilityOwnerFiles = new Set([ownerPath, tocPath]);
const presentationOwnerFiles = new Set([ownerPath]);

for (const [file, source] of sources) {
  if (!file.startsWith("src/components/sessions/")) continue;

  if (!visibilityOwnerFiles.has(file)) {
    const match = source.match(
      /\bshouldRenderSessionToc(?:Sidebar|Dialog)\s*=/,
    );
    if (match) {
      addFinding(
        FINDING_CODES.visibility,
        file,
        "TOC visibility must be owned by sessionChrome.ts",
        lineNumber(source, match.index),
      );
    }
  }

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

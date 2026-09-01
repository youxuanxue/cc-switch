#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const FINDING_CODES = {
  auth: "CURSOR_AUTH_OWNER_BYPASS",
  index: "CURSOR_INDEX_OWNER_BYPASS",
  resume: "CURSOR_RESUME_OWNER_BYPASS",
  deletion: "CURSOR_DELETE_OWNER_BYPASS",
  terminal: "CURSOR_GENERIC_TERMINAL_BYPASS",
};
const RESUME_STATE_LITERALS = [
  "platformUnavailable",
  "cliMissing",
  "workspaceRequired",
  "needsLogin",
  "needsApiKey",
  "ready",
];

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }

  process.stderr.write(
    "usage: node scripts/check-cursor-session-ssot.mjs [--root <path>]\n",
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

function lineNumber(source, index) {
  return source.slice(0, Math.max(index, 0)).split("\n").length;
}

function cursorOwnedPath(path) {
  return (
    /(?:^|\/)cursor[^/]*\.(?:jsx?|tsx?)$/i.test(path) ||
    path.includes("/components/cursor/") ||
    /(?:^|\/)useCursor[^/]*\.ts$/i.test(path)
  );
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

function requireImports(file, symbols, code, message) {
  const source = sources.get(file);
  if (source === undefined) {
    addFinding(code, file, `${message}; owner file is missing`);
    return;
  }

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

requireImports(
  "src/components/cursor/CursorOfficialAuthControl.tsx",
  ["useCursorOfficial"],
  FINDING_CODES.auth,
  "Cursor authentication UI must consume the shared auth hook",
);
requireImports(
  "src/components/settings/CursorOfficialAuthSection.tsx",
  ["CursorOfficialAuthControl"],
  FINDING_CODES.auth,
  "Settings must compose the shared Cursor authentication control",
);
requireImports(
  "src/components/sessions/CursorResumeGate.tsx",
  ["CursorOfficialAuthControl", "useCursorOfficial"],
  FINDING_CODES.auth,
  "Cursor resume remediation must reuse the shared authentication owners",
);
requireImports(
  "src/components/sessions/CursorResumeGate.tsx",
  ["deriveCursorResumeState", "getSessionResumeI18nKeys"],
  FINDING_CODES.resume,
  "Cursor resume composition must use the shared state derivation",
);
requireImports(
  "src/components/sessions/SessionManagerPage.tsx",
  [
    "CursorResumeGate",
    "useSessionResumeStateQuery",
    "getSessionResumeI18nKeys",
  ],
  FINDING_CODES.resume,
  "Session Manager must delegate Cursor resume to CursorResumeGate and the shared resume-state owner",
);
requireImports(
  "src/components/sessions/SessionManagerPage.tsx",
  ["useCursorSessionIndex"],
  FINDING_CODES.index,
  "Session Manager must own Cursor index diagnostics through the shared hook",
);
requireImports(
  "src/components/sessions/SessionManagerPage.tsx",
  ["isSessionDeletable"],
  FINDING_CODES.deletion,
  "Session Manager delete decisions must use isSessionDeletable",
);

const sessionManagerPath = "src/components/sessions/SessionManagerPage.tsx";
const sessionManagerSource = sources.get(sessionManagerPath);
if (sessionManagerSource !== undefined) {
  const cursorIndexCalls = [
    ...sessionManagerSource.matchAll(/\buseCursorSessionIndex\s*\(/g),
  ];
  if (cursorIndexCalls.length === 0) {
    addFinding(
      FINDING_CODES.index,
      sessionManagerPath,
      "Session Manager must consume useCursorSessionIndex",
    );
  }
  const cursorFilteredIndexQuery =
    /^useCursorSessionIndex\s*\(\s*providerFilter\s*===\s*["']cursor["']\s*\)/;
  for (const call of cursorIndexCalls) {
    if (
      !cursorFilteredIndexQuery.test(sessionManagerSource.slice(call.index))
    ) {
      addFinding(
        FINDING_CODES.index,
        sessionManagerPath,
        "Session Manager Cursor index query must be enabled only by the Cursor filter",
        lineNumber(sessionManagerSource, call.index),
      );
    }
  }

  const genericResumeCalls = [
    ...sessionManagerSource.matchAll(/\buseSessionResumeStateQuery\s*\(/g),
  ];
  if (genericResumeCalls.length === 0) {
    addFinding(
      FINDING_CODES.resume,
      sessionManagerPath,
      "Session Manager must consume the shared resume-state query",
    );
  }
  const cursorDisabledGenericResumeQuery =
    /^useSessionResumeStateQuery\s*\(\s*isCursorSession\s*\?\s*undefined/;
  for (const call of genericResumeCalls) {
    if (
      cursorDisabledGenericResumeQuery.test(
        sessionManagerSource.slice(call.index),
      )
    ) {
      addFinding(
        FINDING_CODES.resume,
        sessionManagerPath,
        "Session Manager shared resume-state query must stay enabled for Cursor",
        lineNumber(sessionManagerSource, call.index),
      );
    }
  }
}

const authOwnerFiles = new Set([
  "src/hooks/useCursorOfficial.ts",
  "src/lib/api/cursor.ts",
]);
const resumeOwnerFiles = new Set([
  "src/components/sessions/CursorResumeGate.tsx",
  "src/components/sessions/cursorResumeState.ts",
  "src/components/sessions/liveTerminalSpawn.ts",
  "src/components/sessions/SessionManagerPage.tsx",
  "src/lib/api/cursor.ts",
]);
const indexHookConsumerFiles = new Set([
  "src/components/sessions/SessionManagerPage.tsx",
  "src/hooks/useCursorSessionIndex.ts",
]);
const indexApiOwnerFiles = new Set([
  "src/hooks/useCursorSessionIndex.ts",
  "src/lib/api/cursor.ts",
]);
const deleteOwnerFile = "src/components/sessions/sessionCapabilities.ts";
const authApiPattern =
  /cursorApi\.(?:getOfficialStatus|updateOfficialAuth|clearUserApiKey|launchLogin)\s*\(/g;
const authInvokePattern =
  /invoke\s*\(\s*["'](?:get_cursor_official_status|update_cursor_official_auth|clear_cursor_user_api_key|launch_cursor_login)["']/g;
const resumeApiPattern =
  /cursorApi\.(?:getSessionResumeContext|launchSession|launchLoginAndSession|spawnSessionPty)\s*\(/g;
const resumeInvokePattern =
  /invoke\s*\(\s*["'](?:get_cursor_session_resume_context|launch_cursor_session|launch_cursor_login_and_session|spawn_cursor_session_pty)["']/g;
const indexHookPattern = /\buseCursorSessionIndex\s*\(/g;
const indexApiPattern = /cursorApi\.getSessionIndexStatus\s*\(/g;
const indexInvokePattern =
  /invoke\s*\(\s*["']get_cursor_session_index_status["']/g;
const genericTerminalPattern =
  /sessionsApi\.(?:launchTerminal|spawnPty)\s*\(|invoke\s*\(\s*["'](?:launch_session_terminal|spawn_session_pty)["']/g;

for (const [file, source] of sources) {
  if (!indexHookConsumerFiles.has(file)) {
    indexHookPattern.lastIndex = 0;
    const match = indexHookPattern.exec(source);
    if (match) {
      addFinding(
        FINDING_CODES.index,
        file,
        "Cursor index diagnostics must be consumed only by SessionManagerPage",
        lineNumber(source, match.index),
      );
    }
  }

  if (!indexApiOwnerFiles.has(file)) {
    for (const pattern of [indexApiPattern, indexInvokePattern]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(source);
      if (match) {
        addFinding(
          FINDING_CODES.index,
          file,
          "Cursor index API bypasses useCursorSessionIndex",
          lineNumber(source, match.index),
        );
        break;
      }
    }
  }

  if (!authOwnerFiles.has(file)) {
    for (const pattern of [authApiPattern, authInvokePattern]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(source);
      if (match) {
        addFinding(
          FINDING_CODES.auth,
          file,
          "Cursor authentication bypasses useCursorOfficial/CursorOfficialAuthControl",
          lineNumber(source, match.index),
        );
        break;
      }
    }
  }

  if (!resumeOwnerFiles.has(file)) {
    for (const pattern of [resumeApiPattern, resumeInvokePattern]) {
      pattern.lastIndex = 0;
      const match = pattern.exec(source);
      if (match) {
        addFinding(
          FINDING_CODES.resume,
          file,
          "Cursor resume IPC bypasses CursorResumeGate",
          lineNumber(source, match.index),
        );
        break;
      }
    }

    if (cursorOwnedPath(file)) {
      const returnedStates = new Set(
        [...source.matchAll(/return\s+["']([^"']+)["']/g)]
          .map((match) => match[1])
          .filter((state) => RESUME_STATE_LITERALS.includes(state)),
      );
      if (returnedStates.size >= 2) {
        addFinding(
          FINDING_CODES.resume,
          file,
          `Cursor resume state is re-derived outside cursorResumeState.ts (${[
            ...returnedStates,
          ].join(", ")})`,
        );
      }
    }
  }

  if (file !== deleteOwnerFile) {
    const statements = source.split(";");
    for (const statement of statements) {
      if (
        /\bproviderId\b/.test(statement) &&
        /["']cursor["']/.test(statement) &&
        /\bsourcePath\b/.test(statement) &&
        /(?:===|!==|==|!=|Boolean\s*\(|\?|&&|\|\|)/.test(statement)
      ) {
        const index = source.indexOf(statement);
        addFinding(
          FINDING_CODES.deletion,
          file,
          "Cursor deletion eligibility is derived outside isSessionDeletable",
          lineNumber(source, index),
        );
        break;
      }
    }
  }

  genericTerminalPattern.lastIndex = 0;
  const terminalMatch = genericTerminalPattern.exec(source);
  if (terminalMatch) {
    const nearbyCursorBranch =
      /(?:providerId|isCursorSession)[\s\S]{0,240}(?:===|!==|==|!=)[\s\S]{0,80}["']cursor["'][\s\S]{0,500}(?:sessionsApi\.(?:launchTerminal|spawnPty)\s*\(|invoke\s*\(\s*["'](?:launch_session_terminal|spawn_session_pty)["'])/.test(
        source,
      );
    if (cursorOwnedPath(file) || nearbyCursorBranch) {
      addFinding(
        FINDING_CODES.terminal,
        file,
        "Cursor code must use dedicated Cursor launch IPC, never launch_session_terminal",
        lineNumber(source, terminalMatch.index),
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
  process.stdout.write("cursor-session-ssot: PASS\n");
} else {
  process.stderr.write(
    `cursor-session-ssot: FAIL (${uniqueFindings.length} finding(s))\n`,
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

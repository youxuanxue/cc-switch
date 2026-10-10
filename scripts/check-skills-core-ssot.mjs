#!/usr/bin/env node

/**
 * Skills Core SSOT:
 * - App must render SkillsCorePanel for the skills view (not UnifiedSkillsPanel)
 * - Tauri must register skills_core_* invoke commands
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FINDING_CODES = {
  appImport: "SKILLS_CORE_APP_IMPORT",
  appRender: "SKILLS_CORE_APP_RENDER",
  legacyPanel: "SKILLS_CORE_LEGACY_PANEL",
  tauriCommands: "SKILLS_CORE_TAURI_COMMANDS",
};

const REQUIRED_TAURI_COMMANDS = [
  "skills_core_preview_open",
  "skills_core_open",
  "skills_core_doctor",
  "skills_core_install",
  "skills_core_uninstall",
  "skills_core_import",
  "skills_core_sync",
  "skills_core_upgrade",
  "skills_core_follow_catalog",
  "skills_core_agents_add",
  "skills_core_agents_remove",
  "skills_core_save_local_draft",
];

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }

  process.stderr.write(
    "usage: node scripts/check-skills-core-ssot.mjs [--root <path>]\n",
  );
  process.exit(2);
}

function walkRustFiles(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walkRustFiles(path);
      if (entry.isFile() && path.endsWith(".rs")) return [path];
      return [];
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

const root = parseRoot(process.argv.slice(2));
const findings = [];

function addFinding(code, file, message) {
  findings.push({ code, file, message });
}

const appPath = resolve(root, "src/App.tsx");
if (!existsSync(appPath)) {
  addFinding(
    FINDING_CODES.appImport,
    "src/App.tsx",
    "App.tsx is missing; Skills Core wiring cannot be verified",
  );
} else {
  const appSource = readFileSync(appPath, "utf8");
  const imports = importedSymbols(appSource);

  if (!imports.has("SkillsCorePanel")) {
    addFinding(
      FINDING_CODES.appImport,
      "src/App.tsx",
      "App must import SkillsCorePanel for the skills view",
    );
  }

  if (!/<SkillsCorePanel\b/.test(appSource)) {
    addFinding(
      FINDING_CODES.appRender,
      "src/App.tsx",
      "App must render <SkillsCorePanel> for the skills view",
    );
  }

  if (/\bUnifiedSkillsPanel\b/.test(appSource)) {
    addFinding(
      FINDING_CODES.legacyPanel,
      "src/App.tsx",
      "App must not reference legacy UnifiedSkillsPanel",
    );
  }
}

const tauriRoot = resolve(root, "src-tauri");
const tauriSources = walkRustFiles(tauriRoot).map((absolutePath) =>
  readFileSync(absolutePath, "utf8"),
);
const tauriBlob = tauriSources.join("\n");

for (const command of REQUIRED_TAURI_COMMANDS) {
  if (!tauriBlob.includes(command)) {
    addFinding(
      FINDING_CODES.tauriCommands,
      "src-tauri",
      `Missing Tauri invoke registration for ${command}`,
    );
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
    left.message.localeCompare(right.message),
);

if (uniqueFindings.length === 0) {
  process.stdout.write("skills-core-ssot: PASS\n");
} else {
  process.stderr.write(
    `skills-core-ssot: FAIL (${uniqueFindings.length} finding(s))\n`,
  );
  for (const finding of uniqueFindings) {
    process.stderr.write(
      `[${finding.code}] ${finding.file} — ${finding.message}\n`,
    );
  }
  process.exitCode = 1;
}

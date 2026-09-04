#!/usr/bin/env node

/**
 * Mechanical gate for the product invariant:
 *   one session => at most one live body
 *
 * Soft rule (Jobs): 少入口、单一真身、共享大脑.
 * This script fails closed when launch paths fork a second live-session brain,
 * when inspector-noise again matches workspace paths containing "cc-switch",
 * when the in-app terminal no longer blocks / focuses on live sessions, or
 * when Cursor cleanup can remove an active chat or a non-empty project bucket.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FINDING_CODES = {
  decisionOwner: "SESSION_LIVE_DECISION_OWNER",
  launchConsumer: "SESSION_LIVE_LAUNCH_CONSUMER",
  noiseAntipattern: "SESSION_LIVE_NOISE_ANTIPATTERN",
  pruneSafety: "SESSION_LIVE_PRUNE_SAFETY",
  terminalBlock: "SESSION_LIVE_TERMINAL_BLOCK",
};

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }

  process.stderr.write(
    "usage: node scripts/check-session-live-ssot.mjs [--root <path>]\n",
  );
  process.exit(2);
}

function readRequired(root, relativePath) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    return { absolutePath, relativePath, missing: true, source: "" };
  }
  return {
    absolutePath,
    relativePath,
    missing: false,
    source: readFileSync(absolutePath, "utf8"),
  };
}

function lineNumber(source, index) {
  if (index < 0) return undefined;
  return source.slice(0, index).split("\n").length;
}

function addFinding(findings, code, file, message, line) {
  findings.push({ code, file, message, line });
}

function requireContains(findings, file, source, pattern, code, message) {
  const match = source.match(pattern);
  if (!match) {
    addFinding(findings, code, file, message);
    return;
  }
  if (match.index != null) {
    // Keep line for diagnostics when present.
    void lineNumber(source, match.index);
  }
}

const root = parseRoot(process.argv.slice(2));
const findings = [];

const resumeRs = readRequired(root, "src-tauri/src/session_manager/resume.rs");
const sessionCommands = readRequired(
  root,
  "src-tauri/src/commands/session_manager.rs",
);
const cursorOfficial = readRequired(
  root,
  "src-tauri/src/services/cursor_official.rs",
);
const cursorProvider = readRequired(
  root,
  "src-tauri/src/session_manager/providers/cursor.rs",
);
const liveTerminalPane = readRequired(
  root,
  "src/components/sessions/LiveTerminalPane.tsx",
);
const liveTerminalSpawn = readRequired(
  root,
  "src/components/sessions/liveTerminalSpawn.ts",
);

for (const file of [
  resumeRs,
  sessionCommands,
  cursorOfficial,
  cursorProvider,
  liveTerminalPane,
  liveTerminalSpawn,
]) {
  if (file.missing) {
    addFinding(
      findings,
      FINDING_CODES.decisionOwner,
      file.relativePath,
      "required live-session SSOT file is missing",
    );
  }
}

if (!resumeRs.missing) {
  requireContains(
    findings,
    resumeRs.relativePath,
    resumeRs.source,
    /pub fn resume_decision_for_session\s*\(/,
    FINDING_CODES.decisionOwner,
    "resume_decision_for_session must remain the shared live-session decision owner",
  );
  requireContains(
    findings,
    resumeRs.relativePath,
    resumeRs.source,
    /pub fn decide_resume\s*\(/,
    FINDING_CODES.decisionOwner,
    "decide_resume must remain in the shared resume owner module",
  );
  requireContains(
    findings,
    resumeRs.relativePath,
    resumeRs.source,
    /pub fn find_live_writer\s*\(/,
    FINDING_CODES.decisionOwner,
    "find_live_writer must remain in the shared resume owner module",
  );

  // Ban the regression that hid live agents whose workspace path contains
  // the substring "cc-switch".
  const noiseFn = resumeRs.source.match(
    /pub fn is_inspector_noise\([\s\S]*?\n\}/,
  );
  if (!noiseFn) {
    addFinding(
      findings,
      FINDING_CODES.noiseAntipattern,
      resumeRs.relativePath,
      "is_inspector_noise must exist in the shared resume owner",
    );
  } else {
    if (/\.contains\(\s*["']cc-switch["']\s*\)/.test(noiseFn[0])) {
      addFinding(
        findings,
        FINDING_CODES.noiseAntipattern,
        resumeRs.relativePath,
        'is_inspector_noise must not match contains("cc-switch"); only the cc-switch binary basename is noise',
        lineNumber(resumeRs.source, noiseFn.index ?? -1),
      );
    }
    if (
      !/command_basename\([\s\S]*?\)\s*==\s*["']cc-switch["']/.test(
        noiseFn[0],
      ) &&
      !/==\s*["']cc-switch["']/.test(noiseFn[0]) &&
      !/fn is_cc_switch_binary_command/.test(resumeRs.source)
    ) {
      addFinding(
        findings,
        FINDING_CODES.noiseAntipattern,
        resumeRs.relativePath,
        "is_inspector_noise must identify the cc-switch binary (basename or MacOS app path), not a path substring",
        lineNumber(resumeRs.source, noiseFn.index ?? -1),
      );
    }
  }

  requireContains(
    findings,
    resumeRs.relativePath,
    resumeRs.source,
    /fn one_live_body_invariant_holds_for_every_session_runner_with_cc_switch_workspace/,
    FINDING_CODES.decisionOwner,
    "missing regression test one_live_body_invariant_holds_for_every_session_runner_with_cc_switch_workspace",
  );
}

if (!cursorProvider.missing) {
  requireContains(
    findings,
    cursorProvider.relativePath,
    cursorProvider.source,
    /fn chat_live_probe_source_path\s*\([\s\S]*?chat_dir\.join\(\s*["']store\.db["']\s*\)/,
    FINDING_CODES.pruneSafety,
    "Cursor cleanup must probe store.db even when meta.json is missing",
  );
  requireContains(
    findings,
    cursorProvider.relativePath,
    cursorProvider.source,
    /fn remove_empty_bucket_if_needed\s*\([\s\S]*?fs::remove_dir\(\s*bucket\s*\)/,
    FINDING_CODES.pruneSafety,
    "Cursor cleanup must remove project buckets only through non-recursive remove_dir",
  );
  for (const forbidden of [
    /remove_dir_if_present\(\s*&?\s*bucket\b/,
    /remove_dir_all\(\s*&?\s*bucket\b/,
  ]) {
    const match = cursorProvider.source.match(forbidden);
    if (match) {
      addFinding(
        findings,
        FINDING_CODES.pruneSafety,
        cursorProvider.relativePath,
        "Cursor cleanup must never recursively remove a project bucket",
        lineNumber(cursorProvider.source, match.index ?? -1),
      );
    }
  }
  for (const testName of [
    "prune_retains_active_chat_with_store_db_but_no_metadata",
    "prune_never_recursively_removes_bucket_with_unknown_content",
  ]) {
    requireContains(
      findings,
      cursorProvider.relativePath,
      cursorProvider.source,
      new RegExp(`fn ${testName}\\s*\\(`),
      FINDING_CODES.pruneSafety,
      `missing Cursor cleanup regression test ${testName}`,
    );
  }
}

if (!sessionCommands.missing) {
  const source = sessionCommands.source;
  for (const [fnName, label] of [
    ["launch_session_terminal", "external terminal launch"],
    ["spawn_session_pty", "in-app PTY spawn"],
  ]) {
    const start = source.search(
      new RegExp(`(?:pub\\s+)?async\\s+fn\\s+${fnName}\\b`),
    );
    if (start < 0) {
      addFinding(
        findings,
        FINDING_CODES.launchConsumer,
        sessionCommands.relativePath,
        `${label} (${fnName}) is missing`,
      );
      continue;
    }
    const rest = source.slice(start + 1);
    const nextRel = rest.search(
      /\n(?:#\[tauri::command\]|(?:pub\s+)?async\s+fn\s+)/,
    );
    const body =
      nextRel >= 0
        ? source.slice(start, start + 1 + nextRel)
        : source.slice(start);
    if (!body.includes("resume_decision_for_session")) {
      addFinding(
        findings,
        FINDING_CODES.launchConsumer,
        sessionCommands.relativePath,
        `${label} (${fnName}) must call resume_decision_for_session before spawning`,
      );
    }
  }
}

if (!cursorOfficial.missing) {
  requireContains(
    findings,
    cursorOfficial.relativePath,
    cursorOfficial.source,
    /fn reuse_live_session\s*\([\s\S]*?resume_decision_for_session\s*\(/,
    FINDING_CODES.launchConsumer,
    "Cursor reuse_live_session must call the shared resume_decision_for_session",
  );
  requireContains(
    findings,
    cursorOfficial.relativePath,
    cursorOfficial.source,
    /launch_resume_with[\s\S]*?reuse_live_session\s*\(/,
    FINDING_CODES.launchConsumer,
    "Cursor launch_resume_with must consult reuse_live_session before preparing a launcher",
  );
  requireContains(
    findings,
    cursorOfficial.relativePath,
    cursorOfficial.source,
    /live_writer_source_path\s*\(\s*&record\.metadata_path\s*\)/,
    FINDING_CODES.launchConsumer,
    "Cursor live-session probe must use store.db (live_writer_source_path), not meta.json",
  );
}

if (!liveTerminalPane.missing) {
  requireContains(
    findings,
    liveTerminalPane.relativePath,
    liveTerminalPane.source,
    /onBlocked\?\.\(/,
    FINDING_CODES.terminalBlock,
    "LiveTerminalPane must expose/call onBlocked when a live session refuses in-app spawn",
  );
  // focused + occupied must both block
  for (const kind of ["focused", "occupied"]) {
    const kindBlock = new RegExp(
      `result\\.kind === ["']${kind}["'][\\s\\S]{0,400}onBlocked`,
    );
    if (!kindBlock.test(liveTerminalPane.source)) {
      addFinding(
        findings,
        FINDING_CODES.terminalBlock,
        liveTerminalPane.relativePath,
        `LiveTerminalPane must call onBlocked when spawn result is ${kind}`,
      );
    }
  }
  requireContains(
    findings,
    liveTerminalPane.relativePath,
    liveTerminalPane.source,
    /liveTerminalAlreadyLive/,
    FINDING_CODES.terminalBlock,
    "LiveTerminalPane must toast the liveTerminalAlreadyLive error when focusing an existing host",
  );
}

if (!liveTerminalSpawn.missing) {
  requireContains(
    findings,
    liveTerminalSpawn.relativePath,
    liveTerminalSpawn.source,
    /cursorApi\.spawnSessionPty\s*\(/,
    FINDING_CODES.launchConsumer,
    "Cursor in-app spawn must use cursorApi.spawnSessionPty",
  );
  requireContains(
    findings,
    liveTerminalSpawn.relativePath,
    liveTerminalSpawn.source,
    /sessionsApi\.spawnPty\s*\(/,
    FINDING_CODES.launchConsumer,
    "non-Cursor in-app spawn must use sessionsApi.spawnPty",
  );
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
  process.stdout.write("session-live-ssot: PASS\n");
} else {
  process.stderr.write(
    `session-live-ssot: FAIL (${uniqueFindings.length} finding(s))\n`,
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

#!/usr/bin/env node

/**
 * TokenKey / Gemini model discovery SSOT:
 * model_fetch.rs must retain catalog_and_gemini_model_ids and Gemini Native auth path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FINDING_CODES = {
  missing: "GEMINI_MODEL_FETCH_OWNER_MISSING",
  parser: "GEMINI_MODEL_FETCH_PARSER",
  auth: "GEMINI_MODEL_FETCH_AUTH",
  format: "GEMINI_MODEL_FETCH_FORMAT",
};

const OWNER_PATH = "src-tauri/src/services/model_fetch.rs";

const REQUIRED_MARKERS = [
  {
    code: FINDING_CODES.parser,
    pattern: /\bfn\s+catalog_and_gemini_model_ids\b/,
    message:
      "model_fetch.rs must define catalog_and_gemini_model_ids for Gemini Native model lists",
  },
  {
    code: FINDING_CODES.parser,
    pattern: /catalog_and_gemini_model_ids\s*\(\s*response\.models\s*\)/,
    message:
      "normalize_models_response must merge catalog_and_gemini_model_ids(response.models)",
  },
  {
    code: FINDING_CODES.format,
    pattern: /google-generative-ai/,
    message:
      "model_fetch.rs must retain google-generative-ai api_format handling",
  },
  {
    code: FINDING_CODES.auth,
    pattern: /x-goog-api-key/,
    message:
      "model_fetch.rs must retain x-goog-api-key header path for Gemini Native fetch",
  },
];

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1]) {
    return resolve(argv[1]);
  }

  process.stderr.write(
    "usage: node scripts/check-gemini-model-fetch-ssot.mjs [--root <path>]\n",
  );
  process.exit(2);
}

const root = parseRoot(process.argv.slice(2));
const ownerFile = resolve(root, OWNER_PATH);
const findings = [];

function addFinding(code, file, message) {
  findings.push({ code, file, message });
}

if (!existsSync(ownerFile)) {
  addFinding(
    FINDING_CODES.missing,
    OWNER_PATH,
    "model_fetch.rs owner file is missing",
  );
} else {
  const source = readFileSync(ownerFile, "utf8");
  for (const marker of REQUIRED_MARKERS) {
    if (!marker.pattern.test(source)) {
      addFinding(marker.code, OWNER_PATH, marker.message);
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
    left.message.localeCompare(right.message),
);

if (uniqueFindings.length === 0) {
  process.stdout.write("gemini-model-fetch-ssot: PASS\n");
} else {
  process.stderr.write(
    `gemini-model-fetch-ssot: FAIL (${uniqueFindings.length} finding(s))\n`,
  );
  for (const finding of uniqueFindings) {
    process.stderr.write(
      `[${finding.code}] ${finding.file} — ${finding.message}\n`,
    );
  }
  process.exitCode = 1;
}

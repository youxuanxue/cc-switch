import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const checkerPath = resolve(
  process.cwd(),
  "scripts/check-gemini-model-fetch-ssot.mjs",
);
const fixtureRoots: string[] = [];

function writeFixtureFile(root: string, path: string, source: string) {
  const absolutePath = resolve(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source);
}

function createConformingFixture() {
  const root = mkdtempSync(
    resolve(tmpdir(), "cc-switch-gemini-model-fetch-ssot-"),
  );
  fixtureRoots.push(root);

  writeFixtureFile(
    root,
    "src-tauri/src/services/model_fetch.rs",
    [
      "fn catalog_and_gemini_model_ids(models: Option<serde_json::Value>) -> Vec<String> { vec![] }",
      "fn normalize_models_response(response: ModelsResponse) -> Vec<FetchedModel> {",
      "  catalog_and_gemini_model_ids(response.models);",
      "  vec![]",
      "}",
      'fn build_model_fetch_headers() { let _ = "google-generative-ai"; let _ = "x-goog-api-key"; }',
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

describe("gemini model fetch SSOT checker", () => {
  it("accepts a fixture that retains Gemini discovery markers", () => {
    const result = runChecker(createConformingFixture());

    expect(result.status).toBe(0);
    expect(result.output).toContain("gemini-model-fetch-ssot: PASS");
  });

  it("passes against the real repository", () => {
    const result = runChecker(process.cwd());

    expect(result.status).toBe(0);
    expect(result.output).toContain("gemini-model-fetch-ssot: PASS");
  });

  it("rejects model_fetch.rs without catalog_and_gemini_model_ids", () => {
    const root = createConformingFixture();
    writeFixtureFile(
      root,
      "src-tauri/src/services/model_fetch.rs",
      'fn normalize() { let _ = "google-generative-ai"; let _ = "x-goog-api-key"; }',
    );

    const result = runChecker(root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("GEMINI_MODEL_FETCH_PARSER");
  });
});

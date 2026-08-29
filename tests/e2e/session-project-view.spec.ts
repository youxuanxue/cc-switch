import { expect, test } from "@playwright/test";
import { installTauriIpcHarness } from "./tauriIpcHarness";

const CURSOR_SESSION_ID = "11111111-1111-4111-8111-111111111111";

test("aggregates Cursor and Codex sessions under the same project", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    sessions: [
      {
        providerId: "cursor",
        sessionId: CURSOR_SESSION_ID,
        title: "Cursor Shared",
        projectDir: "/work/acme/app/",
        createdAt: 100,
        lastActiveAt: 400,
      },
      {
        providerId: "codex",
        sessionId: "codex-shared",
        title: "Codex Shared",
        projectDir: "/work/acme/app",
        lastActiveAt: 300,
        sourcePath: "/tmp/codex-shared.jsonl",
        resumeCommand: "codex resume codex-shared",
      },
      {
        providerId: "claude",
        sessionId: "claude-other",
        title: "Claude Other",
        projectDir: "/work/acme/docs",
        lastActiveAt: 200,
        sourcePath: "/tmp/claude-other.jsonl",
        resumeCommand: "claude --resume claude-other",
      },
    ],
    resumeContext: {
      workspaceState: "ready",
      workspace: "/work/acme/app",
    },
  });

  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "展开或折叠 app 项目分组" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "展开或折叠 docs 项目分组" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Cursor Shared/ })).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "展开或折叠 app 项目分组" }).click();
  await expect(page.getByRole("button", { name: /Cursor Shared/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Codex Shared/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Claude Other/ }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: /Cursor Shared/ }).click();
  await expect(
    page.getByText(
      `agent --workspace /work/acme/app --resume ${CURSOR_SESSION_ID}`,
    ),
  ).toBeVisible();
});

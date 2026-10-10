import { expect, test } from "@playwright/test";
import { installTauriIpcHarness } from "./tauriIpcHarness";

const CURSOR_SESSION_ID = "11111111-1111-4111-8111-111111111111";
test("aggregates Cursor and Codex sessions under the same project", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    lastApp: "claude",
    groupMode: "project",
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

  await page.getByRole("button", { name: /^应用：/ }).click();
  const allAppsItem = page.getByRole("menuitemradio", { name: /^全部应用/ });
  await expect(allAppsItem).toBeVisible();
  await allAppsItem.click();

  const list = page.getByRole("region", { name: "会话列表" });
  await expect(
    list.getByRole("button").filter({ hasText: "app" }),
  ).toBeVisible();
  await expect(
    list.getByRole("button").filter({ hasText: "docs" }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Cursor Shared", exact: true }),
  ).toHaveCount(0);

  const appGroup = list
    .getByRole("button", { name: /^app\b/ })
    .first();
  await appGroup.click();
  await expect(
    list.getByRole("button", { name: "Cursor Shared", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Codex Shared", exact: true }),
  ).toBeVisible();
  await expect(
    list.getByRole("button", { name: "Claude Other", exact: true }),
  ).toHaveCount(0);

  await list.getByRole("button", { name: "Cursor Shared", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "恢复会话", exact: true }),
  ).toBeVisible();
});

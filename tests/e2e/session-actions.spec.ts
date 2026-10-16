import { expect, test } from "@playwright/test";
import { getRecordedInvokes, installTauriIpcHarness } from "./tauriIpcHarness";

const cleanupSessions = ["Idle", "Live"].map((title) => ({
  providerId: "codex",
  sessionId: title,
  title,
  projectDir: "/work/acme/app",
  sourcePath: `/tmp/${title}.jsonl`,
  lastActiveAt: Date.now(),
}));

test(
  "Codex provider override reaches every resume action unchanged",
  { tag: "@fork-session-codex-resume-provider" },
  async ({ page, context }) => {
    const command = "codex resume old-thread -c 'model_provider=\"custom\"'";
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await installTauriIpcHarness(page, {
      lastApp: "codex",
      expandedProjects: ["/work/acme/app"],
      sessions: [
        {
          providerId: "codex",
          sessionId: "old-thread",
          title: "Old TokenKey session",
          projectDir: "/work/acme/app",
          sourcePath: "/tmp/old-thread.jsonl",
          lastActiveAt: Date.now(),
          resumeCommand: command,
        },
      ],
    });
    await page.goto("/");
    const row = page.getByRole("button", {
      name: "Old TokenKey session",
      exact: true,
    });
    await row.hover();
    await page
      .getByRole("button", { name: /在 .* 中恢复 Old TokenKey session/ })
      .click();
    await expect
      .poll(async () =>
        (await getRecordedInvokes(page))
          .filter((call) => call.command === "launch_session_terminal")
          .map((call) => ({
            command: call.payload.command,
            cwd: call.payload.cwd,
          })),
      )
      .toEqual([{ command, cwd: "/work/acme/app" }]);
    await row.hover();
    await page
      .getByRole("button", {
        name: "复制「Old TokenKey session」的恢复命令",
        exact: true,
      })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(command);

    await row.click();
    await page.getByRole("button", { name: "恢复会话", exact: true }).click();
    await expect
      .poll(async () =>
        (await getRecordedInvokes(page))
          .filter((call) => call.command === "launch_session_terminal")
          .map((call) => call.payload.command),
      )
      .toEqual([command, command]);
    await page
      .getByRole("button", { name: "更多恢复方式", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /复制恢复命令/ }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(command);
    await page.getByRole("button", { name: "站内终端", exact: true }).click();
    await expect
      .poll(async () =>
        (await getRecordedInvokes(page))
          .filter((call) => call.command === "spawn_session_pty")
          .map((call) => ({
            command: call.payload.command,
            cwd: call.payload.cwd,
            sessionId: call.payload.sessionId,
          })),
      )
      .toEqual([{ command, cwd: "/work/acme/app", sessionId: "old-thread" }]);
    await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  },
);

test(
  "inactive cleanup excludes live sessions and waits for confirmation",
  { tag: "@fork-session-live-cleanup" },
  async ({ page }) => {
    await installTauriIpcHarness(page, {
      lastApp: "codex",
      sessions: cleanupSessions,
      liveSessionIds: ["Live"],
      expandedProjects: ["/work/acme/app"],
    });
    await page.goto("/");
    await page.getByRole("button", { name: "清理会话", exact: true }).click();
    const cleanup = page.getByRole("dialog", { name: "清理会话" });
    await cleanup.getByRole("tab", { name: "全部未活跃" }).click();
    await cleanup.getByRole("button", { name: "继续删除" }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Idle");
    await expect(confirmation).not.toContainText("Live");
    expect(
      (await getRecordedInvokes(page)).filter((call) =>
        call.command.startsWith("delete_session"),
      ),
    ).toEqual([]);
    await confirmation
      .getByRole("button", { name: "删除会话", exact: true })
      .click();
    const list = page.getByRole("region", { name: "会话列表" });
    await expect(
      list.getByRole("button", { name: "Idle", exact: true }),
    ).toHaveCount(0);
    await expect(
      list.getByRole("button", { name: "Live", exact: true }),
    ).toBeVisible();
    const deleted = (await getRecordedInvokes(page)).filter((call) =>
      call.command.startsWith("delete_session"),
    );
    expect(
      deleted.map((call) => ({
        command: call.command,
        sessionId: call.payload.sessionId,
      })),
    ).toEqual([{ command: "delete_session", sessionId: "Idle" }]);
  },
);

test(
  "cleanup fails closed when live status is unavailable",
  { tag: "@fork-session-cleanup-probe-failure" },
  async ({ page }) => {
    await installTauriIpcHarness(page, {
      lastApp: "codex",
      sessions: cleanupSessions,
      liveProbeError: "Live status unavailable",
    });
    await page.goto("/");
    await page.getByRole("button", { name: "清理会话", exact: true }).click();
    const cleanup = page.getByRole("dialog", { name: "清理会话" });
    await cleanup.getByRole("tab", { name: "全部未活跃" }).click();
    await expect(cleanup).toContainText("Live status unavailable");
    await expect(
      cleanup.getByRole("button", { name: "继续删除" }),
    ).toBeDisabled();
    await cleanup.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      (await getRecordedInvokes(page)).filter((call) =>
        call.command.startsWith("delete_session"),
      ),
    ).toEqual([]);
  },
);

test(
  "session actions are direct and project selection respects the current search",
  { tag: "@fork-session-actions" },
  async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 650 });
    await installTauriIpcHarness(page, {
      view: "sessions",
      lastApp: "codex",
      sessions: ["Alpha", "Beta"].map((title) => ({
        providerId: "codex",
        sessionId: title,
        title,
        projectDir: "/work/acme/app",
        sourcePath: `/tmp/${title}.jsonl`,
        lastActiveAt: Date.now(),
        resumeCommand: `codex resume ${title}`,
      })),
    });
    await page.goto("/");
    const refresh = page.getByRole("button", { name: "刷新列表", exact: true });
    await expect(refresh).toBeEnabled();
    const callsBefore = (await getRecordedInvokes(page)).filter(
      (call) => call.command === "list_sessions",
    ).length;
    await refresh.click();
    await expect
      .poll(
        async () =>
          (await getRecordedInvokes(page)).filter(
            (call) => call.command === "list_sessions",
          ).length,
      )
      .toBeGreaterThan(callsBefore);
    await expect(refresh).toBeEnabled();

    await page.getByRole("button", { name: "选择多个", exact: true }).click();
    const project = page.getByRole("checkbox", {
      name: "选择 app 项目分组内会话",
    });
    await project.check();
    await expect(
      page.getByText("已选 2 个会话", { exact: true }),
    ).toBeVisible();
    await project.uncheck();
    await expect(
      page.getByText("还没有选择会话", { exact: true }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: "搜索会话" }).fill("Alpha");
    await project.check();
    await expect(
      page.getByText("已选 1 个会话", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "删除 1 个会话", exact: true })
      .click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("Alpha");
    await expect(confirmation).not.toContainText("Beta");
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    expect(
      (await getRecordedInvokes(page)).filter((call) =>
        call.command.startsWith("delete_session"),
      ),
    ).toEqual([]);
    await page.getByRole("button", { name: "退出选择", exact: true }).click();

    await page.getByRole("textbox", { name: "搜索会话" }).fill("");
    await page.getByRole("button", { name: "新建会话", exact: true }).click();
    const create = page.getByRole("dialog", { name: "新建会话" });
    await create
      .getByRole("textbox", { name: "项目目录", exact: true })
      .fill("");
    await expect(
      create.getByRole("button", { name: "打开会话" }),
    ).toBeDisabled();
    await create
      .getByRole("textbox", { name: "项目目录", exact: true })
      .fill("/work/acme/app");
    await create.getByRole("button", { name: "打开会话" }).click();
    await expect
      .poll(async () =>
        (await getRecordedInvokes(page))
          .filter((call) => call.command === "launch_session_terminal")
          .map((call) => ({
            command: call.payload.command,
            cwd: call.payload.cwd,
          })),
      )
      .toEqual([{ command: "codex", cwd: "/work/acme/app" }]);
    await expect(create).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("sessions-900.png") });
  },
);

test(
  "empty sessions still allow storage cleanup without deleting anything",
  { tag: "@fork-session-empty-cleanup" },
  async ({ page }) => {
    await installTauriIpcHarness(page, { sessions: [] });
    await page.goto("/");
    await page.getByRole("button", { name: "清理会话", exact: true }).click();
    const cleanup = page.getByRole("dialog", { name: "清理会话" });
    await expect(
      cleanup.getByRole("button", { name: "清理空会话目录" }),
    ).toBeEnabled();
    await expect(
      cleanup.getByRole("button", { name: "清理旧 worktree" }),
    ).toBeEnabled();
    await cleanup.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      (await getRecordedInvokes(page)).filter((call) =>
        /delete_session|prune_session|launch_session/.test(call.command),
      ),
    ).toEqual([]);
  },
);

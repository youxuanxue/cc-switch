import { expect, test, type Locator, type Page } from "@playwright/test";
import { getRecordedInvokes, installTauriIpcHarness } from "./tauriIpcHarness";

const READY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const PROJECT_ONE_KEY = "/work/acme/project-one";
const PROJECT_TWO_KEY = "/work/acme/project-two";

async function openAppChooser(page: Page) {
  await page.getByRole("button", { name: /^应用：/ }).click();
  const item = page.getByRole("menuitemradio", { name: /^全部应用/ });
  await expect(item).toBeVisible();
}


async function selectCursor(page: Page) {
  const appTrigger = page.getByRole("button", { name: /^应用：/ });
  if (await appTrigger.getByText("Cursor", { exact: true }).isVisible()) {
    return;
  }
  await openAppChooser(page);
  await page.getByRole("menuitemradio", { name: /^Cursor/ }).click();
}


function sessionOpenButton(list: Locator, title: string) {
  return list.getByRole("button", { name: title, exact: true });
}

test("US-001/US-004 groups Cursor sessions by cwd without exposing unsupported capabilities", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    groupMode: "project",
    expandedProjects: [PROJECT_ONE_KEY, PROJECT_TWO_KEY],
    sessions: [
      {
        providerId: "cursor",
        sessionId: READY_SESSION_ID,
        title: "Cursor Alpha",
        projectDir: "/work/acme/project-one",
        createdAt: 100,
        lastActiveAt: 400,
        sourcePath: `/mock/cursor/chats/acme/${READY_SESSION_ID}/store.db`,
      },
      {
        providerId: "cursor",
        sessionId: SECOND_SESSION_ID,
        title: "Cursor Beta",
        projectDir: "/work/acme/project-one",
        createdAt: 90,
        lastActiveAt: 300,
      },
      {
        providerId: "cursor",
        sessionId: "33333333-3333-4333-8333-333333333333",
        title: "Cursor Gamma",
        projectDir: "/work/acme/project-two",
        createdAt: 80,
        lastActiveAt: 200,
      },
      {
        providerId: "codex",
        sessionId: "codex-fixture",
        title: "Codex Fixture",
        projectDir: "/work/acme/codex",
        lastActiveAt: 100,
        sourcePath: "/tmp/codex-fixture.jsonl",
        resumeCommand: "codex resume codex-fixture",
      },
    ],
    resumeContext: {
      workspaceState: "ready",
      workspace: "/work/acme/project-one",
    },
  });

  await page.goto("/");
  await selectCursor(page);

  const list = page.getByRole("region", { name: "会话列表" });
  await expect(
    list.getByRole("button").filter({ hasText: "project-one" }),
  ).toBeVisible();
  await expect(
    list.getByRole("button").filter({ hasText: "project-two" }),
  ).toBeVisible();

  await expect(sessionOpenButton(list, "Cursor Alpha")).toBeVisible();
  await expect(sessionOpenButton(list, "Cursor Beta")).toBeVisible();
  await sessionOpenButton(list, "Cursor Alpha").click();

  await expect(page.getByRole("button", { name: "恢复会话", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "对话记录" })).toBeVisible();
  await expect(page.getByText(/消息数/)).toHaveCount(0);
  await expect(
    page.getByText(/supported|conditional|unsupported/i),
  ).toHaveCount(0);
  await expect(page.getByText("技术详情")).toHaveCount(0);
  await expect(
    page.getByText(/^agent --workspace /),
  ).toHaveCount(0);

  const calls = await getRecordedInvokes(page);
  expect(calls.some((call) => call.command.startsWith("project"))).toBe(false);
});

test("US-001 shows an unavailable Cursor index in the real empty-state journey", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    sessions: [],
    cursorIndexStatus: {
      state: "indexUnavailable",
      reason: "metadata layout is not recognized",
    },
  });

  await page.goto("/");
  await selectCursor(page);

  const warning = page.getByRole("status").filter({
    hasText: "Cursor 会话索引不可用",
  });
  await expect(warning).toContainText("Cursor 会话索引不可用");
  await expect(warning).toContainText("metadata layout is not recognized");
  await expect(page.getByText("未发现会话", { exact: true })).toHaveCount(0);
});

test("US-002 resumes a ready Cursor session only through the dedicated IPC", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    expandedProjects: ["/work/acme/ready"],
    sessions: [
      {
        providerId: "cursor",
        sessionId: READY_SESSION_ID,
        title: "Cursor Ready",
        projectDir: "/work/acme/ready",
        lastActiveAt: 400,
      },
    ],
  });

  await page.goto("/");
  await selectCursor(page);
  const list = page.getByRole("region", { name: "会话列表" });
  await sessionOpenButton(list, "Cursor Ready").click();
  await expect(
    page.getByRole("heading", { name: "Cursor Ready" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复会话", exact: true }).click();

  await expect
    .poll(async () =>
      (await getRecordedInvokes(page)).filter(
        (call) => call.command === "launch_cursor_session",
      ),
    )
    .toEqual([
      {
        command: "launch_cursor_session",
        payloadKeys: ["sessionId", "workspaceOverride"],
        payload: {
          sessionId: READY_SESSION_ID,
        },
      },
    ]);

  const calls = await getRecordedInvokes(page);
  expect(calls.some((call) => call.command === "launch_session_terminal")).toBe(
    false,
  );
});

test("US-002 keeps a canonical workspace through Login and continue", async ({
  page,
}) => {
  await installTauriIpcHarness(page, {
    view: "sessions",
    expandedProjects: ["/work/acme/missing"],
    sessions: [
      {
        providerId: "cursor",
        sessionId: READY_SESSION_ID,
        title: "Cursor Moved Workspace",
        projectDir: "/work/acme/missing",
        lastActiveAt: 400,
      },
    ],
    cursorStatus: {
      installed: true,
      version: "agent 2026.08",
      authMode: "login",
      hasUserApiKey: false,
      authenticated: false,
      state: "needsLogin",
    },
    resumeContext: { workspaceState: "workspaceRequired" },
    pickedDirectories: ["/work/acme/chosen"],
    canonicalWorkspaces: {
      "/work/acme/chosen": "/work/acme/canonical",
    },
  });

  await page.goto("/");
  await selectCursor(page);
  const list = page.getByRole("region", { name: "会话列表" });
  await sessionOpenButton(list, "Cursor Moved Workspace").click();
  await page
    .getByRole("button", { name: "选择目录并继续", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "登录并继续", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "登录并继续", exact: true }).click();

  await expect
    .poll(async () =>
      (await getRecordedInvokes(page)).filter(
        (call) => call.command === "launch_cursor_login_and_session",
      ),
    )
    .toEqual([
      {
        command: "launch_cursor_login_and_session",
        payloadKeys: ["sessionId", "workspaceOverride"],
        payload: {
          sessionId: READY_SESSION_ID,
          workspaceOverride: "/work/acme/canonical",
        },
      },
    ]);

  const calls = await getRecordedInvokes(page);
  expect(
    calls.some(
      (call) =>
        call.command === "launch_cursor_session" ||
        call.command === "launch_session_terminal",
    ),
  ).toBe(false);
});

test("US-005 reads Cursor conversation history through the shared session chrome", async ({
  page,
}) => {
  const storePath = "/mock/cursor/chats/workspace/store.db";
  await installTauriIpcHarness(page, {
    view: "sessions",
    expandedProjects: ["/work/acme/ready"],
    sessions: [
      {
        providerId: "cursor",
        sessionId: READY_SESSION_ID,
        title: "Cursor Transcript",
        projectDir: "/work/acme/ready",
        lastActiveAt: 400,
        sourcePath: storePath,
      },
    ],
    resumeContext: {
      workspaceState: "ready",
      workspace: "/work/acme/ready",
    },
    sessionMessages: {
      [`cursor:${storePath}`]: [
        {
          role: "user",
          content: "<user_info>\nOS Version: darwin\n</user_info>",
        },
        {
          role: "user",
          content:
            "<timestamp>Saturday Aug 29, 2026, 7:54 PM</timestamp>\n<user_query>continue the cursor task</user_query>",
        },
        { role: "assistant", content: "working on it" },
      ],
    },
  });

  await page.goto("/");
  await selectCursor(page);
  const list = page.getByRole("region", { name: "会话列表" });
  await sessionOpenButton(list, "Cursor Transcript").click();
  await expect(
    page.getByRole("heading", { name: "Cursor Transcript" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "对话记录" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "恢复会话", exact: true }),
  ).toBeVisible();
  const transcript = page.getByRole("region", { name: "对话内容" });
  await expect(transcript.getByText(/continue the cursor task/)).toBeVisible();
  await expect(transcript.getByText("working on it")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "对话目录" })
      .getByRole("button")
      .filter({ hasText: "continue the cursor task" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "恢复会话", exact: true }).click();
  await expect
    .poll(async () =>
      (await getRecordedInvokes(page)).filter(
        (call) => call.command === "launch_cursor_session",
      ),
    )
    .toEqual([
      {
        command: "launch_cursor_session",
        payloadKeys: ["sessionId", "workspaceOverride"],
        payload: {
          sessionId: READY_SESSION_ID,
        },
      },
    ]);
  expect(
    (await getRecordedInvokes(page)).some(
      (call) => call.command === "launch_session_terminal",
    ),
  ).toBe(false);
});

test("US-003 manages Cursor Official User API Key without echoing or recording it", async ({
  page,
}) => {
  const secret = "cursor-e2e-secret";
  await installTauriIpcHarness(page, {
    view: "auth",
    cursorStatus: {
      installed: true,
      version: "agent 2026.08",
      authMode: "login",
      hasUserApiKey: false,
      authenticated: false,
      state: "needsLogin",
    },
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "授权中心" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录 Cursor" })).toBeVisible();
  await expect(page.getByLabel("Cursor User API Key")).toHaveCount(0);

  await page.getByRole("button", { name: "其他方式", exact: true }).click();
  await page.getByLabel("Cursor User API Key").fill(secret);
  await page.getByRole("button", { name: "保存 User API Key" }).click();

  await expect(
    page.getByText("已配置 ••••••••", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(secret)).toHaveCount(0);
  expect(
    await page
      .locator("input")
      .evaluateAll(
        (inputs, submittedSecret) =>
          inputs.some(
            (input) => (input as HTMLInputElement).value === submittedSecret,
          ),
        secret,
      ),
  ).toBe(false);
  await expect(
    page.getByText(/supported|conditional|unsupported/i),
  ).toHaveCount(0);

  const technicalDetails = page.locator("details").filter({
    has: page.getByText("技术详情", { exact: true }),
  });
  await expect(technicalDetails).not.toHaveAttribute("open", "");

  const updateCall = (await getRecordedInvokes(page)).find(
    (call) => call.command === "update_cursor_official_auth",
  );
  expect(updateCall).toEqual({
    command: "update_cursor_official_auth",
    payloadKeys: ["authMode", "userApiKey"],
    payload: {
      authMode: "userApiKey",
      userApiKey: "[REDACTED]",
    },
  });
  expect(JSON.stringify(await getRecordedInvokes(page))).not.toContain(secret);
});

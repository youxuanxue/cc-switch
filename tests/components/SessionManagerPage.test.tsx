import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManagerPage } from "@/components/sessions/SessionManagerPage";
import { piApi } from "@/lib/api/pi";
import { sessionsApi } from "@/lib/api/sessions";
import * as platform from "@/lib/platform";
import type { SessionMessage, SessionMeta } from "@/types";
import { setSessionFixtures } from "../msw/state";

const cursorApiMocks = vi.hoisted(() => ({
  getOfficialStatus: vi.fn(),
  updateOfficialAuth: vi.fn(),
  clearUserApiKey: vi.fn(),
  getSessionIndexStatus: vi.fn(),
  getSessionResumeContext: vi.fn(),
  launchSession: vi.fn(),
  launchLogin: vi.fn(),
  launchLoginAndSession: vi.fn(),
}));

const platformMocks = vi.hoisted(() => ({
  isMac: vi.fn(),
}));

vi.mock("@/lib/api/cursor", () => ({
  cursorApi: {
    getOfficialStatus: (...args: unknown[]) =>
      cursorApiMocks.getOfficialStatus(...args),
    updateOfficialAuth: (...args: unknown[]) =>
      cursorApiMocks.updateOfficialAuth(...args),
    clearUserApiKey: (...args: unknown[]) =>
      cursorApiMocks.clearUserApiKey(...args),
    getSessionIndexStatus: (...args: unknown[]) =>
      cursorApiMocks.getSessionIndexStatus(...args),
    getSessionResumeContext: (...args: unknown[]) =>
      cursorApiMocks.getSessionResumeContext(...args),
    launchSession: (...args: unknown[]) =>
      cursorApiMocks.launchSession(...args),
    launchLogin: (...args: unknown[]) => cursorApiMocks.launchLogin(...args),
    launchLoginAndSession: (...args: unknown[]) =>
      cursorApiMocks.launchLoginAndSession(...args),
  },
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => platformMocks.isMac(),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const GROUP_EXPANSION_STORAGE_KEY =
  "cc-switch.sessionManager.groupExpansionState";

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/sessions/SessionToc", () => ({
  SessionTocSidebar: ({ items }: { items: { preview: string }[] }) => (
    <aside
      data-testid="session-toc-sidebar"
      data-item-count={String(items.length)}
      data-previews={items.map((item) => item.preview).join("|")}
    />
  ),
  SessionTocDialog: ({ items }: { items: { preview: string }[] }) =>
    items.length > 0 ? (
      <div
        data-testid="session-toc-dialog"
        data-item-count={String(items.length)}
      />
    ) : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmText,
    cancelText,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div>{title}</div>
        <div>{message}</div>
        <button onClick={onConfirm}>{confirmText}</button>
        <button onClick={onCancel}>{cancelText}</button>
      </div>
    ) : null,
}));

const renderPage = (appId = "codex") => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionManagerPage appId={appId} />
      </QueryClientProvider>,
    ),
  };
};

const openSearch = () => {
  const searchButton = Array.from(screen.getAllByRole("button")).find(
    (button) => button.querySelector(".lucide-search"),
  );

  if (!searchButton) {
    throw new Error("Search button not found");
  }

  fireEvent.click(searchButton);
};

const closeSearch = () => {
  const closeButton = Array.from(screen.getAllByRole("button")).find((button) =>
    button.querySelector(".lucide-x"),
  );

  if (!closeButton) {
    throw new Error("Search close button not found");
  }

  fireEvent.click(closeButton);
};

const openViewModeMenu = async () => {
  await userEvent.click(screen.getByRole("combobox", { name: /查看方式/i }));
};

const switchToGroupedView = async () => {
  await openViewModeMenu();
  const groupedOption = await screen.findByRole("option", { name: /分类/i });
  await userEvent.click(groupedOption);
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /分类/i }),
    ).not.toBeInTheDocument(),
  );
};

const switchToProjectView = async () => {
  await openViewModeMenu();
  const projectOption = await screen.findByRole("option", { name: /项目/i });
  await userEvent.click(projectOption);
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /项目/i }),
    ).not.toBeInTheDocument(),
  );
};

const switchToFlatView = async () => {
  await openViewModeMenu();
  const flatOption = await screen.findByRole("option", { name: /列表/i });
  await userEvent.click(flatOption);
  await waitFor(() =>
    expect(
      screen.queryByRole("option", { name: /列表/i }),
    ).not.toBeInTheDocument(),
  );
};

const expandProjectGroup = (project: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${project} 项目分组`),
    }),
  );
};

const switchProviderFilter = async (providerLabel: RegExp) => {
  const providerFilterTrigger = screen.getByRole("combobox", {
    name: /供应商筛选/i,
  });

  await userEvent.click(providerFilterTrigger);
  await userEvent.click(
    await screen.findByRole("option", { name: providerLabel }),
  );
};

const waitForHeading = async (name: string) => {
  await waitFor(() =>
    expect(screen.getByRole("heading", { name })).toBeInTheDocument(),
  );
};

const filterToCodex = async () => {
  await switchProviderFilter(/Codex/i);
  await waitForHeading("Alpha Session");
};

const filterToCursor = async () => {
  await switchProviderFilter(/Cursor/i);
};

const enterGroupedBatchMode = async () => {
  await switchToGroupedView();
  fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
};

const collapseAllGroups = () => {
  fireEvent.click(screen.getByRole("button", { name: /全部收起/i }));
};

const expandDirectoryGroup = (provider: string, directory: string) => {
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${provider} 供应商分组`),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`展开或折叠 ${directory} 目录分组`),
    }),
  );
};

describe("SessionManagerPage", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.removeItem("cc-switch.sessionManager.listViewMode");
    window.localStorage.removeItem("cc-switch.sessionManager.staleCleanupDays");
    window.localStorage.removeItem(GROUP_EXPANSION_STORAGE_KEY);
    platformMocks.isMac.mockReset().mockReturnValue(true);
    cursorApiMocks.getOfficialStatus.mockReset().mockResolvedValue({
      installed: true,
      version: "agent 1.0.0",
      authMode: "login",
      hasUserApiKey: false,
      authenticated: true,
      state: "ready",
    });
    cursorApiMocks.updateOfficialAuth.mockReset();
    cursorApiMocks.clearUserApiKey.mockReset();
    cursorApiMocks.getSessionIndexStatus
      .mockReset()
      .mockResolvedValue({ state: "indexReady" });
    cursorApiMocks.getSessionResumeContext.mockReset().mockResolvedValue({
      workspaceState: "ready",
      workspace: "/mock/cursor/cursor-workspace",
    });
    cursorApiMocks.launchSession
      .mockReset()
      .mockResolvedValue({ state: "launched" });
    cursorApiMocks.launchLogin
      .mockReset()
      .mockResolvedValue({ state: "launched" });
    cursorApiMocks.launchLoginAndSession
      .mockReset()
      .mockResolvedValue({ state: "launched" });

    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-session-1",
        title: "Alpha Session",
        summary: "Alpha summary",
        projectDir: "/mock/codex",
        createdAt: 2,
        lastActiveAt: 20,
        sourcePath: "/mock/codex/session-1.jsonl",
        resumeCommand: "codex resume codex-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-2",
        title: "Beta Session",
        summary: "Beta summary",
        projectDir: "/mock/codex",
        createdAt: 1,
        lastActiveAt: 10,
        sourcePath: "/mock/codex/session-2.jsonl",
        resumeCommand: "codex resume codex-session-2",
      },
      {
        providerId: "claude",
        sessionId: "claude-session-1",
        title: "Claude Session",
        summary: "Claude summary",
        projectDir: "/mock/claude",
        createdAt: 3,
        lastActiveAt: 30,
        sourcePath: "/mock/claude/session-1.jsonl",
        resumeCommand: "claude --resume claude-session-1",
      },
      {
        providerId: "codex",
        sessionId: "codex-session-3",
        title: "Gamma Session",
        summary: "Gamma summary",
        projectDir: null,
        createdAt: 0,
        lastActiveAt: 5,
        sourcePath: "/mock/codex/session-3.jsonl",
        resumeCommand: "codex resume codex-session-3",
      },
      {
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        title: "Cursor Alpha",
        projectDir: "/mock/cursor/cursor-workspace",
        createdAt: 0,
        lastActiveAt: 4,
        sourcePath:
          "/mock/cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
      },
      {
        providerId: "cursor",
        sessionId: "22222222-2222-4222-8222-222222222222",
        title: "Cursor Beta",
        projectDir: "/mock/cursor/cursor-workspace",
        createdAt: 0,
        lastActiveAt: 3,
        sourcePath:
          "/mock/cursor/chats/workspace/22222222-2222-4222-8222-222222222222/store.db",
      },
    ];
    const messages: Record<string, SessionMessage[]> = {
      "codex:/mock/codex/session-1.jsonl": [
        { role: "user", content: "alpha", ts: 20 },
      ],
      "codex:/mock/codex/session-2.jsonl": [
        { role: "user", content: "beta", ts: 10 },
      ],
      "codex:/mock/codex/session-3.jsonl": [
        { role: "user", content: "gamma", ts: 5 },
      ],
      "claude:/mock/claude/session-1.jsonl": [
        { role: "user", content: "claude", ts: 30 },
      ],
    };

    setSessionFixtures(sessions, messages);
  });

  it("surfaces a relative Pi sessionDir instead of presenting an empty scan as authoritative", async () => {
    const discovery = vi.spyOn(piApi, "getSessionDiscovery").mockResolvedValue({
      status: "requires_project_context",
      configuredPath: ".pi/sessions",
    });

    renderPage("pi");

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(".pi/sessions");
    expect(discovery).toHaveBeenCalledTimes(1);
    discovery.mockRestore();
  });

  it("defaults to the project view with all providers", async () => {
    renderPage("codex");

    await waitForHeading("Claude Session");
    expect(
      screen.getByRole("button", { name: /展开或折叠 claude 项目分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /展开或折叠 codex 项目分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 cursor-workspace 项目分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Alpha Session/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 claude 供应商分组/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
  });

  it("deletes the selected session and selects the next visible session", async () => {
    renderPage();
    await filterToCodex();

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/Alpha Session/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Beta Session" }),
      ).toBeInTheDocument(),
    );

    expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("removes a deleted session from filtered search results", async () => {
    renderPage();
    await filterToCodex();

    openSearch();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Alpha Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /删除会话/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /删除会话/i }));

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByText("sessionManager.selectSession"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("sessionManager.emptySession"),
    ).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("restores batch delete controls when deleteMany rejects", async () => {
    const deleteManySpy = vi
      .spyOn(sessionsApi, "deleteMany")
      .mockRejectedValueOnce(new Error("network error"));

    renderPage();
    await filterToCodex();

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("network error"),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /批量删除/i }),
      ).not.toBeDisabled(),
    );

    deleteManySpy.mockRestore();
  });

  it("keeps the exit batch mode button visible when search hides all sessions", async () => {
    renderPage();
    await filterToCodex();

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "NoSuchSession" },
    });

    await waitFor(() => expect(screen.queryByText("Alpha Session")).toBeNull());

    expect(screen.getByRole("button", { name: /退出批量管理/i })).toBeVisible();
  });

  it("US-004 exposes the Cursor filter and Agent CLI local delete actions", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchProviderFilter(/Cursor/i);

    expect(
      await screen.findByRole("heading", { name: "Cursor Alpha" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /删除会话/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /批量管理/i }),
    ).toBeInTheDocument();

    await switchProviderFilter(/Codex/i);

    expect(
      await screen.findByRole("heading", { name: "Alpha Session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /删除会话/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /批量管理/i }),
    ).toBeInTheDocument();
  });

  it("US-001 shows Cursor index diagnostics in the Cursor-filter empty state", async () => {
    cursorApiMocks.getSessionIndexStatus.mockResolvedValue({
      state: "indexUnavailable",
      reason: "metadata layout is not recognized",
    });
    setSessionFixtures([], {});

    renderPage("cursor");
    await filterToCursor();

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Cursor 会话索引不可用");
    expect(warning).toHaveTextContent("metadata layout is not recognized");
    expect(screen.queryByText("未发现会话")).not.toBeInTheDocument();
  });

  it("US-001 refreshes both Cursor sessions and index diagnostics", async () => {
    const user = userEvent.setup();
    const listSessions = vi.spyOn(sessionsApi, "list");
    cursorApiMocks.getSessionIndexStatus.mockResolvedValue({
      state: "indexUnavailable",
      reason: "metadata layout is not recognized",
    });
    setSessionFixtures([], {});

    try {
      renderPage("cursor");
      await filterToCursor();

      await screen.findByRole("alert");
      await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
      expect(cursorApiMocks.getSessionIndexStatus).toHaveBeenCalledTimes(1);

      const refreshButton = Array.from(screen.getAllByRole("button")).find(
        (button) => button.querySelector(".lucide-refresh-cw"),
      );
      expect(refreshButton).toBeDefined();
      await user.click(refreshButton!);

      await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(cursorApiMocks.getSessionIndexStatus).toHaveBeenCalledTimes(2),
      );
    } finally {
      listSessions.mockRestore();
    }
  });

  it("US-002/US-005 renders Cursor transcript through shared chrome without generic terminal plumbing", async () => {
    const user = userEvent.setup();
    const getMessages = vi.spyOn(sessionsApi, "getMessages");
    const launchTerminal = vi.spyOn(sessionsApi, "launchTerminal");
    const storePath = "/mock/cursor/chats/workspace/store.db";
    setSessionFixtures(
      [
        {
          providerId: "cursor",
          sessionId: "11111111-1111-4111-8111-111111111111",
          title: "Cursor Alpha",
          projectDir: "/mock/cursor/cursor-workspace",
          createdAt: 0,
          lastActiveAt: 4,
          sourcePath: storePath,
          resumeCommand: "must-not-launch-through-generic-terminal",
        },
      ],
      {
        [`cursor:${storePath}`]: [
          {
            role: "user",
            content: "<user_info>\nOS Version: darwin\n</user_info>",
            ts: 1,
          },
          {
            role: "user",
            content:
              "<timestamp>Saturday Aug 29, 2026, 7:54 PM</timestamp>\n<user_query>continue the cursor task</user_query>",
            ts: 4,
          },
          { role: "assistant", content: "working on it", ts: 5 },
        ],
      },
    );

    renderPage("cursor");

    expect(
      await screen.findByRole("heading", { name: "Cursor Alpha" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "恢复会话" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(getMessages).toHaveBeenCalledWith("cursor", storePath),
    );
    expect(screen.getByText("对话记录").parentElement).toHaveTextContent("2");
    expect(
      screen.queryByText("sessionManager.emptySession"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("继续 Cursor 会话")).not.toBeInTheDocument();
    expect(screen.queryByText("技术详情")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "agent --workspace /mock/cursor/cursor-workspace --resume 11111111-1111-4111-8111-111111111111",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("must-not-launch-through-generic-terminal"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /删除会话/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复会话" }));

    await waitFor(() =>
      expect(cursorApiMocks.launchSession).toHaveBeenCalledWith({
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceOverride: undefined,
      }),
    );
    expect(launchTerminal).not.toHaveBeenCalled();
  });

  it("US-002/US-004 never polls generic resume state for Cursor", async () => {
    const getResumeState = vi.spyOn(sessionsApi, "getResumeState");

    try {
      renderPage("cursor");
      await filterToCursor();

      expect(
        await screen.findByRole("heading", { name: "Cursor Alpha" }),
      ).toBeInTheDocument();
      expect(
        getResumeState.mock.calls.every(
          ([providerId]) => providerId !== "cursor",
        ),
      ).toBe(true);
    } finally {
      getResumeState.mockRestore();
    }
  });

  it("US-004 shows Cursor Agent CLI checkboxes in grouped batch mode", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();
    expandDirectoryGroup("cursor", "cursor-workspace");

    expect(
      screen.getByRole("button", { name: /Cursor Alpha/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /选择 cursor 供应商分组内会话/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: /选择 cursor-workspace 目录分组内会话/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("checkbox", { name: "选择会话" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps batch mode when switching to Cursor Agent CLI sessions", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchToFlatView();
    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择会话" })[0]);
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();

    await switchProviderFilter(/Cursor/i);

    expect(
      await screen.findByRole("button", { name: /退出批量管理/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("已选 0 项")).toBeInTheDocument();
  });

  it("drops hidden selections when search narrows the result set", async () => {
    renderPage();
    await filterToCodex();

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));

    expect(screen.getByText("已选 3 项")).toBeInTheDocument();

    openSearch();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Alpha" },
    });

    await waitFor(() =>
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument(),
    );

    closeSearch();

    await waitFor(() =>
      expect(screen.getByText("已选 1 项")).toBeInTheDocument(),
    );
  });

  it("removes successfully deleted sessions from the UI before refetch completes", async () => {
    const view = renderPage();
    await filterToCodex();
    let resolveInvalidate!: () => void;
    const invalidateSpy = vi
      .spyOn(view.client, "invalidateQueries")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveInvalidate = () => resolve(undefined);
          }),
      );

    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveInvalidate();
    });
    invalidateSpy.mockRestore();
  });

  it("switches to grouped view collapsed by default and shows collapse control", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchToGroupedView();

    expect(
      screen.getByRole("button", { name: /全部收起/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 codex 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 claude 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 codex 目录分组/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Alpha Session/ }),
    ).not.toBeInTheDocument();
  });

  it("persists manual expansion and collapses all grouped sessions", async () => {
    renderPage();
    await filterToCodex();

    await switchToGroupedView();
    expandDirectoryGroup("codex", "codex");

    expect(
      screen.getByRole("button", { name: /展开或折叠 codex 目录分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: ["codex"],
        expandedDirectoryKeys: ["codex:/mock/codex"],
        expandedProjectKeys: [],
      }),
    );

    collapseAllGroups();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /展开或折叠 codex 目录分组/ }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: [],
        expandedProjectKeys: [],
      }),
    );
  });

  it("keeps filtered grouped sessions collapsed until expanding the group", async () => {
    renderPage("all");

    await switchToFlatView();
    await waitFor(() =>
      expect(screen.getByText("Alpha Session")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha Session/ }));
    await switchToGroupedView();
    await switchProviderFilter(/Claude Code/i);

    await waitFor(() =>
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument(),
    );

    expect(
      screen.getByRole("heading", { name: "Claude Session" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /展开或折叠 claude 供应商分组/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 claude 目录分组/ }),
    ).not.toBeInTheDocument();

    expandDirectoryGroup("claude", "claude");

    expect(
      screen.getByRole("button", { name: /展开或折叠 claude 目录分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Claude Session/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
  });

  it("supports batch deletion from grouped view", async () => {
    renderPage();
    await filterToCodex();

    await switchToGroupedView();
    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));
    fireEvent.click(screen.getByRole("button", { name: /全选当前/i }));
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Gamma Session")).not.toBeInTheDocument();
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("selects visible deletable sessions by provider group in grouped batch mode", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await enterGroupedBatchMode();

    const codexProviderCheckbox = screen.getByRole("checkbox", {
      name: /选择 codex 供应商分组内会话/,
    });
    const claudeProviderCheckbox = screen.getByRole("checkbox", {
      name: /选择 claude 供应商分组内会话/,
    });

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).toBeChecked();
    expect(claudeProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("已选 3 项")).toBeInTheDocument();

    fireEvent.click(codexProviderCheckbox);

    expect(codexProviderCheckbox).not.toBeChecked();
    expect(screen.getByText("已选 0 项")).toBeInTheDocument();
  });

  it("selects visible deletable sessions by directory group and marks the provider as mixed", async () => {
    renderPage();
    await filterToCodex();

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    const providerCheckbox = screen.getByRole("checkbox", {
      name: /选择 codex 供应商分组内会话/,
    });
    const codexDirectoryCheckbox = screen.getByRole("checkbox", {
      name: /选择 codex 目录分组内会话/,
    });

    fireEvent.click(codexDirectoryCheckbox);

    expect(codexDirectoryCheckbox).toBeChecked();
    expect(providerCheckbox).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("已选 2 项")).toBeInTheDocument();
  });

  it("marks grouped batch checkboxes as mixed when only one session is selected", async () => {
    renderPage();
    await filterToCodex();

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");

    fireEvent.click(screen.getAllByRole("checkbox", { name: "选择会话" })[0]);

    expect(
      screen.getByRole("checkbox", {
        name: /选择 codex 供应商分组内会话/,
      }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(
      screen.getByRole("checkbox", { name: /选择 codex 目录分组内会话/ }),
    ).toHaveAttribute("aria-checked", "mixed");
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
  });

  it("batch deletes only sessions selected from a grouped directory", async () => {
    renderPage();
    await filterToCodex();

    await enterGroupedBatchMode();
    expandDirectoryGroup("codex", "codex");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /选择 codex 目录分组内会话/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /批量删除/i }));

    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: /删除所选会话/i }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Alpha Session")).not.toBeInTheDocument();
      expect(screen.queryByText("Beta Session")).not.toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /展开或折叠 未知目录 目录分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "选择会话" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /展开或折叠 未知目录 目录分组/ }),
    );
    expect(
      screen.getByRole("checkbox", { name: "选择会话" }),
    ).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  });

  it("aggregates cross-agent sessions under one project group", async () => {
    setSessionFixtures(
      [
        {
          providerId: "cursor",
          sessionId: "11111111-1111-4111-8111-111111111111",
          title: "Cursor Shared",
          projectDir: "/work/acme/app/",
          lastActiveAt: 40,
        },
        {
          providerId: "codex",
          sessionId: "codex-shared",
          title: "Codex Shared",
          projectDir: "/work/acme/app",
          lastActiveAt: 30,
          sourcePath: "/tmp/codex-shared.jsonl",
          resumeCommand: "codex resume codex-shared",
        },
        {
          providerId: "claude",
          sessionId: "claude-other",
          title: "Claude Other",
          projectDir: "/work/acme/docs",
          lastActiveAt: 20,
          sourcePath: "/tmp/claude-other.jsonl",
          resumeCommand: "claude --resume claude-other",
        },
      ],
      {},
    );

    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Cursor Shared" }),
      ).toBeInTheDocument(),
    );

    await switchToProjectView();

    expect(
      screen.getByRole("button", { name: /全部收起/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /展开或折叠 app 项目分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /展开或折叠 docs 项目分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开或折叠 cursor 供应商分组/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Cursor Shared/ }),
    ).not.toBeInTheDocument();

    expandProjectGroup("app");

    expect(
      screen.getByRole("button", { name: /Cursor Shared/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Codex Shared/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Claude Other")).not.toBeInTheDocument();
  });

  it("aggregates wts worktrees with the sibling main checkout", async () => {
    setSessionFixtures(
      [
        {
          providerId: "cursor",
          sessionId: "11111111-1111-4111-8111-111111111111",
          title: "Main Checkout",
          projectDir: "/Users/feng/Codes/cc-switch",
          lastActiveAt: 40,
        },
        {
          providerId: "codex",
          sessionId: "codex-wt",
          title: "Worktree Session",
          projectDir: "/Users/feng/Codes/cc-switch-wt-cursor-official-sessions",
          lastActiveAt: 30,
          sourcePath: "/tmp/codex-wt.jsonl",
          resumeCommand: "codex resume codex-wt",
        },
        {
          providerId: "claude",
          sessionId: "claude-other",
          title: "Other Repo",
          projectDir: "/tmp/other-app",
          lastActiveAt: 20,
          sourcePath: "/tmp/claude-other.jsonl",
          resumeCommand: "claude --resume claude-other",
        },
      ],
      {},
    );

    renderPage("all");

    await waitForHeading("Main Checkout");
    expect(
      screen.getByRole("button", { name: /展开或折叠 cc-switch 项目分组/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /展开或折叠 cc-switch-wt-cursor-official-sessions 项目分组/,
      }),
    ).not.toBeInTheDocument();

    expandProjectGroup("cc-switch");

    expect(
      screen.getByRole("button", { name: /Main Checkout/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Worktree Session/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("cursor-official-sessions")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Other Repo/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the real worktree path in the project tooltip when only a wts workspace exists", async () => {
    const worktreeDir =
      "/Users/feng/Codes/cc-switch-wt-cursor-official-sessions";
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "codex-wt-only",
          title: "Worktree Only",
          projectDir: worktreeDir,
          lastActiveAt: 30,
          sourcePath: "/tmp/codex-wt-only.jsonl",
          resumeCommand: "codex resume codex-wt-only",
        },
      ],
      {},
    );

    renderPage("all");
    await waitForHeading("Worktree Only");

    await userEvent.hover(screen.getByText("cc-switch"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent(worktreeDir);
    });
    expect(screen.getByRole("tooltip").textContent?.trim()).toBe(worktreeDir);
  });

  it("selects only deletable sessions when checking a mixed-agent project group", async () => {
    setSessionFixtures(
      [
        {
          providerId: "cursor",
          sessionId: "11111111-1111-4111-8111-111111111111",
          title: "Cursor Shared",
          projectDir: "/work/acme/app",
          lastActiveAt: 40,
        },
        {
          providerId: "codex",
          sessionId: "codex-shared",
          title: "Codex Shared",
          projectDir: "/work/acme/app",
          lastActiveAt: 30,
          sourcePath: "/tmp/codex-shared.jsonl",
          resumeCommand: "codex resume codex-shared",
        },
      ],
      {},
    );

    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Cursor Shared" }),
      ).toBeInTheDocument(),
    );

    await switchToProjectView();
    fireEvent.click(screen.getByRole("button", { name: /批量管理/i }));

    const projectCheckbox = screen.getByRole("checkbox", {
      name: /选择 app 项目分组内会话/,
    });
    fireEvent.click(projectCheckbox);

    expect(projectCheckbox).toBeChecked();
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();

    expandProjectGroup("app");
    expect(
      screen.getByRole("button", { name: /Cursor Shared/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: "选择会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", {
        name: /选择 cursor 供应商分组内会话/,
      }),
    ).not.toBeInTheDocument();
  });

  it("persists project group expansion independently of agent grouping", async () => {
    renderPage("all");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await switchToProjectView();
    expandProjectGroup("codex");

    expect(
      screen.getByRole("button", { name: /Alpha Session/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: [],
        expandedProjectKeys: ["/mock/codex"],
      }),
    );

    collapseAllGroups();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Alpha Session/ }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(GROUP_EXPANSION_STORAGE_KEY)!),
      ).toEqual({
        expandedProviderIds: [],
        expandedDirectoryKeys: [],
        expandedProjectKeys: [],
      }),
    );
  });

  it("renames the button to 回到会话 when the terminal session is already live", async () => {
    vi.spyOn(platform, "isMac").mockReturnValue(true);
    vi.spyOn(sessionsApi, "getResumeState").mockResolvedValue({
      appearance: "return",
    });

    renderPage();
    await filterToCodex();

    expect(
      await screen.findByRole("button", {
        name: /sessionManager.returnToSession/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sessionManager.resume$/i }),
    ).not.toBeInTheDocument();
  });

  it("renames the button to 回到 CodeG when CodeG holds the writer", async () => {
    vi.spyOn(platform, "isMac").mockReturnValue(true);
    vi.spyOn(sessionsApi, "getResumeState").mockResolvedValue({
      appearance: "returnToCodeG",
    });

    renderPage();
    await filterToCodex();

    expect(
      await screen.findByRole("button", {
        name: /sessionManager.returnToCodeG/i,
      }),
    ).toBeInTheDocument();
  });

  it("focuses the already-open terminal instead of launching a second resume", async () => {
    vi.spyOn(platform, "isMac").mockReturnValue(true);
    vi.spyOn(sessionsApi, "getResumeState").mockResolvedValue({
      appearance: "resume",
    });
    const launch = vi.spyOn(sessionsApi, "launchTerminal").mockResolvedValue({
      action: "focused",
      app: "iTerm",
    });

    renderPage();
    await filterToCodex();

    fireEvent.click(
      screen.getByRole("button", { name: /sessionManager.resume$/i }),
    );

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith({
        command: "codex resume codex-session-1",
        cwd: "/mock/codex",
        sessionId: "codex-session-1",
        providerId: "codex",
        sourcePath: "/mock/codex/session-1.jsonl",
      });
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "已切换到已打开的会话窗口（iTerm）",
      );
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it("shows conversation TOC for Claude even with a single user turn", async () => {
    renderPage("claude");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    await waitFor(() => {
      const sidebar = screen.getByTestId("session-toc-sidebar");
      expect(sidebar).toHaveAttribute("data-item-count", "1");
      expect(sidebar).toHaveAttribute("data-previews", "claude");
    });
    expect(screen.getByTestId("session-toc-dialog")).toHaveAttribute(
      "data-item-count",
      "1",
    );
  });

  it("uses the same resume decision path for Claude sessions", async () => {
    vi.spyOn(platform, "isMac").mockReturnValue(true);
    const launch = vi.spyOn(sessionsApi, "launchTerminal").mockResolvedValue({
      action: "focused",
      app: "iTerm",
    });

    renderPage("claude");
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Claude Session" }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /sessionManager.resume$/i }),
    );

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith({
        command: "claude --resume claude-session-1",
        cwd: "/mock/claude",
        sessionId: "claude-session-1",
        providerId: "claude",
        sourcePath: "/mock/claude/session-1.jsonl",
      });
    });
    launch.mockRestore();
  });

  it("does not launch another resume when a non-terminal client holds the writer", async () => {
    vi.spyOn(platform, "isMac").mockReturnValue(true);
    vi.spyOn(sessionsApi, "getResumeState").mockResolvedValue({
      appearance: "resume",
    });
    const launch = vi.spyOn(sessionsApi, "launchTerminal").mockResolvedValue({
      action: "occupied",
      holder: "CodeG",
    });

    renderPage();
    await filterToCodex();

    fireEvent.click(
      screen.getByRole("button", { name: /sessionManager.resume$/i }),
    );

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "该会话已在 CodeG 中打开，请先回到那个窗口",
      );
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    launch.mockRestore();
  });

  it("opens idle cleanup and reuses the existing delete confirmation", async () => {
    const now = Date.now();
    const day = 86_400_000;
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "stale-session",
          title: "Stale Session",
          projectDir: "/mock/codex",
          lastActiveAt: now - 40 * day,
          sourcePath: "/mock/codex/stale.jsonl",
        },
        {
          providerId: "codex",
          sessionId: "fresh-session",
          title: "Fresh Session",
          projectDir: "/mock/codex",
          lastActiveAt: now - 2 * day,
          sourcePath: "/mock/codex/fresh.jsonl",
        },
        {
          providerId: "cursor",
          sessionId: "11111111-1111-4111-8111-111111111111",
          title: "Cursor Stale",
          projectDir: "/mock/cursor/cursor-workspace",
          lastActiveAt: now - 40 * day,
          sourcePath:
            "/mock/cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
        },
      ],
      {},
    );

    renderPage();
    const cleanupButton = await screen.findByRole("button", {
      name: /清理闲置会话/i,
    });
    fireEvent.click(cleanupButton);

    expect(
      await screen.findByText("将删除 2 个会话，跳过 0 个不可删。"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Agent CLI 的本地会话目录/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /继续删除/i }));

    const confirm = await screen.findByTestId("confirm-dialog");
    expect(confirm).toHaveTextContent("批量删除会话");
    expect(confirm).toHaveTextContent("2");
    expect(confirm).not.toHaveTextContent("Fresh Session");
  });

  it("does not submit idle cleanup when days are invalid or no sessions match", async () => {
    const now = Date.now();
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "fresh-only",
          title: "Fresh Only",
          projectDir: "/mock/codex",
          lastActiveAt: now,
          sourcePath: "/mock/codex/fresh.jsonl",
        },
      ],
      {},
    );

    renderPage();
    const cleanupButton = await screen.findByRole("button", {
      name: /清理闲置会话/i,
    });
    fireEvent.click(cleanupButton);

    const daysInput = await screen.findByLabelText(/未活跃天数/i);
    await userEvent.clear(daysInput);
    await userEvent.type(daysInput, "0");
    expect(
      screen.getByText("请输入 1 到 3650 之间的整数。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /继续删除/i })).toBeDisabled();

    await userEvent.clear(daysInput);
    await userEvent.type(daysInput, "30");
    expect(screen.getByText("没有符合条件的可删会话。")).toBeInTheDocument();
    expect(screen.queryByText(/Agent CLI/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cursor Desktop/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Developer: Delete Old Chats/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /继续删除/i })).toBeDisabled();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("starts a new session in the selected project's main workspace", async () => {
    setSessionFixtures(
      [
        {
          providerId: "codex",
          sessionId: "only-session",
          title: "Only Session",
          projectDir: "/Users/feng/Codes/cc-switch",
          lastActiveAt: Date.now(),
          sourcePath: "/mock/codex/only.jsonl",
        },
      ],
      {},
    );
    const launch = vi
      .spyOn(sessionsApi, "launchTerminal")
      .mockResolvedValue({ action: "launched" });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /新建会话/i }));

    expect(await screen.findByLabelText(/项目目录/i)).toHaveValue(
      "/Users/feng/Codes/cc-switch",
    );
    fireEvent.click(screen.getByRole("button", { name: /打开会话/i }));

    await waitFor(() => {
      expect(launch).toHaveBeenCalledWith({
        command: "codex",
        cwd: "/Users/feng/Codes/cc-switch",
      });
    });
    launch.mockRestore();
  });

  it("does not launch a new session with an unsafe workspace name", async () => {
    const launch = vi.spyOn(sessionsApi, "launchTerminal");

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /新建会话/i }));

    const workspaceInput = await screen.findByLabelText(/工作区名称/i);
    await userEvent.type(workspaceInput, "../escape");
    expect(
      screen.getByText("工作区名称只能使用字母、数字、点、下划线和连字符。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /打开会话/i })).toBeDisabled();
    expect(launch).not.toHaveBeenCalled();
    launch.mockRestore();
  });
});

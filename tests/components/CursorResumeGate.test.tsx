import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorResumeGate } from "@/components/sessions/CursorResumeGate";
import { sessionsApi } from "@/lib/api/sessions";
import type { SessionMeta } from "@/types";

const apiMocks = vi.hoisted(() => ({
  getOfficialStatus: vi.fn(),
  updateOfficialAuth: vi.fn(),
  clearUserApiKey: vi.fn(),
  getSessionIndexStatus: vi.fn(),
  getSessionResumeContext: vi.fn(),
  launchSession: vi.fn(),
  launchLogin: vi.fn(),
  launchLoginAndSession: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => ({
  pickDirectory: vi.fn(),
}));

const platformMocks = vi.hoisted(() => ({
  isMac: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api/cursor", () => ({
  cursorApi: {
    getOfficialStatus: (...args: unknown[]) =>
      apiMocks.getOfficialStatus(...args),
    updateOfficialAuth: (...args: unknown[]) =>
      apiMocks.updateOfficialAuth(...args),
    clearUserApiKey: (...args: unknown[]) => apiMocks.clearUserApiKey(...args),
    getSessionIndexStatus: (...args: unknown[]) =>
      apiMocks.getSessionIndexStatus(...args),
    getSessionResumeContext: (...args: unknown[]) =>
      apiMocks.getSessionResumeContext(...args),
    launchSession: (...args: unknown[]) => apiMocks.launchSession(...args),
    launchLogin: (...args: unknown[]) => apiMocks.launchLogin(...args),
    launchLoginAndSession: (...args: unknown[]) =>
      apiMocks.launchLoginAndSession(...args),
  },
}));

vi.mock("@/lib/api/settings", () => ({
  settingsApi: {
    pickDirectory: (...args: unknown[]) => settingsMocks.pickDirectory(...args),
  },
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => platformMocks.isMac(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastMocks.success(...args),
    error: (...args: unknown[]) => toastMocks.error(...args),
  },
}));

const session: SessionMeta = {
  providerId: "cursor",
  sessionId: "11111111-1111-4111-8111-111111111111",
  title: "Cursor Alpha",
  projectDir: "/mock/cursor/workspace",
  lastActiveAt: 10,
};

const readyStatus = {
  installed: true,
  version: "agent 1.0.0",
  authMode: "login" as const,
  hasUserApiKey: false,
  authenticated: true,
  state: "ready" as const,
};

const needsLoginStatus = {
  ...readyStatus,
  authenticated: false,
  state: "needsLogin" as const,
};

const needsApiKeyStatus = {
  ...readyStatus,
  authMode: "userApiKey" as const,
  authenticated: false,
  state: "needsApiKey" as const,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { queryClient, Wrapper };
}

function renderGate(initialSession: SessionMeta = session) {
  const { queryClient, Wrapper } = createWrapper();
  const view = render(<CursorResumeGate session={initialSession} />, {
    wrapper: Wrapper,
  });

  return {
    queryClient,
    ...view,
    rerenderSession(nextSession: SessionMeta) {
      view.rerender(<CursorResumeGate session={nextSession} />);
    },
  };
}

describe("CursorResumeGate", () => {
  beforeEach(() => {
    platformMocks.isMac.mockReset().mockReturnValue(true);
    settingsMocks.pickDirectory.mockReset().mockResolvedValue(null);
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    apiMocks.getOfficialStatus.mockReset().mockResolvedValue(readyStatus);
    apiMocks.updateOfficialAuth
      .mockReset()
      .mockImplementation(
        async ({ authMode }: { authMode: "login" | "userApiKey" }) =>
          authMode === "userApiKey"
            ? {
                ...readyStatus,
                authMode: "userApiKey" as const,
                hasUserApiKey: true,
              }
            : readyStatus,
      );
    apiMocks.clearUserApiKey.mockReset().mockResolvedValue(needsApiKeyStatus);
    apiMocks.getSessionIndexStatus
      .mockReset()
      .mockResolvedValue({ state: "indexReady" });
    apiMocks.getSessionResumeContext.mockReset().mockResolvedValue({
      workspaceState: "ready",
      workspace: "/mock/cursor/workspace",
    });
    apiMocks.launchSession.mockReset().mockResolvedValue({ state: "launched" });
    apiMocks.launchLogin.mockReset().mockResolvedValue({ state: "launched" });
    apiMocks.launchLoginAndSession
      .mockReset()
      .mockResolvedValue({ state: "launched" });
  });

  it("US-002 resumes a ready session through dedicated Cursor IPC", async () => {
    const user = userEvent.setup();
    const launchTerminal = vi.spyOn(sessionsApi, "launchTerminal");
    renderGate();

    await user.click(await screen.findByRole("button", { name: "继续会话" }));

    await waitFor(() =>
      expect(apiMocks.launchSession).toHaveBeenCalledWith({
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceOverride: undefined,
      }),
    );
    expect(launchTerminal).not.toHaveBeenCalled();
  });

  it("uses Login and continue for the same selected session", async () => {
    const user = userEvent.setup();
    apiMocks.getOfficialStatus.mockResolvedValue(needsLoginStatus);
    renderGate();

    await user.click(await screen.findByRole("button", { name: "登录并继续" }));

    expect(apiMocks.launchLoginAndSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      workspaceOverride: undefined,
    });
    expect(apiMocks.launchLogin).not.toHaveBeenCalled();
  });

  it("continues the same session after saving a User API Key", async () => {
    const user = userEvent.setup();
    apiMocks.getOfficialStatus.mockResolvedValue(needsApiKeyStatus);
    renderGate();

    await screen.findByText("需要 API Key");
    await user.click(screen.getByRole("button", { name: "其他方式" }));
    await user.type(
      screen.getByLabelText("Cursor User API Key"),
      "cursor-fixture-secret",
    );
    await user.click(screen.getByRole("button", { name: "配置并继续" }));

    await waitFor(() =>
      expect(apiMocks.launchSession).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        workspaceOverride: undefined,
      }),
    );
  });

  it("keeps directory cancellation silent and leaves resume blocked", async () => {
    const user = userEvent.setup();
    apiMocks.getSessionResumeContext.mockResolvedValue({
      workspaceState: "workspaceRequired",
    });
    settingsMocks.pickDirectory.mockResolvedValue(null);
    renderGate();

    await user.click(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    );

    expect(settingsMocks.pickDirectory).toHaveBeenCalledWith(
      "/mock/cursor/workspace",
    );
    expect(apiMocks.launchSession).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "选择目录并继续" }),
    ).toBeInTheDocument();
  });

  it("validates one selected workspace and immediately resumes when auth is ready", async () => {
    const user = userEvent.setup();
    settingsMocks.pickDirectory.mockResolvedValue("/mock/selected-workspace");
    apiMocks.getSessionResumeContext.mockImplementation(
      async ({ workspaceOverride }: { workspaceOverride?: string }) =>
        workspaceOverride
          ? {
              workspaceState: "ready",
              workspace: "/mock/canonical-workspace",
            }
          : { workspaceState: "workspaceRequired" },
    );
    renderGate();

    await user.click(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    );

    await waitFor(() =>
      expect(apiMocks.launchSession).toHaveBeenCalledWith({
        sessionId: session.sessionId,
        workspaceOverride: "/mock/canonical-workspace",
      }),
    );
    expect(settingsMocks.pickDirectory).toHaveBeenCalledTimes(1);
  });

  it("US-002 retains one workspace override through authentication remediation", async () => {
    const user = userEvent.setup();
    apiMocks.getOfficialStatus.mockResolvedValue(needsLoginStatus);
    settingsMocks.pickDirectory.mockResolvedValue("/mock/selected-workspace");
    apiMocks.getSessionResumeContext.mockImplementation(
      async ({ workspaceOverride }: { workspaceOverride?: string }) =>
        workspaceOverride
          ? {
              workspaceState: "ready",
              workspace: workspaceOverride,
            }
          : { workspaceState: "workspaceRequired" },
    );
    renderGate();

    await user.click(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    );
    await user.click(await screen.findByRole("button", { name: "登录并继续" }));

    expect(settingsMocks.pickDirectory).toHaveBeenCalledTimes(1);
    expect(apiMocks.launchLoginAndSession).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      workspaceOverride: "/mock/selected-workspace",
    });
  });

  it("US-002 resets workspace override when the selected session changes", async () => {
    const user = userEvent.setup();
    const nextSession: SessionMeta = {
      ...session,
      sessionId: "22222222-2222-4222-8222-222222222222",
      title: "Cursor Beta",
      projectDir: "/mock/cursor/other-workspace",
    };
    apiMocks.getOfficialStatus.mockResolvedValue(needsLoginStatus);
    settingsMocks.pickDirectory.mockResolvedValue("/mock/selected-workspace");
    apiMocks.getSessionResumeContext.mockImplementation(
      async ({ workspaceOverride }: { workspaceOverride?: string }) =>
        workspaceOverride
          ? {
              workspaceState: "ready",
              workspace: workspaceOverride,
            }
          : { workspaceState: "workspaceRequired" },
    );
    const view = renderGate();

    await user.click(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    );
    await screen.findByRole("button", { name: "登录并继续" });

    view.rerenderSession(nextSession);

    await waitFor(() =>
      expect(apiMocks.getSessionResumeContext).toHaveBeenCalledWith({
        sessionId: nextSession.sessionId,
        workspaceOverride: undefined,
      }),
    );
    expect(apiMocks.getSessionResumeContext).not.toHaveBeenCalledWith({
      sessionId: nextSession.sessionId,
      workspaceOverride: "/mock/selected-workspace",
    });
    expect(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    ).toBeInTheDocument();
  });

  it("keeps platform and CLI failures ahead of workspace and authentication", async () => {
    platformMocks.isMac.mockReturnValue(false);
    apiMocks.getOfficialStatus.mockResolvedValue({
      ...needsLoginStatus,
      installed: false,
      state: "cliMissing" as const,
    });
    apiMocks.getSessionResumeContext.mockResolvedValue({
      workspaceState: "workspaceRequired",
    });
    const platformView = renderGate();

    expect(
      await screen.findByText(/当前仅支持在 macOS 恢复 Cursor 会话/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择目录并继续" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "登录并继续" }),
    ).not.toBeInTheDocument();

    platformView.unmount();
    platformMocks.isMac.mockReturnValue(true);
    renderGate();

    expect(
      await screen.findByText(/未找到 Cursor Agent CLI/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择目录并继续" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "登录并继续" }),
    ).not.toBeInTheDocument();
  });

  it("keeps status-unavailable diagnostics inside authentication remediation", async () => {
    apiMocks.getOfficialStatus.mockResolvedValue({
      ...needsLoginStatus,
      state: "statusUnavailable" as const,
      error: "status schema changed",
    });
    renderGate();

    expect(await screen.findByText("状态不可用")).toBeInTheDocument();
    expect(screen.getByText("status schema changed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "登录并继续" }),
    ).toBeInTheDocument();
  });

  it("reports index unavailability separately without blocking a loaded session", async () => {
    const user = userEvent.setup();
    apiMocks.getSessionIndexStatus.mockResolvedValue({
      state: "indexUnavailable",
      reason: "metadata root unavailable",
    });
    renderGate();

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("Cursor 会话索引不可用");
    expect(warning).toHaveTextContent("metadata root unavailable");

    await user.click(screen.getByRole("button", { name: "继续会话" }));
    expect(apiMocks.launchSession).toHaveBeenCalledTimes(1);
  });

  it("returns to workspace selection when launch-time validation expires", async () => {
    const user = userEvent.setup();
    apiMocks.launchSession.mockResolvedValue({ state: "workspaceRequired" });
    renderGate();

    await user.click(await screen.findByRole("button", { name: "继续会话" }));

    expect(
      await screen.findByRole("button", { name: "选择目录并继续" }),
    ).toBeInTheDocument();
  });

  it("keeps full path, chat ID, and fixed command in collapsed technical details", async () => {
    renderGate();

    const summary = await screen.findByText("技术详情");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("/mock/cursor/workspace")).toBeDefined();
    expect(within(details!).getByText(session.sessionId)).toBeDefined();
    expect(
      within(details!).getByText(
        `agent --workspace /mock/cursor/workspace --resume ${session.sessionId}`,
      ),
    ).toBeDefined();
  });
});

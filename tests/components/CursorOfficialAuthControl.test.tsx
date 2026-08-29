import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorOfficialAuthControl } from "@/components/cursor/CursorOfficialAuthControl";

const apiMocks = vi.hoisted(() => ({
  getOfficialStatus: vi.fn(),
  updateOfficialAuth: vi.fn(),
  clearUserApiKey: vi.fn(),
  launchLogin: vi.fn(),
}));

vi.mock("@/lib/api/cursor", () => ({
  cursorApi: {
    getOfficialStatus: (...args: unknown[]) =>
      apiMocks.getOfficialStatus(...args),
    updateOfficialAuth: (...args: unknown[]) =>
      apiMocks.updateOfficialAuth(...args),
    clearUserApiKey: (...args: unknown[]) => apiMocks.clearUserApiKey(...args),
    launchLogin: (...args: unknown[]) => apiMocks.launchLogin(...args),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string }): string =>
      typeof options === "string" ? options : (options?.defaultValue ?? key),
  }),
}));

const needsLoginStatus = {
  installed: true,
  version: "agent 1.0",
  authMode: "login" as const,
  hasUserApiKey: false,
  authenticated: false,
  state: "needsLogin" as const,
};

function renderControl(
  props: ComponentProps<typeof CursorOfficialAuthControl> = {
    variant: "full",
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <CursorOfficialAuthControl {...props} />
    </QueryClientProvider>,
  );
}

describe("CursorOfficialAuthControl", () => {
  beforeEach(() => {
    apiMocks.getOfficialStatus.mockReset().mockResolvedValue(needsLoginStatus);
    apiMocks.updateOfficialAuth.mockReset();
    apiMocks.clearUserApiKey.mockReset();
    apiMocks.launchLogin.mockReset().mockResolvedValue({ state: "launched" });
  });

  it("US-003 keeps Login primary and User API Key under Other methods", async () => {
    const user = userEvent.setup();
    renderControl();

    expect(await screen.findByText("需要登录")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "登录 Cursor" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Cursor User API Key"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "其他方式" }));

    expect(screen.getByLabelText("Cursor User API Key")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /\b(supported|conditional|unsupported)\b/i,
    );
  });

  it("US-003 clears the submitted key and renders only configured state", async () => {
    const user = userEvent.setup();
    const onApiKeyReady = vi.fn();
    apiMocks.updateOfficialAuth.mockResolvedValue({
      ...needsLoginStatus,
      authMode: "userApiKey",
      hasUserApiKey: true,
      authenticated: true,
      state: "ready",
    });
    renderControl({ variant: "compact", onApiKeyReady });

    await screen.findByText("需要登录");
    await user.click(screen.getByRole("button", { name: "其他方式" }));
    await user.type(
      screen.getByLabelText("Cursor User API Key"),
      "cursor-fixture-secret",
    );
    await user.click(screen.getByRole("button", { name: "配置并继续" }));

    await waitFor(() =>
      expect(apiMocks.updateOfficialAuth).toHaveBeenCalledWith({
        authMode: "userApiKey",
        userApiKey: "cursor-fixture-secret",
      }),
    );
    expect(onApiKeyReady).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByDisplayValue("cursor-fixture-secret"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("已配置 ••••••••")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("cursor-fixture-secret");
  });

  it("uses the supplied compact Login continuation instead of a generic login", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    renderControl({ variant: "compact", onLogin });

    await screen.findByText("需要登录");
    await user.click(screen.getByRole("button", { name: "登录并继续" }));

    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(apiMocks.launchLogin).not.toHaveBeenCalled();
  });

  it("US-003 lets compact status-unavailable remediation retry the shared probe", async () => {
    const user = userEvent.setup();
    apiMocks.getOfficialStatus.mockResolvedValue({
      ...needsLoginStatus,
      state: "statusUnavailable",
      error: "status schema changed",
    });
    renderControl({ variant: "compact" });

    expect(
      await screen.findByText("status schema changed"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新状态" }));

    await waitFor(() =>
      expect(apiMocks.getOfficialStatus).toHaveBeenCalledTimes(2),
    );
  });

  it("clears a configured key only through the explicit clear action", async () => {
    const user = userEvent.setup();
    apiMocks.getOfficialStatus.mockResolvedValue({
      ...needsLoginStatus,
      authMode: "userApiKey",
      hasUserApiKey: true,
      authenticated: true,
      state: "ready",
    });
    apiMocks.clearUserApiKey.mockResolvedValue({
      ...needsLoginStatus,
      authMode: "userApiKey",
      state: "needsApiKey",
    });
    renderControl();

    expect(await screen.findByText("已配置 ••••••••")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "其他方式" }));
    await user.click(screen.getByRole("button", { name: "清除 User API Key" }));

    expect(apiMocks.clearUserApiKey).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByText("已配置 ••••••••")).not.toBeInTheDocument(),
    );
  });

  it("launches Cursor Login from the full control", async () => {
    const user = userEvent.setup();
    renderControl();

    await screen.findByText("需要登录");
    await user.click(screen.getByRole("button", { name: "登录 Cursor" }));

    expect(apiMocks.launchLogin).toHaveBeenCalledTimes(1);
  });
});

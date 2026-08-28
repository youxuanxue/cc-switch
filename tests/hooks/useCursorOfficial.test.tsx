import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCursorOfficial } from "@/hooks/useCursorOfficial";
import { useCursorSessionIndex } from "@/hooks/useCursorSessionIndex";

const apiMocks = vi.hoisted(() => ({
  getOfficialStatus: vi.fn(),
  updateOfficialAuth: vi.fn(),
  clearUserApiKey: vi.fn(),
  getSessionIndexStatus: vi.fn(),
  launchLogin: vi.fn(),
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
    launchLogin: (...args: unknown[]) => apiMocks.launchLogin(...args),
  },
}));

const initialStatus = {
  installed: true,
  version: "agent 1.0",
  authMode: "login" as const,
  hasUserApiKey: false,
  authenticated: false,
  state: "needsLogin" as const,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe("useCursorOfficial", () => {
  beforeEach(() => {
    apiMocks.getOfficialStatus.mockReset().mockResolvedValue(initialStatus);
    apiMocks.updateOfficialAuth.mockReset();
    apiMocks.clearUserApiKey.mockReset();
    apiMocks.getSessionIndexStatus
      .mockReset()
      .mockResolvedValue({ state: "indexReady" });
    apiMocks.launchLogin.mockReset().mockResolvedValue({ state: "launched" });
  });

  it("US-003 shares Cursor auth state without returning the key", async () => {
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(
      () => ({ first: useCursorOfficial(), second: useCursorOfficial() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.first.status).toBeDefined());
    expect(result.current.second.status).toEqual(initialStatus);
    expect(apiMocks.getOfficialStatus).toHaveBeenCalledTimes(1);

    apiMocks.updateOfficialAuth.mockResolvedValue({
      ...initialStatus,
      authMode: "userApiKey",
      hasUserApiKey: true,
      authenticated: true,
      state: "ready",
    });
    const fixtureKey = "cursor-fixture-secret";
    await act(async () => {
      await result.current.first.updateAuth({
        authMode: "userApiKey",
        userApiKey: fixtureKey,
      });
    });

    expect(apiMocks.updateOfficialAuth).toHaveBeenCalledWith({
      authMode: "userApiKey",
      userApiKey: fixtureKey,
    });
    await waitFor(() =>
      expect(result.current.first.status?.hasUserApiKey).toBe(true),
    );
    expect(result.current.second.status?.hasUserApiKey).toBe(true);
    expect(JSON.stringify(result.current.first.status)).not.toContain(
      fixtureKey,
    );
    expect(
      JSON.stringify(queryClient.getQueryData(["cursor-official-status"])),
    ).not.toContain(fixtureKey);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain(fixtureKey);
  });

  it("preserves an omitted key and clears it only through the explicit action", async () => {
    apiMocks.updateOfficialAuth.mockResolvedValue({
      ...initialStatus,
      authMode: "login",
      hasUserApiKey: true,
    });
    apiMocks.clearUserApiKey.mockResolvedValue({
      ...initialStatus,
      authMode: "userApiKey",
      state: "needsApiKey",
    });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCursorOfficial(), { wrapper });
    await waitFor(() => expect(result.current.status).toBeDefined());

    await act(async () => {
      await result.current.updateAuth({ authMode: "login" });
    });
    expect(apiMocks.updateOfficialAuth).toHaveBeenCalledWith({
      authMode: "login",
    });
    await waitFor(() =>
      expect(result.current.status?.hasUserApiKey).toBe(true),
    );

    await act(async () => {
      await result.current.clearUserApiKey();
    });
    expect(apiMocks.clearUserApiKey).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(result.current.status?.hasUserApiKey).toBe(false),
    );
  });

  it("refreshes status and launches Login through the shared owner", async () => {
    const refreshed = {
      ...initialStatus,
      authenticated: true,
      state: "ready" as const,
    };
    apiMocks.getOfficialStatus
      .mockResolvedValueOnce(initialStatus)
      .mockResolvedValueOnce(refreshed);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useCursorOfficial(), { wrapper });
    await waitFor(() => expect(result.current.status).toEqual(initialStatus));

    await act(async () => {
      await result.current.refresh();
      await result.current.launchLogin();
    });

    expect(apiMocks.getOfficialStatus).toHaveBeenCalledTimes(2);
    expect(apiMocks.launchLogin).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.status).toEqual(refreshed));
  });

  it("keeps Cursor index availability in a separate query owner", async () => {
    apiMocks.getSessionIndexStatus.mockResolvedValue({
      state: "indexUnavailable",
      reason: "root does not exist",
    });
    const { queryClient, wrapper } = createWrapper();
    const { result } = renderHook(() => useCursorSessionIndex(), { wrapper });

    await waitFor(() =>
      expect(result.current.status).toEqual({
        state: "indexUnavailable",
        reason: "root does not exist",
      }),
    );
    expect(queryClient.getQueryData(["cursor-session-index"])).toEqual(
      result.current.status,
    );
  });
});

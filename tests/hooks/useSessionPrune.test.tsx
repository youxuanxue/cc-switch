import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../utils/testQueryClient";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}));

const pruneMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastMocks.success(...args),
    error: (...args: unknown[]) => toastMocks.error(...args),
    message: (...args: unknown[]) => toastMocks.message(...args),
  },
}));

vi.mock("@/lib/api", () => ({
  sessionsApi: {
    pruneSessionStorage: (...args: unknown[]) => pruneMock(...args),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

import { useSessionPrune } from "@/components/sessions/useSessionPrune";

function emptyPruneResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cursor: {
      bucketsRemoved: 0,
      staleChatsRemoved: 0,
      orphanDirsRemoved: 0,
      bucketsRetained: 0,
      scannableChatsRetained: 0,
    },
    claudePartitionsRemoved: 0,
    codexEmptyDirsRemoved: 0,
    geminiPartitionsRemoved: 0,
    grokPartitionsRemoved: 0,
    cursorDesktopWorkspacesRemoved: 0,
    cursorDesktopWorkspacesRetained: 0,
    wtsWorktrees: {
      removed: 0,
      gitRemoved: 0,
      retained: 0,
      skippedDirty: 0,
    },
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

describe("useSessionPrune", () => {
  beforeEach(() => {
    toastMocks.success.mockReset();
    toastMocks.error.mockReset();
    toastMocks.message.mockReset();
    pruneMock.mockReset();
  });

  it("toasts none when prune removes nothing and retains nothing", async () => {
    pruneMock.mockResolvedValue(emptyPruneResult());
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPrune(), { wrapper });

    await act(async () => {
      await result.current.pruneEmptyCursorBuckets();
    });

    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("没有可清理"),
    );
    expect(toastMocks.message).not.toHaveBeenCalled();
  });

  it("toasts retained summary when empty prune still keeps buckets", async () => {
    pruneMock.mockResolvedValue(
      emptyPruneResult({
        cursor: {
          bucketsRemoved: 0,
          staleChatsRemoved: 0,
          orphanDirsRemoved: 0,
          bucketsRetained: 2,
          scannableChatsRetained: 3,
        },
        cursorDesktopWorkspacesRetained: 1,
        wtsWorktrees: {
          removed: 0,
          gitRemoved: 0,
          retained: 4,
          skippedDirty: 0,
        },
      }),
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPrune(), { wrapper });

    await act(async () => {
      await result.current.pruneEmptyCursorBuckets();
    });

    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("未发现可清理"),
    );
  });

  it("toasts success and dirty skip when prune removes worktrees", async () => {
    pruneMock.mockResolvedValue(
      emptyPruneResult({
        cursor: {
          bucketsRemoved: 1,
          staleChatsRemoved: 0,
          orphanDirsRemoved: 0,
          bucketsRetained: 0,
          scannableChatsRetained: 0,
        },
        wtsWorktrees: {
          removed: 2,
          gitRemoved: 2,
          retained: 0,
          skippedDirty: 1,
        },
      }),
    );
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPrune(), { wrapper });

    await act(async () => {
      await result.current.pruneEmptyCursorBuckets();
    });

    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("已清理"),
    );
    expect(toastMocks.message).toHaveBeenCalledWith(
      expect.stringContaining("跳过"),
    );
  });

  it("toasts error when prune API fails", async () => {
    pruneMock.mockRejectedValue(new Error("disk busy"));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSessionPrune(), { wrapper });

    await act(async () => {
      await result.current.pruneEmptyCursorBuckets();
    });

    expect(toastMocks.error).toHaveBeenCalledWith("disk busy");
  });
});

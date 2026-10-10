import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const indexMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  status: null as null | { state: string; reason?: string },
  isError: false,
  error: null as unknown,
}));

vi.mock("@/hooks/useCursorSessionIndex", () => ({
  useCursorSessionIndex: (enabled: boolean) => ({
    enabled,
    status: enabled ? indexMocks.status : null,
    isError: enabled ? indexMocks.isError : false,
    error: enabled ? indexMocks.error : null,
    refresh: indexMocks.refresh,
  }),
}));

import { useSessionCursor } from "@/components/sessions/useSessionCursor";

describe("useSessionCursor", () => {
  beforeEach(() => {
    indexMocks.refresh.mockReset().mockResolvedValue(undefined);
    indexMocks.status = null;
    indexMocks.isError = false;
    indexMocks.error = null;
  });

  it("hides index unavailable reason when filter is not Cursor", () => {
    indexMocks.status = { state: "indexUnavailable", reason: "db missing" };
    const { result } = renderHook(() =>
      useSessionCursor({ providerFilter: "claude", readerKey: null }),
    );

    expect(result.current.cursorIndexUnavailableReason).toBeNull();
  });

  it("surfaces indexUnavailable reason for Cursor filter", () => {
    indexMocks.status = { state: "indexUnavailable", reason: "db missing" };
    const { result } = renderHook(() =>
      useSessionCursor({ providerFilter: "cursor", readerKey: null }),
    );

    expect(result.current.cursorIndexUnavailableReason).toBe("db missing");
  });

  it("surfaces query error message for Cursor filter", () => {
    indexMocks.isError = true;
    indexMocks.error = new Error("network down");
    const { result } = renderHook(() =>
      useSessionCursor({ providerFilter: "cursor", readerKey: null }),
    );

    expect(result.current.cursorIndexUnavailableReason).toBe("network down");
  });

  it("refreshes index only when filter is Cursor", async () => {
    const { result, rerender } = renderHook(
      ({ filter }) =>
        useSessionCursor({ providerFilter: filter, readerKey: null }),
      { initialProps: { filter: "claude" } },
    );

    await act(async () => {
      await result.current.refreshCursorIndex();
    });
    expect(indexMocks.refresh).not.toHaveBeenCalled();

    rerender({ filter: "cursor" });
    await act(async () => {
      await result.current.refreshCursorIndex();
    });
    expect(indexMocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("resets primary action and resume command when readerKey changes", () => {
    const { result, rerender } = renderHook(
      ({ key }) =>
        useSessionCursor({ providerFilter: "cursor", readerKey: key }),
      { initialProps: { key: "cursor:a" as string | null } },
    );

    act(() => {
      result.current.setCursorPrimaryAction({
        label: "继续",
        disabled: false,
        onClick: () => undefined,
      });
      result.current.setCursorResumeCommand("agent resume");
    });
    expect(result.current.cursorPrimaryAction).not.toBeNull();
    expect(result.current.cursorResumeCommand).toBe("agent resume");

    rerender({ key: "cursor:b" });
    expect(result.current.cursorPrimaryAction).toBeNull();
    expect(result.current.cursorResumeCommand).toBeNull();
  });
});

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@/types";

const platformMocks = vi.hoisted(() => ({
  isMac: vi.fn(() => true),
}));

const spawnMocks = vi.hoisted(() => ({
  spawnCursorLiveTerminal: vi.fn(),
  spawnProviderLiveTerminal: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({
  isMac: () => platformMocks.isMac(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("@/components/sessions/liveTerminalSpawn", () => ({
  spawnCursorLiveTerminal: spawnMocks.spawnCursorLiveTerminal,
  spawnProviderLiveTerminal: spawnMocks.spawnProviderLiveTerminal,
}));

import { useSessionLiveTerminal } from "@/components/sessions/useSessionLiveTerminal";

function cursorSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    providerId: "cursor",
    sessionId: "chat-1",
    sourcePath: "/tmp/store.db",
    projectDir: "/tmp/project",
    ...overrides,
  } as SessionMeta;
}

function claudeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    providerId: "claude",
    sessionId: "sess-1",
    sourcePath: "/tmp/claude.jsonl",
    projectDir: "/tmp/project",
    resumeCommand: "claude --resume sess-1",
    ...overrides,
  } as SessionMeta;
}

describe("useSessionLiveTerminal", () => {
  beforeEach(() => {
    platformMocks.isMac.mockReset().mockReturnValue(true);
    spawnMocks.spawnCursorLiveTerminal.mockReset();
    spawnMocks.spawnProviderLiveTerminal.mockReset();
  });

  it("enables Cursor live terminal only when primary action is ready", () => {
    const { result, rerender } = renderHook(
      ({ action }) =>
        useSessionLiveTerminal({
          readerSession: cursorSession(),
          readerKey: "cursor:chat-1",
          cursorPrimaryAction: action,
        }),
      {
        initialProps: {
          action: { label: "继续", disabled: true, onClick: () => undefined },
        },
      },
    );

    expect(result.current.liveTerminalEnabled).toBe(false);

    rerender({
      action: { label: "继续", disabled: false, onClick: () => undefined },
    });
    expect(result.current.liveTerminalEnabled).toBe(true);
  });

  it("refuses Cursor spawn when primary action is missing or disabled", async () => {
    const { result } = renderHook(() =>
      useSessionLiveTerminal({
        readerSession: cursorSession(),
        readerKey: "cursor:chat-1",
        cursorPrimaryAction: null,
      }),
    );

    await expect(
      result.current.handleLiveTerminalSpawn({ cols: 80, rows: 24 }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(spawnMocks.spawnCursorLiveTerminal).not.toHaveBeenCalled();
  });

  it("routes ready Cursor sessions through spawnCursorLiveTerminal", async () => {
    spawnMocks.spawnCursorLiveTerminal.mockResolvedValue({
      kind: "launched",
      ptyId: "pty-1",
    });

    const { result } = renderHook(() =>
      useSessionLiveTerminal({
        readerSession: cursorSession(),
        readerKey: "cursor:chat-1",
        cursorPrimaryAction: {
          label: "继续",
          disabled: false,
          onClick: () => undefined,
        },
      }),
    );

    await expect(
      result.current.handleLiveTerminalSpawn({ cols: 80, rows: 24 }),
    ).resolves.toEqual({ kind: "launched", ptyId: "pty-1" });
    expect(spawnMocks.spawnCursorLiveTerminal).toHaveBeenCalledWith({
      sessionId: "chat-1",
      cols: 80,
      rows: 24,
    });
    expect(spawnMocks.spawnProviderLiveTerminal).not.toHaveBeenCalled();
  });

  it("routes provider sessions through spawnProviderLiveTerminal", async () => {
    spawnMocks.spawnProviderLiveTerminal.mockResolvedValue({
      kind: "launched",
      ptyId: "pty-2",
    });

    const { result } = renderHook(() =>
      useSessionLiveTerminal({
        readerSession: claudeSession(),
        readerKey: "claude:sess-1",
        cursorPrimaryAction: null,
      }),
    );

    expect(result.current.liveTerminalEnabled).toBe(true);
    await expect(
      result.current.handleLiveTerminalSpawn({ cols: 100, rows: 30 }),
    ).resolves.toEqual({ kind: "launched", ptyId: "pty-2" });
    expect(spawnMocks.spawnProviderLiveTerminal).toHaveBeenCalled();
    expect(spawnMocks.spawnCursorLiveTerminal).not.toHaveBeenCalled();
  });

  it("resets pane state when readerKey changes", () => {
    const { result, rerender } = renderHook(
      ({ key }) =>
        useSessionLiveTerminal({
          readerSession: claudeSession(),
          readerKey: key,
          cursorPrimaryAction: null,
        }),
      { initialProps: { key: "claude:a" } },
    );

    act(() => {
      result.current.openLiveTerminalPane();
    });
    expect(result.current.readerPane).toBe("terminal");
    expect(result.current.terminalVisited).toBe(true);

    rerender({ key: "claude:b" });
    expect(result.current.readerPane).toBe("transcript");
    expect(result.current.terminalVisited).toBe(false);
  });
});

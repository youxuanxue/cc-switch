import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  cursorApi: {
    spawnSessionPty: vi.fn(),
  },
  sessionsApi: {
    spawnPty: vi.fn(),
  },
}));

import { cursorApi, sessionsApi } from "@/lib/api";
import {
  spawnCursorLiveTerminal,
  spawnProviderLiveTerminal,
} from "@/components/sessions/liveTerminalSpawn";

describe("liveTerminalSpawn", () => {
  beforeEach(() => {
    vi.mocked(cursorApi.spawnSessionPty).mockReset();
    vi.mocked(sessionsApi.spawnPty).mockReset();
  });

  it("routes Cursor through dedicated spawnSessionPty IPC", async () => {
    vi.mocked(cursorApi.spawnSessionPty).mockResolvedValue({
      state: "launched",
      ptyId: "pty-cursor-1",
    });

    const result = await spawnCursorLiveTerminal({
      sessionId: "chat-1",
      cols: 80,
      rows: 24,
    });

    expect(cursorApi.spawnSessionPty).toHaveBeenCalledWith({
      sessionId: "chat-1",
      cols: 80,
      rows: 24,
    });
    expect(sessionsApi.spawnPty).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "launched", ptyId: "pty-cursor-1" });
  });

  it("maps Cursor occupied live sessions without spawning a second PTY", async () => {
    vi.mocked(cursorApi.spawnSessionPty).mockResolvedValue({
      state: "occupied",
      holder: "CodeG",
    });

    await expect(
      spawnCursorLiveTerminal({ sessionId: "chat-1", cols: 80, rows: 24 }),
    ).resolves.toEqual({ kind: "occupied", holder: "CodeG" });
  });

  it("maps Cursor focused live sessions without spawning a second PTY", async () => {
    vi.mocked(cursorApi.spawnSessionPty).mockResolvedValue({
      state: "focused",
      app: "iTerm",
    });

    await expect(
      spawnCursorLiveTerminal({ sessionId: "chat-1", cols: 80, rows: 24 }),
    ).resolves.toEqual({ kind: "focused", app: "iTerm" });
  });

  it("spawns non-Cursor providers through sessionsApi.spawnPty", async () => {
    vi.mocked(sessionsApi.spawnPty).mockResolvedValue({
      action: "launched",
      ptyId: "pty-claude-1",
    });

    const result = await spawnProviderLiveTerminal({
      session: {
        providerId: "claude",
        sessionId: "sess-1",
        resumeCommand: "claude --resume sess-1",
        projectDir: "/tmp/proj",
        sourcePath: "/tmp/proj/session.jsonl",
      },
      cols: 100,
      rows: 30,
    });

    expect(sessionsApi.spawnPty).toHaveBeenCalledWith({
      command: "claude --resume sess-1",
      cwd: "/tmp/proj",
      cols: 100,
      rows: 30,
      sessionId: "sess-1",
      providerId: "claude",
      sourcePath: "/tmp/proj/session.jsonl",
    });
    expect(cursorApi.spawnSessionPty).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "launched", ptyId: "pty-claude-1" });
  });

  it("maps provider focused live sessions without spawning a second PTY", async () => {
    vi.mocked(sessionsApi.spawnPty).mockResolvedValue({
      action: "focused",
      app: "iTerm",
    });

    await expect(
      spawnProviderLiveTerminal({
        session: {
          providerId: "claude",
          sessionId: "sess-1",
          resumeCommand: "claude --resume sess-1",
        },
        cols: 80,
        rows: 24,
      }),
    ).resolves.toEqual({ kind: "focused", app: "iTerm" });
    expect(sessionsApi.spawnPty).toHaveBeenCalledOnce();
  });

  it("rejects non-Cursor sessions without resumeCommand", async () => {
    await expect(
      spawnProviderLiveTerminal({
        session: {
          providerId: "claude",
          sessionId: "sess-1",
        },
        cols: 80,
        rows: 24,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "missing-resume-command",
    });
    expect(sessionsApi.spawnPty).not.toHaveBeenCalled();
  });
});

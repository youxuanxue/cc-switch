import { cursorApi, sessionsApi } from "@/lib/api";
import type { SessionMeta } from "@/types";

export type LiveTerminalSpawnResult =
  | { kind: "launched"; ptyId: string }
  | { kind: "focused"; app: string }
  | { kind: "occupied"; holder: string }
  | { kind: "workspaceRequired" }
  | { kind: "unavailable"; reason: string };

export async function spawnCursorLiveTerminal(options: {
  sessionId: string;
  cols: number;
  rows: number;
}): Promise<LiveTerminalSpawnResult> {
  const result = await cursorApi.spawnSessionPty({
    sessionId: options.sessionId,
    cols: options.cols,
    rows: options.rows,
  });
  if (result.state === "launched") {
    return { kind: "launched", ptyId: result.ptyId };
  }
  if (result.state === "focused") {
    return { kind: "focused", app: result.app };
  }
  if (result.state === "occupied") {
    return { kind: "occupied", holder: result.holder };
  }
  return { kind: "workspaceRequired" };
}

export async function spawnProviderLiveTerminal(options: {
  session: SessionMeta;
  cols: number;
  rows: number;
}): Promise<LiveTerminalSpawnResult> {
  const { session, cols, rows } = options;
  if (!session.resumeCommand) {
    return {
      kind: "unavailable",
      reason: "missing-resume-command",
    };
  }
  const result = await sessionsApi.spawnPty({
    command: session.resumeCommand,
    cwd: session.projectDir ?? undefined,
    cols,
    rows,
    sessionId: session.sessionId,
    providerId: session.providerId,
    sourcePath: session.sourcePath,
  });
  if (result.action === "launched") {
    return { kind: "launched", ptyId: result.ptyId };
  }
  if (result.action === "focused") {
    return { kind: "focused", app: result.app };
  }
  return { kind: "occupied", holder: result.holder };
}

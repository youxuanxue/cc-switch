import { invoke } from "@tauri-apps/api/core";
import type { SessionMessage, SessionMeta } from "@/types";

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  error?: string;
}

export type ResumeLaunchResult =
  | { action: "launched" }
  | { action: "focused"; app: string }
  | { action: "occupied"; holder: string };

export type SessionPtySpawnResult =
  | { action: "launched"; ptyId: string }
  | { action: "focused"; app: string }
  | { action: "occupied"; holder: string };

export type SessionResumeAppearance = "resume" | "return" | "returnToCodeG";

export interface SessionResumeState {
  appearance: SessionResumeAppearance;
}

export interface WtsWorkspace {
  slug: string;
  path: string;
}

export interface WtsProjectContext {
  isGitRepo: boolean;
  workspaces: WtsWorkspace[];
}

export interface SessionLiveState {
  providerId: string;
  sessionId: string;
  isLive: boolean;
}

export interface SessionLiveProbe {
  providerId: string;
  sessionId: string;
  sourcePath?: string | null;
}

export interface CursorPruneResult {
  bucketsRemoved: number;
  staleChatsRemoved: number;
  orphanDirsRemoved: number;
  bucketsRetained: number;
  scannableChatsRetained: number;
}

export interface WtsWorktreePruneResult {
  removed: number;
  gitRemoved: number;
  retained: number;
  skippedDirty: number;
}

export interface SessionStoragePruneResult {
  cursor: CursorPruneResult;
  claudePartitionsRemoved: number;
  codexEmptyDirsRemoved: number;
  geminiPartitionsRemoved: number;
  grokPartitionsRemoved: number;
  cursorDesktopWorkspacesRemoved: number;
  cursorDesktopWorkspacesRetained: number;
  wtsWorktrees: WtsWorktreePruneResult;
}

export interface WtsRegisteredWorktreeAssessment {
  path: string;
  repoPath: string;
  slug: string;
  branch?: string | null;
  sessionCount: number;
  merged: boolean;
  clean: boolean;
  removable: boolean;
  skipReason?: string | null;
}

export interface ClassifyStaleRegisteredWtsResult {
  removable: WtsRegisteredWorktreeAssessment[];
  skipped: WtsRegisteredWorktreeAssessment[];
}

export interface RemoveStaleRegisteredWtsResult {
  removed: number;
  failed: Array<{ path: string; error: string }>;
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async listWtsWorkspaces(projectDir: string): Promise<WtsProjectContext> {
    return await invoke("list_wts_workspaces", { projectDir });
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionMessage[]> {
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  async getResumeState(
    providerId: string,
    sessionId: string,
    sourcePath?: string | null,
  ): Promise<SessionResumeState> {
    return await invoke("get_session_resume_state", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async classifyLiveStates(
    items: SessionLiveProbe[],
  ): Promise<SessionLiveState[]> {
    return await invoke("classify_session_live_states", { items });
  },

  async pruneSessionStorage(): Promise<SessionStoragePruneResult> {
    return await invoke("prune_session_storage");
  },

  async classifyStaleRegisteredWtsWorktrees(): Promise<ClassifyStaleRegisteredWtsResult> {
    return await invoke("classify_stale_registered_wts_worktrees");
  },

  async removeStaleRegisteredWtsWorktrees(
    paths: string[],
  ): Promise<RemoveStaleRegisteredWtsResult> {
    return await invoke("remove_stale_registered_wts_worktrees", { paths });
  },

  async delete(options: DeleteSessionOptions): Promise<boolean> {
    const { providerId, sessionId, sourcePath } = options;
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
  ): Promise<DeleteSessionResult[]> {
    return await invoke("delete_sessions", { items });
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
    sessionId?: string | null;
    providerId?: string | null;
    sourcePath?: string | null;
    terminal?: string | null;
  }): Promise<ResumeLaunchResult> {
    const {
      command,
      cwd,
      customConfig,
      sessionId,
      providerId,
      sourcePath,
      terminal,
    } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
      sessionId,
      providerId,
      sourcePath,
      terminal,
    });
  },

  async spawnPty(options: {
    command: string;
    cwd?: string | null;
    cols?: number;
    rows?: number;
    sessionId?: string | null;
    providerId?: string | null;
    sourcePath?: string | null;
  }): Promise<SessionPtySpawnResult> {
    const { command, cwd, cols, rows, sessionId, providerId, sourcePath } =
      options;
    return await invoke("spawn_session_pty", {
      command,
      cwd,
      cols,
      rows,
      sessionId,
      providerId,
      sourcePath,
    });
  },

  async ptyWrite(ptyId: string, data: string): Promise<void> {
    return await invoke("session_pty_write", { ptyId, data });
  },

  async ptyResize(ptyId: string, cols: number, rows: number): Promise<void> {
    return await invoke("session_pty_resize", { ptyId, cols, rows });
  },

  async ptyKill(ptyId: string): Promise<void> {
    return await invoke("session_pty_kill", { ptyId });
  },
};

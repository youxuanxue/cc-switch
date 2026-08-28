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

export type SessionResumeAppearance = "resume" | "return" | "returnToCodeG";

export interface SessionResumeState {
  appearance: SessionResumeAppearance;
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
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
  }): Promise<ResumeLaunchResult> {
    const { command, cwd, customConfig, sessionId, providerId, sourcePath } =
      options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
      sessionId,
      providerId,
      sourcePath,
    });
  },
};

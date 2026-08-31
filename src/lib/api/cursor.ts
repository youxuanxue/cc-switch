import { invoke } from "@tauri-apps/api/core";

export type CursorOfficialAuthMode = "login" | "userApiKey";
export type CursorOfficialRuntimeState =
  | "ready"
  | "needsLogin"
  | "needsApiKey"
  | "cliMissing"
  | "statusUnavailable";

export interface CursorOfficialAccount {
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface CursorOfficialStatus {
  installed: boolean;
  version?: string;
  authMode: CursorOfficialAuthMode;
  hasUserApiKey: boolean;
  authenticated: boolean;
  account?: CursorOfficialAccount;
  state: CursorOfficialRuntimeState;
  error?: string;
}

export type CursorSessionIndexStatus =
  | { state: "indexReady" }
  | { state: "indexUnavailable"; reason: string };

export type CursorSessionResumeContext =
  | { workspaceState: "ready"; workspace: string }
  | { workspaceState: "workspaceRequired" };

export type CursorLaunchResult =
  | { state: "launched" }
  | { state: "workspaceRequired" }
  | { state: "focused"; app: string }
  | { state: "occupied"; holder: string };

export interface CursorOfficialAuthUpdate {
  authMode: CursorOfficialAuthMode;
  userApiKey?: string;
}

export interface CursorSessionRequest {
  sessionId: string;
  workspaceOverride?: string;
}

export const cursorApi = {
  async getOfficialStatus(): Promise<CursorOfficialStatus> {
    return await invoke("get_cursor_official_status");
  },

  async updateOfficialAuth(
    update: CursorOfficialAuthUpdate,
  ): Promise<CursorOfficialStatus> {
    return await invoke("update_cursor_official_auth", {
      authMode: update.authMode,
      userApiKey: update.userApiKey,
    });
  },

  async clearUserApiKey(): Promise<CursorOfficialStatus> {
    return await invoke("clear_cursor_user_api_key");
  },

  async getSessionIndexStatus(): Promise<CursorSessionIndexStatus> {
    return await invoke("get_cursor_session_index_status");
  },

  async getSessionResumeContext(
    request: CursorSessionRequest,
  ): Promise<CursorSessionResumeContext> {
    return await invoke("get_cursor_session_resume_context", {
      sessionId: request.sessionId,
      workspaceOverride: request.workspaceOverride,
    });
  },

  async launchSession(
    request: CursorSessionRequest,
  ): Promise<CursorLaunchResult> {
    return await invoke("launch_cursor_session", {
      sessionId: request.sessionId,
      workspaceOverride: request.workspaceOverride,
    });
  },

  async launchLogin(): Promise<CursorLaunchResult> {
    return await invoke("launch_cursor_login");
  },

  async launchLoginAndSession(
    request: CursorSessionRequest,
  ): Promise<CursorLaunchResult> {
    return await invoke("launch_cursor_login_and_session", {
      sessionId: request.sessionId,
      workspaceOverride: request.workspaceOverride,
    });
  },
};

export type CursorResumeState =
  | "platformUnavailable"
  | "cliMissing"
  | "workspaceRequired"
  | "needsLogin"
  | "needsApiKey"
  | "ready";

export interface CursorResumeStateInput {
  isMac: boolean;
  installed: boolean;
  workspaceState: "ready" | "required";
  authMode: "login" | "userApiKey";
  authenticated: boolean;
}

export function deriveCursorResumeState(
  input: CursorResumeStateInput,
): CursorResumeState {
  if (!input.isMac) return "platformUnavailable";
  if (!input.installed) return "cliMissing";
  if (input.workspaceState === "required") return "workspaceRequired";
  if (!input.authenticated) {
    return input.authMode === "login" ? "needsLogin" : "needsApiKey";
  }
  return "ready";
}

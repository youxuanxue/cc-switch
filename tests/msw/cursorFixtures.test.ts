import { describe, expect, it } from "vitest";
import { cursorApi } from "@/lib/api/cursor";
import {
  getCursorIpcCalls,
  setCursorLaunchResult,
  setCursorOfficialStatus,
  setCursorSessionIndexStatus,
  setCursorSessionResumeContext,
} from "./state";

describe("Cursor MSW IPC fixtures", () => {
  it("serves configurable status, index, context, and launch states", async () => {
    setCursorOfficialStatus({
      installed: true,
      version: "agent fixture",
      authMode: "login",
      hasUserApiKey: false,
      authenticated: false,
      state: "needsLogin",
    });
    setCursorSessionIndexStatus({
      state: "indexUnavailable",
      reason: "fixture index unavailable",
    });
    setCursorSessionResumeContext({ workspaceState: "workspaceRequired" });
    setCursorLaunchResult("launch_cursor_session", {
      state: "workspaceRequired",
    });

    expect(await cursorApi.getOfficialStatus()).toMatchObject({
      state: "needsLogin",
      authenticated: false,
    });
    expect(await cursorApi.getSessionIndexStatus()).toEqual({
      state: "indexUnavailable",
      reason: "fixture index unavailable",
    });
    expect(
      await cursorApi.getSessionResumeContext({
        sessionId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({ workspaceState: "workspaceRequired" });
    expect(
      await cursorApi.launchSession({
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceOverride: "/mock/workspace",
      }),
    ).toEqual({ state: "workspaceRequired" });

    expect(getCursorIpcCalls()).toContainEqual({
      command: "launch_cursor_session",
      payloadKeys: ["sessionId", "workspaceOverride"],
      payload: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        workspaceOverride: "/mock/workspace",
      },
    });
  });

  it("never stores or returns the submitted User API Key body", async () => {
    const fixtureKey = "cursor-fixture-secret";

    const status = await cursorApi.updateOfficialAuth({
      authMode: "userApiKey",
      userApiKey: fixtureKey,
    });

    expect(status).toMatchObject({
      authMode: "userApiKey",
      hasUserApiKey: true,
      authenticated: true,
      state: "ready",
    });
    expect(JSON.stringify(status)).not.toContain(fixtureKey);
    expect(getCursorIpcCalls()).toContainEqual({
      command: "update_cursor_official_auth",
      payloadKeys: ["authMode", "userApiKey"],
      payload: {
        authMode: "userApiKey",
        userApiKey: "[REDACTED]",
      },
    });
    expect(JSON.stringify(getCursorIpcCalls())).not.toContain(fixtureKey);
  });
});

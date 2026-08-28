import { describe, expect, it } from "vitest";
import {
  deriveCursorResumeState,
  type CursorResumeStateInput,
} from "@/components/sessions/cursorResumeState";

const readyInput: CursorResumeStateInput = {
  isMac: true,
  installed: true,
  workspaceState: "ready",
  authMode: "login",
  authenticated: true,
};

describe("deriveCursorResumeState", () => {
  it("US-002 derives resume state in fixed priority order", () => {
    const cases: Array<{
      name: string;
      input: CursorResumeStateInput;
      expected:
        | "platformUnavailable"
        | "cliMissing"
        | "workspaceRequired"
        | "needsLogin"
        | "needsApiKey"
        | "ready";
    }> = [
      {
        name: "platform masks every lower-priority problem",
        input: {
          isMac: false,
          installed: false,
          workspaceState: "required",
          authMode: "login",
          authenticated: false,
        },
        expected: "platformUnavailable",
      },
      {
        name: "missing CLI masks workspace and authentication",
        input: {
          ...readyInput,
          installed: false,
          workspaceState: "required",
          authenticated: false,
        },
        expected: "cliMissing",
      },
      {
        name: "workspace masks login remediation",
        input: {
          ...readyInput,
          workspaceState: "required",
          authenticated: false,
        },
        expected: "workspaceRequired",
      },
      {
        name: "workspace masks API key remediation",
        input: {
          ...readyInput,
          workspaceState: "required",
          authMode: "userApiKey",
          authenticated: false,
        },
        expected: "workspaceRequired",
      },
      {
        name: "login mode asks for login",
        input: { ...readyInput, authenticated: false },
        expected: "needsLogin",
      },
      {
        name: "User API Key mode asks for a key",
        input: {
          ...readyInput,
          authMode: "userApiKey",
          authenticated: false,
        },
        expected: "needsApiKey",
      },
      {
        name: "all prerequisites ready",
        input: readyInput,
        expected: "ready",
      },
    ];

    for (const testCase of cases) {
      expect(deriveCursorResumeState(testCase.input), testCase.name).toBe(
        testCase.expected,
      );
    }
  });

  it("US-004 blocks Cursor resume outside macOS without blocking indexing", () => {
    expect(
      deriveCursorResumeState({
        ...readyInput,
        isMac: false,
      }),
    ).toBe("platformUnavailable");
  });
});

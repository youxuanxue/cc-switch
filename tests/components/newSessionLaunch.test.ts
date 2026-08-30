import { describe, expect, it } from "vitest";
import {
  buildNewSessionLaunch,
  collectKnownProjects,
  defaultNewSessionProjectDir,
  defaultNewSessionProvider,
  normalizeWorkspaceSlug,
} from "@/components/sessions/newSessionLaunch";
import type { SessionMeta } from "@/types";

const session = (
  overrides: Partial<SessionMeta> &
    Pick<SessionMeta, "providerId" | "sessionId">,
): SessionMeta => overrides;

describe("newSessionLaunch", () => {
  it("defaults to the selected project's main checkout and a launchable agent", () => {
    const selected = session({
      providerId: "codex",
      sessionId: "wt",
      projectDir: "/Users/feng/Codes/cc-switch-wt-review",
    });
    const sessions = [
      selected,
      session({
        providerId: "claude",
        sessionId: "other",
        projectDir: "/tmp/other",
      }),
    ];

    expect(defaultNewSessionProjectDir(selected, sessions)).toBe(
      "/Users/feng/Codes/cc-switch",
    );
    expect(defaultNewSessionProvider("all", selected)).toBe("codex");
    expect(defaultNewSessionProvider("cursor", selected)).toBe("cursor");
    expect(collectKnownProjects(sessions).map((project) => project.dir)).toEqual(
      ["/Users/feng/Codes/cc-switch", "/tmp/other"],
    );
  });

  it("builds a main-workspace launch and a wts create-or-attach command", () => {
    expect(
      buildNewSessionLaunch({
        providerId: "claude",
        projectDir: "/Users/feng/Codes/cc-switch",
        workspace: "main",
      }),
    ).toEqual({
      command: "claude",
      cwd: "/Users/feng/Codes/cc-switch",
    });
    expect(
      buildNewSessionLaunch({
        providerId: "cursor",
        projectDir: "/Users/feng/Codes/cc-switch",
        workspace: "review",
      }),
    ).toEqual({
      command: "WTS_HERE=1 wts --repo '/Users/feng/Codes/cc-switch' review agent",
      cwd: "/Users/feng/Codes/cc-switch",
    });
  });

  it("rejects empty projects, unsafe slugs, and non-wts workspace creation", () => {
    expect(normalizeWorkspaceSlug("../escape")).toBeNull();
    expect(normalizeWorkspaceSlug("has/slash")).toBeNull();
    expect(
      buildNewSessionLaunch({
        providerId: "claude",
        projectDir: "  ",
        workspace: "main",
      }),
    ).toEqual({ error: "invalid-project" });
    expect(
      buildNewSessionLaunch({
        providerId: "gemini",
        projectDir: "/tmp/repo",
        workspace: "review",
      }),
    ).toEqual({ error: "create-requires-wts" });
    expect(
      buildNewSessionLaunch({
        providerId: "gemini",
        projectDir: "/tmp/repo",
        workspace: "review",
        knownWorkspaces: [{ slug: "review", path: "/tmp/repo-wt-review" }],
      }),
    ).toEqual({
      command: "gemini",
      cwd: "/tmp/repo-wt-review",
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  extractCodexPromptPreview,
  formatSessionMessagePreview,
  getSessionResumeI18nKeys,
  groupSessionsByProject,
  groupSessionsByProviderAndDirectory,
  resolveWtsProjectIdentity,
  extractCursorDisplayContent,
  shouldHideCodexMessageFromToc,
  shouldHideCursorMessageFromToc,
} from "@/components/sessions/utils";
import { isSessionDeletable } from "@/components/sessions/sessionCapabilities";
import type { SessionMeta } from "@/types";

describe("session utils", () => {
  it("extracts Codex VS Code prompts after the request marker", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active file: src/main.ts",
      "",
      "## My request for Codex:",
      "Fix the session title preview",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "Fix the session title preview",
    );
  });

  it("extracts inline Codex VS Code prompts", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## My request for Codex: Fix the TOC preview",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe("Fix the TOC preview");
  });

  it("ignores marker mentions before the Codex request heading", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active selection:",
      "My request for Codex: not the prompt",
      "",
      "## My request for Codex:",
      "Use the real request heading",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "Use the real request heading",
    );
  });

  it("uses the last request heading when the selection contains one", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active selection: docs/codex-format.md:10-14",
      "## My request for Codex:",
      "selected document content, not the real request",
      "",
      "## My request for Codex:",
      "the real injected request",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe(
      "the real injected request",
    );
  });

  // Known limitation: the IDE marker is matched purely by text, so a
  // "## My request for Codex:" line inside the real request body is treated as
  // a new boundary and only the trailing part is kept. Pinning this documents
  // the best-effort behavior; fully fixing it needs structured IDE section data
  // that the Codex VS Code context does not provide.
  it("keeps only the trailing part when the request body repeats the heading", () => {
    const content = [
      "# Context from my IDE setup:",
      "",
      "## Active file: foo.ts",
      "",
      "## My request for Codex:",
      "Document the format, for example:",
      "## My request for Codex:",
      "and the rest follows.",
    ].join("\n");

    expect(extractCodexPromptPreview(content)).toBe("and the rest follows.");
  });

  it("does not extract from ordinary messages that mention the marker", () => {
    const content = "Please explain the phrase My request for Codex.";

    expect(extractCodexPromptPreview(content)).toBe(content);
  });

  it("hides Cursor user_info envelopes from the TOC", () => {
    expect(
      shouldHideCursorMessageFromToc(
        "<user_info>\nOS Version: darwin\n</user_info>",
      ),
    ).toBe(true);
    expect(shouldHideCursorMessageFromToc("continue the cursor task")).toBe(
      false,
    );
  });

  it("extracts Cursor user_query and hides summary envelopes", () => {
    expect(
      extractCursorDisplayContent(
        "<timestamp>Saturday Aug 29, 2026, 7:54 PM</timestamp>\n<user_query>把 Cursor 做成和其他会话一样能翻对话记录</user_query>",
      ),
    ).toBe("把 Cursor 做成和其他会话一样能翻对话记录");
    expect(
      shouldHideCursorMessageFromToc(
        "<timestamp>Saturday Aug 29, 2026, 8:12 PM</timestamp>\n<user_query>Your conversation was summarized due to context constraints.</user_query>",
      ),
    ).toBe(true);
    expect(
      extractCursorDisplayContent(
        "<user_info>\nOS Version: darwin\n</user_info>\n<git_status>\nM file\n</git_status>",
      ),
    ).toBe("");
  });

  it("hides Codex context messages without user prompts from the TOC", () => {
    expect(
      shouldHideCodexMessageFromToc("# AGENTS.md instructions for F:/project"),
    ).toBe(true);
    expect(
      shouldHideCodexMessageFromToc(
        "<environment_context>\n<cwd>F:/project</cwd>",
      ),
    ).toBe(true);
    expect(shouldHideCodexMessageFromToc("# Context from my IDE setup:")).toBe(
      true,
    );
    expect(
      shouldHideCodexMessageFromToc(
        "# Context from my IDE setup:\n\n## My request for Codex:\nFix it",
      ),
    ).toBe(false);
  });

  it("formats message previews with truncation", () => {
    expect(formatSessionMessagePreview("short message")).toBe("short message");
    expect(formatSessionMessagePreview("a".repeat(51))).toBe(
      `${"a".repeat(50)}...`,
    );
  });

  it("groups sessions by provider and project directory", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: "/workspace/app",
      },
      {
        providerId: "codex",
        sessionId: "codex-2",
        projectDir: "/workspace/app",
      },
      {
        providerId: "claude",
        sessionId: "claude-1",
        projectDir: "/workspace/docs",
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups).toHaveLength(2);
    expect(groups[0].providerId).toBe("codex");
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "codex-1",
      "codex-2",
    ]);
    expect(groups[0].directories).toHaveLength(1);
    expect(groups[0].directories[0]).toMatchObject({
      projectDir: "/workspace/app",
      label: "app",
    });
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["codex-1", "codex-2"]);
    expect(groups[1].providerId).toBe("claude");
    expect(groups[1].directories[0].label).toBe("docs");
  });

  it("uses an unknown directory group for sessions without project directories", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: null,
      },
      {
        providerId: "codex",
        sessionId: "codex-2",
        projectDir: "   ",
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups).toHaveLength(1);
    expect(groups[0].directories).toHaveLength(1);
    expect(groups[0].directories[0]).toMatchObject({
      projectDir: null,
      label: "未知目录",
    });
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["codex-1", "codex-2"]);
  });

  it("preserves filtered session order inside provider and directory groups", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "newest",
        projectDir: "/workspace/app",
        lastActiveAt: 30,
      },
      {
        providerId: "codex",
        sessionId: "middle",
        projectDir: "/workspace/docs",
        lastActiveAt: 20,
      },
      {
        providerId: "codex",
        sessionId: "oldest",
        projectDir: "/workspace/app",
        lastActiveAt: 10,
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(groups[0].directories.map((group) => group.label)).toEqual([
      "app",
      "docs",
    ]);
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual(["newest", "oldest"]);
  });

  it("groups Cursor sessions directly by metadata cwd without a Project entity", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        projectDir: "/workspace/cursor-app",
      },
      {
        providerId: "cursor",
        sessionId: "22222222-2222-4222-8222-222222222222",
        projectDir: "/workspace/cursor-app",
      },
    ];

    const groups = groupSessionsByProviderAndDirectory(sessions, "未知目录");

    expect(groups).toHaveLength(1);
    expect(groups[0].providerId).toBe("cursor");
    expect(groups[0].directories).toHaveLength(1);
    expect(groups[0].directories[0]).toMatchObject({
      projectDir: "/workspace/cursor-app",
      label: "cursor-app",
    });
    expect(
      groups[0].directories[0].sessions.map((session) => session.sessionId),
    ).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("aggregates sessions from different agents under the same project", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "cursor",
        sessionId: "cursor-1",
        projectDir: "/workspace/app/",
      },
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: "/workspace/app",
      },
      {
        providerId: "claude",
        sessionId: "claude-1",
        projectDir: "/workspace/docs",
      },
    ];

    const groups = groupSessionsByProject(sessions, "未知目录");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      projectDir: "/workspace/app",
      label: "app",
      providerIds: ["cursor", "codex"],
    });
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "cursor-1",
      "codex-1",
    ]);
    expect(groups[1]).toMatchObject({
      projectDir: "/workspace/docs",
      label: "docs",
      providerIds: ["claude"],
    });
  });

  it("keeps same-named directories on different paths as separate projects", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "app-a",
        projectDir: "/work/acme/app",
      },
      {
        providerId: "cursor",
        sessionId: "app-b",
        projectDir: "/tmp/app",
      },
    ];

    const groups = groupSessionsByProject(sessions, "未知目录");

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.projectDir)).toEqual([
      "/work/acme/app",
      "/tmp/app",
    ]);
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "app-a",
    ]);
    expect(groups[1].sessions.map((session) => session.sessionId)).toEqual([
      "app-b",
    ]);
  });

  it("uses an unknown project group for sessions without project directories", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "codex",
        sessionId: "codex-1",
        projectDir: null,
      },
      {
        providerId: "claude",
        sessionId: "claude-1",
        projectDir: "   ",
      },
    ];

    const groups = groupSessionsByProject(sessions, "未知目录");

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      projectDir: null,
      label: "未知目录",
      providerIds: ["codex", "claude"],
    });
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "codex-1",
      "claude-1",
    ]);
  });

  it("maps wts worktrees back to the sibling main checkout", () => {
    expect(
      resolveWtsProjectIdentity(
        "/Users/feng/Codes/cc-switch-wt-cursor-official-sessions",
      ),
    ).toEqual({
      key: "/Users/feng/Codes/cc-switch",
      canonicalDir: "/Users/feng/Codes/cc-switch",
      label: "cc-switch",
      worktreeSlug: "cursor-official-sessions",
    });
    expect(
      resolveWtsProjectIdentity("/Users/feng/Codes/cc-switch-wt-foo-wt-bar"),
    ).toMatchObject({
      key: "/Users/feng/Codes/cc-switch-wt-foo",
      worktreeSlug: "bar",
    });
    expect(resolveWtsProjectIdentity("/Users/feng/Codes/cc-switch")).toEqual({
      key: "/Users/feng/Codes/cc-switch",
      canonicalDir: "/Users/feng/Codes/cc-switch",
      label: "cc-switch",
      worktreeSlug: null,
    });
  });

  it("aggregates the main checkout and wts worktrees as one project", () => {
    const sessions: SessionMeta[] = [
      {
        providerId: "cursor",
        sessionId: "main",
        projectDir: "/Users/feng/Codes/cc-switch",
      },
      {
        providerId: "codex",
        sessionId: "wt-a",
        projectDir: "/Users/feng/Codes/cc-switch-wt-cursor-official-sessions/",
      },
      {
        providerId: "claude",
        sessionId: "wt-b",
        projectDir: "/Users/feng/Codes/cc-switch-wt-session-project-view",
      },
      {
        providerId: "cursor",
        sessionId: "other-repo",
        projectDir: "/tmp/cc-switch-wt-lookalike",
      },
    ];

    const groups = groupSessionsByProject(sessions, "未知目录");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      key: "/Users/feng/Codes/cc-switch",
      projectDir: "/Users/feng/Codes/cc-switch",
      label: "cc-switch",
      providerIds: ["cursor", "codex", "claude"],
      workspaceDirs: [
        "/Users/feng/Codes/cc-switch",
        "/Users/feng/Codes/cc-switch-wt-cursor-official-sessions",
        "/Users/feng/Codes/cc-switch-wt-session-project-view",
      ],
    });
    expect(groups[0].sessions.map((session) => session.sessionId)).toEqual([
      "main",
      "wt-a",
      "wt-b",
    ]);
    expect(groups[1]).toMatchObject({
      key: "/tmp/cc-switch",
      projectDir: "/tmp/cc-switch",
      label: "cc-switch",
      workspaceDirs: ["/tmp/cc-switch-wt-lookalike"],
    });
    expect(groups[1].sessions.map((session) => session.sessionId)).toEqual([
      "other-repo",
    ]);
  });

  it("keeps deletion eligibility in one owner and only deletes Cursor Agent CLI chats", () => {
    expect(
      isSessionDeletable({
        providerId: "codex",
        sessionId: "source-backed",
        sourcePath: "/tmp/session.jsonl",
      }),
    ).toBe(true);
    expect(
      isSessionDeletable({
        providerId: "codex",
        sessionId: "missing-source",
      }),
    ).toBe(false);
    expect(
      isSessionDeletable({
        providerId: "cursor",
        sessionId: "11111111-1111-4111-8111-111111111111",
        sourcePath:
          "/Users/me/.cursor/chats/workspace/11111111-1111-4111-8111-111111111111/store.db",
      }),
    ).toBe(true);
    expect(
      isSessionDeletable({
        providerId: "cursor",
        sessionId: "cursor-with-defensive-source",
        sourcePath: "/tmp/must-not-delete.jsonl",
      }),
    ).toBe(false);
  });

  it("maps resume appearance to the sessionManager i18n keys", () => {
    expect(getSessionResumeI18nKeys("resume")).toEqual({
      labelKey: "sessionManager.resume",
      tooltipKey: "sessionManager.resumeTooltip",
    });
    expect(getSessionResumeI18nKeys("return")).toEqual({
      labelKey: "sessionManager.returnToSession",
      tooltipKey: "sessionManager.returnToSessionTooltip",
    });
    expect(getSessionResumeI18nKeys("returnToCodeG")).toEqual({
      labelKey: "sessionManager.returnToCodeG",
      tooltipKey: "sessionManager.returnToCodeGTooltip",
    });
    expect(getSessionResumeI18nKeys(undefined).labelKey).toBe(
      "sessionManager.resume",
    );
  });
});

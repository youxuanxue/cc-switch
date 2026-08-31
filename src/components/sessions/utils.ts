import type { ReactNode } from "react";
import { createElement } from "react";
import { SessionMeta } from "@/types";

const CODEX_IDE_CONTEXT_PREFIX = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER = "my request for codex";
export const UNKNOWN_PROJECT_DIR_KEY = "__unknown_project_dir__";

export interface SessionDirectoryGroup {
  key: string;
  projectDir: string | null;
  label: string;
  sessions: SessionMeta[];
}

export interface SessionProviderGroup {
  providerId: string;
  sessions: SessionMeta[];
  directories: SessionDirectoryGroup[];
}

export interface SessionProjectGroup {
  key: string;
  projectDir: string | null;
  label: string;
  sessions: SessionMeta[];
  providerIds: string[];
  workspaceDirs: string[];
}

const getCodexRequestHeadingPayload = (lineText: string) => {
  if (!lineText.startsWith("#")) return null;

  const heading = lineText.replace(/^#+\s*/, "");
  const suffix = heading.toLowerCase().startsWith(CODEX_REQUEST_MARKER)
    ? heading.slice(CODEX_REQUEST_MARKER.length).trimStart()
    : null;

  if (suffix === null) return null;
  if (!suffix) return "";
  if (!/^[:：\-—]/.test(suffix)) return null;

  return suffix.replace(/^[:：\-—\s]+/, "").trim();
};

const extractCodexPromptFromIdeContext = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX)) {
    return null;
  }

  // VS Code injects the real prompt as the LAST "## My request for Codex:"
  // section, so keep the final matching heading. Earlier matches can be
  // headings that live inside the active selection / open file content.
  // Trade-off: if the request body itself repeats the heading, the preview
  // truncates to its trailing part (rare; see sessionUtils.test.ts).
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  let prompt: string | null = null;
  for (const [index, line] of lines.entries()) {
    const inlinePrompt = getCodexRequestHeadingPayload(line.trim());
    if (inlinePrompt === null) continue;

    if (inlinePrompt) {
      prompt = inlinePrompt;
      continue;
    }

    const followingPrompt = lines
      .slice(index + 1)
      .join("\n")
      .trim();
    prompt = followingPrompt || null;
  }

  return prompt;
};

export const getSessionKey = (session: SessionMeta) =>
  `${session.providerId}:${session.sessionId}:${session.sourcePath ?? ""}`;

export const normalizeProjectDir = (projectDir?: string | null) => {
  const trimmed = projectDir?.trim().replace(/[\\/]+$/, "") || "";
  return trimmed || null;
};

export const getSessionDirectoryGroupKey = (
  providerId: string,
  projectDir?: string | null,
) => {
  const trimmed = projectDir?.trim();
  return `${providerId}:${trimmed || UNKNOWN_PROJECT_DIR_KEY}`;
};

const WTS_WORKTREE_MARKER = "-wt-";

export interface WtsProjectIdentity {
  key: string;
  canonicalDir: string | null;
  label: string;
  worktreeSlug: string | null;
}

export interface ProjectIdentityOptions {
  caseInsensitive?: boolean;
}

const foldProjectGroupKey = (key: string) => key.toLowerCase();

const sameWorkspaceDir = (
  left: string,
  right: string,
  caseInsensitive?: boolean,
) =>
  caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;

export const resolveWtsProjectIdentity = (
  projectDir?: string | null,
  options?: ProjectIdentityOptions,
): WtsProjectIdentity => {
  const normalized = normalizeProjectDir(projectDir);
  if (!normalized) {
    return {
      key: UNKNOWN_PROJECT_DIR_KEY,
      canonicalDir: null,
      label: "",
      worktreeSlug: null,
    };
  }

  const sepIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  const parent = sepIndex >= 0 ? normalized.slice(0, sepIndex) : "";
  const base = sepIndex >= 0 ? normalized.slice(sepIndex + 1) : normalized;
  const sep = sepIndex >= 0 ? normalized[sepIndex] : "/";
  const markerIndex = base.lastIndexOf(WTS_WORKTREE_MARKER);
  const repo = markerIndex > 0 ? base.slice(0, markerIndex) : "";
  const slug =
    markerIndex > 0 ? base.slice(markerIndex + WTS_WORKTREE_MARKER.length) : "";

  const identity =
    repo && slug
      ? {
          key: parent ? `${parent}${sep}${repo}` : repo,
          canonicalDir: parent ? `${parent}${sep}${repo}` : repo,
          label: repo,
          worktreeSlug: slug,
        }
      : {
          key: normalized,
          canonicalDir: normalized,
          label: base,
          worktreeSlug: null,
        };

  if (options?.caseInsensitive) {
    return { ...identity, key: foldProjectGroupKey(identity.key) };
  }

  return identity;
};

export const getSessionProjectGroupKey = (
  projectDir?: string | null,
  options?: ProjectIdentityOptions,
) => resolveWtsProjectIdentity(projectDir, options).key;

export const getBaseName = (value?: string | null) => {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
};

export const formatTimestamp = (value?: number) => {
  if (!value) return "";
  return new Date(value).toLocaleString();
};

export const formatRelativeTime = (
  value: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) => {
  if (!value) return "";
  const now = Date.now();
  const diff = now - value;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return t("sessionManager.justNow");
  if (minutes < 60) return t("sessionManager.minutesAgo", { count: minutes });
  if (hours < 24) return t("sessionManager.hoursAgo", { count: hours });
  if (days < 7) return t("sessionManager.daysAgo", { count: days });
  return new Date(value).toLocaleDateString();
};

export const getProviderLabel = (
  providerId: string,
  t: (key: string) => string,
) => {
  const key = `apps.${providerId}`;
  const translated = t(key);
  return translated === key ? providerId : translated;
};

// 根据 providerId 获取对应的图标名称
export const getProviderIconName = (providerId: string) => {
  if (providerId === "cursor") return "cursor";
  if (providerId === "codex") return "openai";
  if (providerId === "grokbuild") return "grok";
  if (providerId === "claude") return "claude";
  if (providerId === "opencode") return "opencode";
  if (providerId === "openclaw") return "openclaw";
  return providerId;
};

export const getRoleTone = (role: string) => {
  const normalized = role.toLowerCase();
  if (normalized === "assistant") return "text-blue-500";
  if (normalized === "user") return "text-emerald-500";
  if (normalized === "system") return "text-amber-500";
  if (normalized === "tool") return "text-purple-500";
  return "text-muted-foreground";
};

export const getRoleLabel = (role: string, t: (key: string) => string) => {
  const normalized = role.toLowerCase();
  if (normalized === "assistant") return "AI";
  if (normalized === "user") return t("sessionManager.roleUser");
  if (normalized === "system") return t("sessionManager.roleSystem");
  if (normalized === "tool") return t("sessionManager.roleTool");
  return role;
};

export const formatSessionTitle = (session: SessionMeta) => {
  return (
    session.title ||
    getBaseName(session.projectDir) ||
    session.sessionId.slice(0, 8)
  );
};

export const groupSessionsByProviderAndDirectory = (
  sessions: SessionMeta[],
  unknownDirectoryLabel: string,
): SessionProviderGroup[] => {
  const providerGroups: SessionProviderGroup[] = [];
  const providerGroupMap = new Map<string, SessionProviderGroup>();
  const directoryGroupMaps = new Map<
    string,
    Map<string, SessionDirectoryGroup>
  >();

  sessions.forEach((session) => {
    let providerGroup = providerGroupMap.get(session.providerId);
    if (!providerGroup) {
      providerGroup = {
        providerId: session.providerId,
        sessions: [],
        directories: [],
      };
      providerGroupMap.set(session.providerId, providerGroup);
      providerGroups.push(providerGroup);
      directoryGroupMaps.set(session.providerId, new Map());
    }

    providerGroup.sessions.push(session);

    const trimmedProjectDir = session.projectDir?.trim() || null;
    const directoryKey = getSessionDirectoryGroupKey(
      session.providerId,
      trimmedProjectDir,
    );
    const directoryGroups = directoryGroupMaps.get(session.providerId)!;

    let directoryGroup = directoryGroups.get(directoryKey);
    if (!directoryGroup) {
      directoryGroup = {
        key: directoryKey,
        projectDir: trimmedProjectDir,
        label: trimmedProjectDir
          ? getBaseName(trimmedProjectDir) || trimmedProjectDir
          : unknownDirectoryLabel,
        sessions: [],
      };
      directoryGroups.set(directoryKey, directoryGroup);
      providerGroup.directories.push(directoryGroup);
    }

    directoryGroup.sessions.push(session);
  });

  return providerGroups;
};

export const groupSessionsByProject = (
  sessions: SessionMeta[],
  unknownDirectoryLabel: string,
  options?: ProjectIdentityOptions,
): SessionProjectGroup[] => {
  const projectGroups: SessionProjectGroup[] = [];
  const projectGroupMap = new Map<string, SessionProjectGroup>();

  sessions.forEach((session) => {
    const identity = resolveWtsProjectIdentity(session.projectDir, options);
    const workspaceDir = normalizeProjectDir(session.projectDir);
    let projectGroup = projectGroupMap.get(identity.key);

    if (!projectGroup) {
      projectGroup = {
        key: identity.key,
        projectDir: identity.canonicalDir,
        label: identity.canonicalDir ? identity.label : unknownDirectoryLabel,
        sessions: [],
        providerIds: [],
        workspaceDirs: [],
      };
      projectGroupMap.set(identity.key, projectGroup);
      projectGroups.push(projectGroup);
    }

    projectGroup.sessions.push(session);
    if (!projectGroup.providerIds.includes(session.providerId)) {
      projectGroup.providerIds.push(session.providerId);
    }
    if (
      workspaceDir &&
      !projectGroup.workspaceDirs.some((dir) =>
        sameWorkspaceDir(dir, workspaceDir, options?.caseInsensitive),
      )
    ) {
      projectGroup.workspaceDirs.push(workspaceDir);
    }
  });

  return projectGroups;
};

const CURSOR_ENVELOPE_TAGS =
  "user_info|git_status|agent_transcripts|rules|agent_skills|dynamic_tools|timestamp|system_notification|image_files|user_query";

export const extractCursorUserQuery = (content: string) => {
  let query: string | null = null;
  for (const match of content.matchAll(
    /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi,
  )) {
    const value = match[1]?.trim();
    if (value) query = value;
  }
  return query;
};

export const extractCursorDisplayContent = (content: string) => {
  const query = extractCursorUserQuery(content);
  if (query) return query;

  const remainder = content
    .replace(
      new RegExp(`<(${CURSOR_ENVELOPE_TAGS})>[\\s\\S]*?</\\1>`, "gi"),
      "",
    )
    .trim();
  if (remainder) return remainder;
  if (content.trimStart().startsWith("<")) return "";
  return content;
};

export const shouldHideCursorMessageFromToc = (content: string) => {
  const display = extractCursorDisplayContent(content);
  if (!display) return true;
  return display.startsWith("Your conversation was summarized");
};

export const extractCursorPromptPreview = (content: string) => {
  return extractCursorDisplayContent(content) || content;
};

export const shouldHideCodexMessageFromToc = (content: string) => {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("# AGENTS.md instructions for ") ||
    trimmed.startsWith("<environment_context>") ||
    (trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX) &&
      !extractCodexPromptFromIdeContext(trimmed))
  );
};

export const extractCodexPromptPreview = (content: string) => {
  return extractCodexPromptFromIdeContext(content) ?? content;
};

export const formatSessionMessagePreview = (
  content: string,
  maxLength = 50,
) => {
  return (
    content.slice(0, maxLength) + (content.length > maxLength ? "..." : "")
  );
};

export const highlightText = (text: string, query: string): ReactNode => {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1
      ? createElement(
          "mark",
          {
            key: i,
            className:
              "bg-yellow-200/60 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5",
          },
          part,
        )
      : part,
  );
};

export type SessionResumeAppearance = "resume" | "return" | "returnToCodeG";

export function getSessionResumeI18nKeys(
  appearance: SessionResumeAppearance | undefined,
): { labelKey: string; tooltipKey: string } {
  if (appearance === "return") {
    return {
      labelKey: "sessionManager.returnToSession",
      tooltipKey: "sessionManager.returnToSessionTooltip",
    };
  }
  if (appearance === "returnToCodeG") {
    return {
      labelKey: "sessionManager.returnToCodeG",
      tooltipKey: "sessionManager.returnToCodeGTooltip",
    };
  }
  return {
    labelKey: "sessionManager.resume",
    tooltipKey: "sessionManager.resumeTooltip",
  };
}

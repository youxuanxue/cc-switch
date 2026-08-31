import type { WtsProjectContext, WtsWorkspace } from "@/lib/api/sessions";
import type { SessionMeta } from "@/types";
import {
  resolveWtsProjectIdentity,
  type ProjectIdentityOptions,
} from "./utils";

export type { WtsProjectContext, WtsWorkspace };

export const MAIN_WORKSPACE = "main";

export const NEW_SESSION_PROVIDERS = [
  "cursor",
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "pi",
] as const;

export type NewSessionProvider = (typeof NEW_SESSION_PROVIDERS)[number];

export interface KnownProject {
  dir: string;
  label: string;
  slugs: string[];
}

export type NewSessionLaunch =
  | { command: string; cwd: string }
  | {
      error:
        | "invalid-project"
        | "invalid-workspace"
        | "create-requires-wts"
        | "requires-git";
    };

const WTS_RUNTIME: Partial<Record<NewSessionProvider, string>> = {
  cursor: "agent",
  claude: "claude",
  codex: "codex",
};

export function isNewSessionProvider(
  value: string,
): value is NewSessionProvider {
  return (NEW_SESSION_PROVIDERS as readonly string[]).includes(value);
}

export function normalizeWorkspaceSlug(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === MAIN_WORKSPACE) {
    return MAIN_WORKSPACE;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function collectKnownProjects(
  sessions: SessionMeta[],
  options?: ProjectIdentityOptions,
): KnownProject[] {
  const projects = new Map<string, KnownProject & { slugSet: Set<string> }>();

  for (const session of sessions) {
    const identity = resolveWtsProjectIdentity(session.projectDir, options);
    if (!identity.canonicalDir) {
      continue;
    }
    let project = projects.get(identity.key);
    if (!project) {
      project = {
        dir: identity.canonicalDir,
        label: identity.label,
        slugs: [],
        slugSet: new Set<string>(),
      };
      projects.set(identity.key, project);
    }
    if (identity.worktreeSlug) {
      project.slugSet.add(identity.worktreeSlug);
    }
  }

  return [...projects.values()].map((project) => ({
    dir: project.dir,
    label: project.label,
    slugs: [...project.slugSet].sort(),
  }));
}

export function defaultNewSessionProjectDir(
  selectedSession: SessionMeta | null | undefined,
  sessions: SessionMeta[],
  options?: ProjectIdentityOptions,
): string {
  const selected = resolveWtsProjectIdentity(
    selectedSession?.projectDir,
    options,
  );
  if (selected.canonicalDir) {
    return selected.canonicalDir;
  }
  return collectKnownProjects(sessions, options)[0]?.dir ?? "";
}

export function defaultNewSessionProvider(
  providerFilter: string,
  selectedSession: SessionMeta | null | undefined,
): NewSessionProvider {
  if (isNewSessionProvider(providerFilter)) {
    return providerFilter;
  }
  if (selectedSession && isNewSessionProvider(selectedSession.providerId)) {
    return selectedSession.providerId;
  }
  return "claude";
}

export function mergeWorkspaceSlugs(
  fromSessions: string[],
  fromDisk: WtsWorkspace[],
): WtsWorkspace[] {
  const merged = new Map<string, WtsWorkspace>();
  for (const workspace of fromDisk) {
    const slug = normalizeWorkspaceSlug(workspace.slug);
    if (slug && slug !== MAIN_WORKSPACE) {
      merged.set(slug, { slug, path: workspace.path });
    }
  }
  for (const slug of fromSessions) {
    const normalized = normalizeWorkspaceSlug(slug);
    if (
      normalized &&
      normalized !== MAIN_WORKSPACE &&
      !merged.has(normalized)
    ) {
      merged.set(normalized, { slug: normalized, path: "" });
    }
  }
  return [...merged.values()].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function newSessionCommand(
  providerId: NewSessionProvider,
  workspacePath: string,
): string {
  switch (providerId) {
    case "cursor":
      return `agent --workspace ${shellSingleQuote(workspacePath)} --trust`;
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    case "grokbuild":
      return "grok";
    case "opencode":
      return "opencode";
    case "pi":
      return "pi";
  }
}

export function canUseNamedWorkspace(isGitRepo: boolean | null): boolean {
  return isGitRepo === true;
}

export function buildNewSessionLaunch(input: {
  providerId: string;
  projectDir: string;
  workspace: string;
  knownWorkspaces?: WtsWorkspace[];
  isGitRepo?: boolean | null;
}): NewSessionLaunch {
  const projectDir = input.projectDir.trim();
  if (!projectDir) {
    return { error: "invalid-project" };
  }
  if (!isNewSessionProvider(input.providerId)) {
    return { error: "invalid-workspace" };
  }

  const workspace = normalizeWorkspaceSlug(input.workspace || MAIN_WORKSPACE);
  if (!workspace) {
    return { error: "invalid-workspace" };
  }

  if (workspace === MAIN_WORKSPACE) {
    return {
      command: newSessionCommand(input.providerId, projectDir),
      cwd: projectDir,
    };
  }

  if (!canUseNamedWorkspace(input.isGitRepo ?? null)) {
    return { error: "requires-git" };
  }

  const runtime = WTS_RUNTIME[input.providerId];
  if (runtime) {
    return {
      command: `WTS_HERE=1 wts --repo ${shellSingleQuote(projectDir)} ${workspace} ${runtime}`,
      cwd: projectDir,
    };
  }

  const existing = (input.knownWorkspaces ?? []).find(
    (item) => item.slug === workspace && item.path,
  );
  if (existing) {
    return {
      command: newSessionCommand(input.providerId, existing.path),
      cwd: existing.path,
    };
  }

  return { error: "create-requires-wts" };
}

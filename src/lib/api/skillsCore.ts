import { invoke } from "@tauri-apps/api/core";

export const SKILLS_CORE_AGENTS = [
  "claude-cursor",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "hermes",
  "pi",
  "antigravity",
] as const;

export type SkillsCoreAgent = (typeof SKILLS_CORE_AGENTS)[number];

export interface SkillsCoreCatalogRef {
  repo: string;
  revision: string;
}

export interface SkillsCoreLibrarySkill {
  name: string;
  provenance: "catalog-managed" | "local-draft" | string;
  behind_catalog: boolean;
}

export interface SkillsCoreProjection {
  agent: string;
  aligned: boolean;
  skill_count: number;
  description_chars: number;
}

export interface SkillsCoreDoctor {
  schema: number;
  open: boolean;
  follow_catalog: boolean;
  catalog_ref: SkillsCoreCatalogRef;
  in_use_agents: string[];
  library: SkillsCoreLibrarySkill[];
  projections: SkillsCoreProjection[];
  foreign: string[];
  broken: string[];
  duplicate: string[];
  legacy_writers_stopped: string[];
  reload: string[];
}

export interface SkillsCoreCandidate {
  name: string;
  provenance: string;
}

export interface SkillsCoreConflict {
  name: string;
}

export interface SkillsCorePreview {
  candidates: SkillsCoreCandidate[];
  conflicts: SkillsCoreConflict[];
}

export const skillsCoreApi = {
  previewOpen(agents: string[]): Promise<SkillsCorePreview> {
    return invoke("skills_core_preview_open", { agents });
  },
  open(agents: string[], skills: string[]): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_open", { agents, skills });
  },
  doctor(): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_doctor");
  },
  install(names: string[]): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_install", { names });
  },
  uninstall(names: string[]): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_uninstall", { names });
  },
  importPaths(paths: string[]): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_import", { paths });
  },
  sync(check = false): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_sync", { check });
  },
  upgrade(name?: string): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_upgrade", { name: name ?? null });
  },
  followCatalog(on: boolean): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_follow_catalog", { on });
  },
  agentsAdd(token: string): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_agents_add", { token });
  },
  agentsRemove(token: string): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_agents_remove", { token });
  },
  saveLocalDraft(name: string, body: string): Promise<SkillsCoreDoctor> {
    return invoke("skills_core_save_local_draft", { name, body });
  },
};

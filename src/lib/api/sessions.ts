import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ContentRef,
  ImageRef,
  SessionMessage,
  SessionMeta,
  TranscriptChunk,
} from "@/types";

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

export type SessionPtySpawnResult =
  | { action: "launched"; ptyId: string }
  | { action: "focused"; app: string }
  | { action: "occupied"; holder: string };

export type SessionResumeAppearance = "resume" | "return" | "returnToCodeG";

export interface SessionResumeState {
  appearance: SessionResumeAppearance;
}

export interface WtsWorkspace {
  slug: string;
  path: string;
}

export interface WtsProjectContext {
  isGitRepo: boolean;
  workspaces: WtsWorkspace[];
}

export interface SessionLiveState {
  providerId: string;
  sessionId: string;
  isLive: boolean;
}

export interface SessionLiveProbe {
  providerId: string;
  sessionId: string;
  sourcePath?: string | null;
}

export interface CursorPruneResult {
  bucketsRemoved: number;
  staleChatsRemoved: number;
  orphanDirsRemoved: number;
  bucketsRetained: number;
  scannableChatsRetained: number;
}

export interface WtsWorktreePruneResult {
  removed: number;
  gitRemoved: number;
  retained: number;
  skippedDirty: number;
}

export interface SessionStoragePruneResult {
  cursor: CursorPruneResult;
  claudePartitionsRemoved: number;
  codexEmptyDirsRemoved: number;
  geminiPartitionsRemoved: number;
  grokPartitionsRemoved: number;
  cursorDesktopWorkspacesRemoved: number;
  cursorDesktopWorkspacesRetained: number;
  wtsWorktrees: WtsWorktreePruneResult;
}

export interface WtsRegisteredWorktreeAssessment {
  path: string;
  repoPath: string;
  slug: string;
  branch?: string | null;
  sessionCount: number;
  merged: boolean;
  clean: boolean;
  removable: boolean;
  skipReason?: string | null;
}

export interface ClassifyStaleRegisteredWtsResult {
  removable: WtsRegisteredWorktreeAssessment[];
  skipped: WtsRegisteredWorktreeAssessment[];
}

export interface RemoveStaleRegisteredWtsResult {
  removed: number;
  failed: Array<{ path: string; error: string }>;
}

/** get_session_block_content 的返回：按字符分页取工具输出 / 参数 / 思考 / diff 全文 */
export interface BlockContent {
  text: string;
  /** 全文字符数 */
  totalLen: number;
  /** 本页之后还有内容 */
  truncated: boolean;
  /** 下一页的起始字符偏移 */
  nextOffset?: number;
}

export interface BlockContentPage {
  offset?: number;
  limit?: number;
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async listWtsWorkspaces(projectDir: string): Promise<WtsProjectContext> {
    return await invoke("list_wts_workspaces", { projectDir });
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

  async classifyLiveStates(
    items: SessionLiveProbe[],
  ): Promise<SessionLiveState[]> {
    return await invoke("classify_session_live_states", { items });
  },

  async pruneSessionStorage(): Promise<SessionStoragePruneResult> {
    return await invoke("prune_session_storage");
  },

  async classifyStaleRegisteredWtsWorktrees(): Promise<ClassifyStaleRegisteredWtsResult> {
    return await invoke("classify_stale_registered_wts_worktrees");
  },

  async removeStaleRegisteredWtsWorktrees(
    paths: string[],
  ): Promise<RemoveStaleRegisteredWtsResult> {
    return await invoke("remove_stale_registered_wts_worktrees", { paths });
  },

  /**
   * 分块读取会话（stream_session_messages）：后端先推 Header，再按批推 Messages，
   * 最后 Done；失败时先推 Error 再以同一文案 reject。
   */
  async streamMessages(
    providerId: string,
    sourcePath: string,
    onChunk: (chunk: TranscriptChunk) => void,
  ): Promise<void> {
    const channel = new Channel<TranscriptChunk>();
    channel.onmessage = onChunk;
    await invoke("stream_session_messages", {
      providerId,
      sourcePath,
      onChunk: channel,
    });
  },

  /** 按 ContentRef 取全文（引用原样回传，前端不解析）；按字符分页，每页最多 512K 字符 */
  async getBlockContent(
    providerId: string,
    sourcePath: string,
    contentRef: ContentRef,
    page: BlockContentPage = {},
  ): Promise<BlockContent> {
    return await invoke("get_session_block_content", {
      providerId,
      sourcePath,
      contentRef,
      offset: page.offset,
      limit: page.limit,
    });
  },

  /** 取图片原始字节（后端返回 tauri::ipc::Response），调用方按 mediaType 转 Blob；SVG 会被后端拒绝 */
  async getImage(
    providerId: string,
    sourcePath: string,
    image: ImageRef,
  ): Promise<ArrayBuffer> {
    return await invoke("get_session_image", {
      providerId,
      sourcePath,
      image,
    });
  },

  /** 在 Finder / 文件管理器中显示本地路径（绝对路径或 file://，决策 D3） */
  async revealPath(path: string): Promise<boolean> {
    return await invoke("reveal_session_path", { path });
  },

  /** 弹出保存对话框把会话存成 Markdown 文件；取消时返回 null，成功返回保存路径 */
  async exportMarkdown(
    defaultName: string,
    content: string,
  ): Promise<string | null> {
    return await invoke("export_session_markdown", { defaultName, content });
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
    terminal?: string | null;
  }): Promise<ResumeLaunchResult> {
    const {
      command,
      cwd,
      customConfig,
      sessionId,
      providerId,
      sourcePath,
      terminal,
    } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
      sessionId,
      providerId,
      sourcePath,
      terminal,
    });
  },

  async spawnPty(options: {
    command: string;
    cwd?: string | null;
    cols?: number;
    rows?: number;
    sessionId?: string | null;
    providerId?: string | null;
    sourcePath?: string | null;
  }): Promise<SessionPtySpawnResult> {
    const { command, cwd, cols, rows, sessionId, providerId, sourcePath } =
      options;
    return await invoke("spawn_session_pty", {
      command,
      cwd,
      cols,
      rows,
      sessionId,
      providerId,
      sourcePath,
    });
  },

  async ptyWrite(ptyId: string, data: string): Promise<void> {
    return await invoke("session_pty_write", { ptyId, data });
  },

  async ptyResize(ptyId: string, cols: number, rows: number): Promise<void> {
    return await invoke("session_pty_resize", { ptyId, cols, rows });
  },

  async ptyKill(ptyId: string): Promise<void> {
    return await invoke("session_pty_kill", { ptyId });
  },
};

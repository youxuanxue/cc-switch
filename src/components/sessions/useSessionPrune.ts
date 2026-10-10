import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import { sessionsApi } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  STALE_CLEANUP_DEFAULT_DAYS,
  normalizeStaleCleanupDays,
} from "./sessionCapabilities";

export const SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY =
  "cc-switch.sessionManager.staleCleanupDays";

const readStaleCleanupDays = (): number => {
  try {
    const stored = Number(
      window.localStorage.getItem(SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY),
    );
    return normalizeStaleCleanupDays(stored) ?? STALE_CLEANUP_DEFAULT_DAYS;
  } catch {
    return STALE_CLEANUP_DEFAULT_DAYS;
  }
};

/**
 * Stale-session / WTS / empty-bucket prune dialogs and prune API.
 * Kept out of SessionManagerPage so upstream reader-shell edits collide less.
 */
export function useSessionPrune() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [staleCleanupOpen, setStaleCleanupOpen] = useState(false);
  const [wtsCleanupOpen, setWtsCleanupOpen] = useState(false);
  const [staleCleanupDays, setStaleCleanupDays] =
    useState(readStaleCleanupDays);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY,
        String(staleCleanupDays),
      );
    } catch {
      // ignore
    }
  }, [staleCleanupDays]);

  const pruneEmptyCursorBuckets = async () => {
    try {
      const result = await sessionsApi.pruneSessionStorage();
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      const total =
        result.cursor.bucketsRemoved +
        result.cursor.staleChatsRemoved +
        result.cursor.orphanDirsRemoved +
        result.claudePartitionsRemoved +
        result.codexEmptyDirsRemoved +
        result.geminiPartitionsRemoved +
        result.grokPartitionsRemoved +
        result.cursorDesktopWorkspacesRemoved +
        result.wtsWorktrees.removed +
        result.wtsWorktrees.gitRemoved;
      if (total === 0) {
        if (
          result.cursor.bucketsRetained > 0 ||
          result.cursor.scannableChatsRetained > 0 ||
          result.cursorDesktopWorkspacesRetained > 0 ||
          result.wtsWorktrees.retained > 0
        ) {
          toast.success(
            t("sessionManager.pruneSessionStorageRetained", {
              defaultValue:
                "未发现可清理的空目录。Cursor 仍有 {{cursorBuckets}} 个 Agent CLI 分区 / {{cursorChats}} 个有效会话；Cursor Desktop 仍保留 {{desktopWorkspaces}} 个工作区元数据；git 仍注册 {{wtsWorktrees}} 个 WTS worktree。若要删除会话本身，请使用「全部未活跃」。",
              cursorBuckets: result.cursor.bucketsRetained,
              cursorChats: result.cursor.scannableChatsRetained,
              desktopWorkspaces: result.cursorDesktopWorkspacesRetained,
              wtsWorktrees: result.wtsWorktrees.retained,
            }),
          );
          return;
        }
        toast.success(
          t("sessionManager.pruneSessionStorageNone", {
            defaultValue: "没有可清理的空会话目录",
          }),
        );
        return;
      }
      toast.success(
        t("sessionManager.pruneSessionStorageSuccess", {
          defaultValue:
            "已清理 Cursor {{cursorBuckets}} 分区 / {{cursorStale}} 无效会话 / {{cursorOrphans}} 孤儿目录，Claude {{claude}}，Codex {{codex}}，Gemini {{gemini}}，Grok {{grok}}，Cursor Desktop {{desktop}} 个工作区元数据，WTS worktree {{wtsRemoved}}（git 移除 {{wtsGitRemoved}}）",
          cursorBuckets: result.cursor.bucketsRemoved,
          cursorStale: result.cursor.staleChatsRemoved,
          cursorOrphans: result.cursor.orphanDirsRemoved,
          claude: result.claudePartitionsRemoved,
          codex: result.codexEmptyDirsRemoved,
          gemini: result.geminiPartitionsRemoved,
          grok: result.grokPartitionsRemoved,
          desktop: result.cursorDesktopWorkspacesRemoved,
          wtsRemoved: result.wtsWorktrees.removed,
          wtsGitRemoved: result.wtsWorktrees.gitRemoved,
        }),
      );
      if (result.wtsWorktrees.skippedDirty > 0) {
        toast.message(
          t("sessionManager.pruneWtsWorktreesSkippedDirty", {
            defaultValue:
              "跳过 {{count}} 个含未提交改动的 WTS worktree，未删除。",
            count: result.wtsWorktrees.skippedDirty,
          }),
        );
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.pruneSessionStorageFailed", {
            defaultValue: "清理空会话目录失败",
          }),
      );
    }
  };

  const onWtsCleanupCompleted = async (removed: number) => {
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    toast.success(
      t("sessionManager.wtsCleanupSuccess", {
        defaultValue: "已移除 {{count}} 个旧 WTS worktree",
        count: removed,
      }),
    );
  };

  return {
    staleCleanupOpen,
    setStaleCleanupOpen,
    wtsCleanupOpen,
    setWtsCleanupOpen,
    staleCleanupDays,
    setStaleCleanupDays,
    openStaleCleanup: () => setStaleCleanupOpen(true),
    pruneEmptyCursorBuckets,
    onWtsCleanupCompleted,
  };
}

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  sessionsApi,
  type WtsRegisteredWorktreeAssessment,
} from "@/lib/api/sessions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function summarizeRemovable(items: WtsRegisteredWorktreeAssessment[]) {
  let noSessions = 0;
  let merged = 0;
  for (const item of items) {
    if (item.sessionCount === 0) {
      noSessions += 1;
    }
    if (item.merged) {
      merged += 1;
    }
  }
  return { noSessions, merged };
}

function summarizeSkipped(items: WtsRegisteredWorktreeAssessment[]) {
  let dirty = 0;
  let hasSessions = 0;
  for (const item of items) {
    if (item.skipReason === "dirty") {
      dirty += 1;
    } else if (item.skipReason === "has_sessions") {
      hasSessions += 1;
    }
  }
  return { dirty, hasSessions };
}

export function StaleWtsWorktreeCleanupDialog({
  open,
  onOpenChange,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted?: (removed: number) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [removable, setRemovable] = useState<WtsRegisteredWorktreeAssessment[]>(
    [],
  );
  const [skipped, setSkipped] = useState<WtsRegisteredWorktreeAssessment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeProgress, setRemoveProgress] = useState<{
    done: number;
    total: number;
    current?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setRemovable([]);
    setSkipped([]);
    setRemoveProgress(null);

    void sessionsApi
      .classifyStaleRegisteredWtsWorktrees()
      .then((result) => {
        if (cancelled) {
          return;
        }
        setRemovable(result.removable);
        setSkipped(result.skipped);
      })
      .catch((caught: unknown) => {
        if (cancelled) {
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const removableSummary = useMemo(
    () => summarizeRemovable(removable),
    [removable],
  );
  const skippedSummary = useMemo(() => summarizeSkipped(skipped), [skipped]);

  const previewMessage = (() => {
    if (isLoading) {
      return t("sessionManager.wtsCleanupLoading", {
        defaultValue: "正在扫描 ~/Codes 下的 WTS worktree…",
      });
    }
    if (isRemoving && removeProgress) {
      return t("sessionManager.wtsCleanupRemoving", {
        defaultValue: "正在移除 {{done}}/{{total}}：{{current}}",
        done: removeProgress.done,
        total: removeProgress.total,
        current: removeProgress.current ?? "…",
      });
    }
    if (error) {
      return t("sessionManager.wtsCleanupFailed", {
        defaultValue: "操作失败：{{error}}",
        error,
      });
    }
    if (removable.length === 0) {
      return t("sessionManager.wtsCleanupEmpty", {
        defaultValue:
          "没有可移除的旧 worktree。仍注册且含未合并会话的 worktree 会被跳过。",
      });
    }
    return t("sessionManager.wtsCleanupPreview", {
      defaultValue:
        "将移除 {{count}} 个 git 注册的 WTS worktree（{{noSessions}} 个无会话，{{merged}} 个已合并进 main/master）。跳过 {{skippedDirty}} 个脏目录、{{skippedSessions}} 个仍有关联会话且未合并。大仓库删除可能需要几分钟，请等待进度更新。",
      count: removable.length,
      noSessions: removableSummary.noSessions,
      merged: removableSummary.merged,
      skippedDirty: skippedSummary.dirty,
      skippedSessions: skippedSummary.hasSessions,
    });
  })();

  const handleConfirm = async () => {
    if (removable.length === 0 || isRemoving) {
      return;
    }
    setIsRemoving(true);
    setError(null);
    const total = removable.length;
    let removed = 0;
    const failures: string[] = [];

    try {
      for (let index = 0; index < removable.length; index += 1) {
        const item = removable[index];
        setRemoveProgress({
          done: index,
          total,
          current: item.slug || item.path,
        });
        const result = await sessionsApi.removeStaleRegisteredWtsWorktrees([
          item.path,
        ]);
        removed += result.removed;
        for (const failure of result.failed) {
          failures.push(`${failure.path}: ${failure.error}`);
        }
        setRemoveProgress({
          done: index + 1,
          total,
          current: item.slug || item.path,
        });
      }

      if (failures.length > 0) {
        setError(failures.join("\n"));
        if (removed > 0) {
          await onCompleted?.(removed);
        }
        return;
      }
      onOpenChange(false);
      await onCompleted?.(removed);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRemoving(false);
      setRemoveProgress(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isRemoving) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("sessionManager.wtsCleanupTitle", {
              defaultValue: "清理旧 WTS worktree",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionManager.wtsCleanupDescription", {
              defaultValue:
                "移除 ~/Codes/*-wt-* 中仍被 git 注册、但已无会话或分支已合并进 main/master 的 worktree。含未提交改动，或仍有关联会话且未合并的 worktree 会被跳过。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4">
          <p
            className={`text-sm ${
              error ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {previewMessage}
          </p>
        </div>
        <DialogFooter className="flex w-full justify-end gap-2">
          <Button
            variant="outline"
            disabled={isRemoving}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button
            variant="destructive"
            disabled={
              isLoading || isRemoving || !!error || removable.length === 0
            }
            onClick={() => void handleConfirm()}
          >
            {isRemoving
              ? t("sessionManager.wtsCleanupRemovingShort", {
                  defaultValue: "移除中…",
                })
              : t("sessionManager.wtsCleanupConfirm", {
                  defaultValue: "移除 worktree",
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMeta } from "@/types";
import { sessionsApi } from "@/lib/api/sessions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  excludeLiveSessions,
  normalizeStaleCleanupDays,
  sessionLiveProbeSourcePath,
  summarizeCleanupCandidates,
  type SessionCleanupMode,
} from "./sessionCapabilities";

function parseDaysInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return normalizeStaleCleanupDays(Number(trimmed));
}

export function StaleSessionCleanupDialog({
  open,
  onOpenChange,
  sessions,
  initialDays,
  now,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionMeta[];
  initialDays: number;
  now?: number;
  onConfirm: (
    targets: SessionMeta[],
    mode: SessionCleanupMode,
    days: number,
  ) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SessionCleanupMode>("stale");
  const [daysInput, setDaysInput] = useState(String(initialDays));
  const [liveKeys, setLiveKeys] = useState<Set<string>>(new Set());
  const [isProbingLive, setIsProbingLive] = useState(false);
  const [liveProbeError, setLiveProbeError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode("stale");
      setDaysInput(String(initialDays));
      setLiveKeys(new Set());
      setLiveProbeError(null);
      setIsProbingLive(false);
    }
  }, [open, initialDays]);

  const normalizedDays = parseDaysInput(daysInput);
  const candidateSummary = useMemo(() => {
    if (mode === "stale" && normalizedDays === null) {
      return { candidates: [] as SessionMeta[], skippedNotDeletable: 0 };
    }
    return summarizeCleanupCandidates(
      sessions,
      mode,
      normalizedDays ?? initialDays,
      now,
    );
  }, [initialDays, mode, normalizedDays, now, sessions]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const { candidates } = candidateSummary;
    if (candidates.length === 0) {
      setLiveKeys(new Set());
      setLiveProbeError(null);
      setIsProbingLive(false);
      return;
    }

    let cancelled = false;
    setIsProbingLive(true);
    setLiveProbeError(null);

    void sessionsApi
      .classifyLiveStates(
        candidates.map((session) => ({
          providerId: session.providerId,
          sessionId: session.sessionId,
          sourcePath: sessionLiveProbeSourcePath(session) ?? null,
        })),
      )
      .then((results) => {
        if (cancelled) {
          return;
        }
        const nextLiveKeys = new Set<string>();
        for (const result of results) {
          if (result.isLive) {
            nextLiveKeys.add(`${result.providerId}:${result.sessionId}`);
          }
        }
        setLiveKeys(nextLiveKeys);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setLiveKeys(new Set());
        setLiveProbeError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsProbingLive(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [candidateSummary, open]);

  const { targets, skippedLive } = useMemo(
    () => excludeLiveSessions(candidateSummary.candidates, liveKeys),
    [candidateSummary.candidates, liveKeys],
  );
  const skippedNotDeletable = candidateSummary.skippedNotDeletable;
  const canConfirm =
    !isProbingLive &&
    !liveProbeError &&
    targets.length > 0 &&
    (mode === "inactive" || normalizedDays !== null);
  const hasCursorSessions = sessions.some(
    (session) => session.providerId === "cursor",
  );

  const previewMessage = (() => {
    if (mode === "stale" && normalizedDays === null) {
      return t("sessionManager.staleCleanupInvalidDays", {
        defaultValue: "请输入 1 到 3650 之间的整数。",
      });
    }
    if (isProbingLive) {
      return t("sessionManager.cleanupProbingLive", {
        defaultValue: "正在检测活跃会话…",
      });
    }
    if (liveProbeError) {
      return t("sessionManager.cleanupLiveProbeFailed", {
        defaultValue: "无法检测活跃会话：{{error}}",
        error: liveProbeError,
      });
    }
    if (targets.length === 0) {
      return t("sessionManager.staleCleanupEmpty", {
        defaultValue: "没有符合条件的可删会话。",
      });
    }
    return mode === "inactive"
      ? t("sessionManager.inactiveCleanupPreview", {
          defaultValue:
            "将删除 {{count}} 个未活跃会话，跳过 {{skipped}} 个不可删，{{skippedLive}} 个仍活跃。",
          count: targets.length,
          skipped: skippedNotDeletable,
          skippedLive,
        })
      : t("sessionManager.staleCleanupPreviewWithLive", {
          defaultValue:
            "将删除 {{count}} 个会话，跳过 {{skipped}} 个不可删，{{skippedLive}} 个仍活跃。",
          count: targets.length,
          skipped: skippedNotDeletable,
          skippedLive,
        });
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("sessionManager.cleanupTitle", {
              defaultValue: "清理会话",
            })}
          </DialogTitle>
          <DialogDescription>
            {mode === "inactive"
              ? t("sessionManager.inactiveCleanupDescription", {
                  defaultValue:
                    "删除当前列表里所有未在运行的可删会话。仍活跃的会话会被自动跳过。",
                })
              : t("sessionManager.staleCleanupDescription", {
                  defaultValue:
                    "删除当前列表里超过指定天数未活跃的可删会话。仍活跃的会话会被自动跳过。",
                })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4">
          <Tabs
            value={mode}
            onValueChange={(value) => setMode(value as SessionCleanupMode)}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="stale">
                {t("sessionManager.cleanupModeStale", {
                  defaultValue: "按天数",
                })}
              </TabsTrigger>
              <TabsTrigger value="inactive">
                {t("sessionManager.cleanupModeInactive", {
                  defaultValue: "全部未活跃",
                })}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "stale" ? (
            <div className="space-y-2">
              <Label htmlFor="stale-cleanup-days">
                {t("sessionManager.staleCleanupDaysLabel", {
                  defaultValue: "未活跃天数",
                })}
              </Label>
              <Input
                id="stale-cleanup-days"
                type="number"
                min={1}
                max={3650}
                inputMode="numeric"
                value={daysInput}
                onChange={(event) => setDaysInput(event.target.value)}
              />
            </div>
          ) : null}
          <p
            className={`text-sm ${
              mode === "stale" && normalizedDays === null
                ? "text-destructive"
                : liveProbeError
                  ? "text-destructive"
                  : "text-muted-foreground"
            }`}
          >
            {previewMessage}
          </p>
          {hasCursorSessions ? (
            <p className="text-sm text-muted-foreground">
              {t("sessionManager.staleCleanupCursorHint", {
                defaultValue:
                  "将删除 Cursor Agent CLI 的本地会话目录（~/.cursor/chats/…），不会动 Cursor Desktop 的聊天库，也不会删除工作区。",
              })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm}
            onClick={() => {
              if (!canConfirm) {
                return;
              }
              onConfirm(
                targets,
                mode,
                mode === "stale" ? (normalizedDays as number) : initialDays,
              );
            }}
          >
            {t("sessionManager.staleCleanupConfirm", {
              defaultValue: "继续删除",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

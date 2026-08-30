import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMeta } from "@/types";
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
import {
  normalizeStaleCleanupDays,
  summarizeStaleCleanup,
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
  onConfirm: (targets: SessionMeta[], days: number) => void;
}) {
  const { t } = useTranslation();
  const [daysInput, setDaysInput] = useState(String(initialDays));

  useEffect(() => {
    if (open) {
      setDaysInput(String(initialDays));
    }
  }, [open, initialDays]);

  const normalizedDays = parseDaysInput(daysInput);
  const summary = useMemo(
    () =>
      normalizedDays === null
        ? { targets: [] as SessionMeta[], skipped: 0 }
        : summarizeStaleCleanup(sessions, normalizedDays, now),
    [normalizedDays, now, sessions],
  );
  const canConfirm = normalizedDays !== null && summary.targets.length > 0;
  const hasCursorSessions = sessions.some(
    (session) => session.providerId === "cursor",
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("sessionManager.staleCleanupTitle", {
              defaultValue: "清理闲置会话",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionManager.staleCleanupDescription", {
              defaultValue:
                "删除当前列表里超过指定天数未活跃的可删会话。不会删除工作区目录。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4">
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
          {normalizedDays === null ? (
            <p className="text-sm text-destructive">
              {t("sessionManager.staleCleanupInvalidDays", {
                defaultValue: "请输入 1 到 3650 之间的整数。",
              })}
            </p>
          ) : summary.targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("sessionManager.staleCleanupEmpty", {
                defaultValue: "没有符合条件的可删会话。",
              })}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("sessionManager.staleCleanupPreview", {
                defaultValue:
                  "将删除 {{count}} 个会话，跳过 {{skipped}} 个不可删。",
                count: summary.targets.length,
                skipped: summary.skipped,
              })}
            </p>
          )}
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
              if (!canConfirm || normalizedDays === null) {
                return;
              }
              onConfirm(summary.targets, normalizedDays);
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

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useTranslation } from "react-i18next";
import { TerminalSquare } from "lucide-react";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { sessionsApi } from "@/lib/api";
import { extractErrorMessage } from "@/utils/errorUtils";

export interface LiveTerminalPaneProps {
  /** Whether the terminal tab is currently visible. */
  active: boolean;
  /** Spawn the agent in a new PTY. Must not use generic terminal for Cursor. */
  onSpawn: (size: {
    cols: number;
    rows: number;
  }) => Promise<
    | { kind: "launched"; ptyId: string }
    | { kind: "focused"; app: string }
    | { kind: "occupied"; holder: string }
    | { kind: "workspaceRequired" }
    | { kind: "unavailable"; reason: string }
  >;
  /** Called when spawn is refused because the session is already live elsewhere. */
  onBlocked?: () => void;
  sessionKey: string;
}

export function LiveTerminalPane({
  active,
  onSpawn,
  onBlocked,
  sessionKey,
}: LiveTerminalPaneProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [spawning, setSpawning] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "exited">("idle");

  useTauriEvent<{ ptyId: string; data: string }>(
    "session-pty-output",
    (payload) => {
      if (!payload || payload.ptyId !== ptyIdRef.current) return;
      termRef.current?.write(payload.data);
    },
  );

  useTauriEvent<{ ptyId: string; code?: number | null }>(
    "session-pty-exit",
    (payload) => {
      if (!payload || payload.ptyId !== ptyIdRef.current) return;
      setStatus("exited");
      ptyIdRef.current = null;
      setPtyId(null);
    },
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || termRef.current) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      theme: {
        background: "#0f1115",
        foreground: "#e6e8ec",
        cursor: "#e6e8ec",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dataDisp = term.onData((data) => {
      const id = ptyIdRef.current;
      if (!id) return;
      void sessionsApi.ptyWrite(id, data).catch(() => undefined);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.clientWidth === 0) return;
      fit.fit();
      const id = ptyIdRef.current;
      if (!id) return;
      void sessionsApi
        .ptyResize(id, term.cols, term.rows)
        .catch(() => undefined);
    });
    resizeObserver.observe(host);

    return () => {
      dataDisp.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    setPtyId(null);
    setStatus("idle");
    setSpawning(false);
    return () => {
      const id = ptyIdRef.current;
      if (id) {
        void sessionsApi.ptyKill(id).catch(() => undefined);
      }
      ptyIdRef.current = null;
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
      const id = ptyIdRef.current;
      if (id && termRef.current) {
        void sessionsApi
          .ptyResize(id, termRef.current.cols, termRef.current.rows)
          .catch(() => undefined);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active]);

  const handleSpawn = async () => {
    if (spawning) return;
    setSpawning(true);
    try {
      fitRef.current?.fit();
      const cols = termRef.current?.cols ?? 100;
      const rows = termRef.current?.rows ?? 28;
      const result = await onSpawn({ cols, rows });
      if (result.kind === "launched") {
        ptyIdRef.current = result.ptyId;
        setPtyId(result.ptyId);
        setStatus("running");
        termRef.current?.clear();
        termRef.current?.focus();
        toast.success(
          t("sessionManager.liveTerminalLaunched", {
            defaultValue: "站内终端已启动",
          }),
        );
        return;
      }
      if (result.kind === "focused") {
        toast.error(
          t("sessionManager.liveTerminalAlreadyLive", {
            defaultValue:
              "该会话已在 {{app}} 中打开，已切换到对应窗口，避免重复打开造成冲突",
            app: result.app,
          }),
        );
        onBlocked?.();
        return;
      }
      if (result.kind === "occupied") {
        toast.error(
          t("sessionManager.resumeOccupied", {
            defaultValue: "该会话已在 {{holder}} 中打开，请先回到那个窗口",
            holder: result.holder,
          }),
        );
        onBlocked?.();
        return;
      }
      if (result.kind === "workspaceRequired") {
        toast.error(
          t("sessionManager.liveTerminalWorkspaceRequired", {
            defaultValue: "请先选择工作区目录后再打开站内终端",
          }),
        );
        return;
      }
      toast.error(result.reason);
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.liveTerminalSpawnFailed", {
            defaultValue: "站内终端启动失败",
          }),
      );
    } finally {
      setSpawning(false);
    }
  };

  useEffect(() => {
    if (!active || ptyIdRef.current || spawning) return;
    const timer = window.setTimeout(() => {
      void handleSpawn();
    }, 0);
    return () => window.clearTimeout(timer);
    // Auto-start once when the terminal tab becomes active for a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0f1115]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <TerminalSquare className="size-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground/80">
          {status === "running"
            ? t("sessionManager.liveTerminalRunning", {
                defaultValue: "运行中",
              })
            : status === "exited"
              ? t("sessionManager.liveTerminalExited", {
                  defaultValue: "已退出",
                })
              : t("sessionManager.liveTerminalIdle", {
                  defaultValue: "未启动",
                })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!ptyId ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              disabled={spawning}
              onClick={() => void handleSpawn()}
            >
              {spawning
                ? t("sessionManager.liveTerminalSpawning", {
                    defaultValue: "启动中…",
                  })
                : t("sessionManager.liveTerminalStart", {
                    defaultValue: "启动",
                  })}
            </Button>
          ) : null}
        </div>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}

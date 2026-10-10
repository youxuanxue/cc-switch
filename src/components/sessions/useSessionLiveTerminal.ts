import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionMeta } from "@/types";
import { isMac } from "@/lib/platform";
import type { CursorResumePrimaryAction } from "./CursorResumeGate";
import {
  spawnCursorLiveTerminal,
  spawnProviderLiveTerminal,
} from "./liveTerminalSpawn";

export type ReaderPane = "transcript" | "terminal";

interface UseSessionLiveTerminalArgs {
  readerSession: SessionMeta | null | undefined;
  readerKey: string | null;
  cursorPrimaryAction: CursorResumePrimaryAction | null;
}

/**
 * In-app live terminal pane state + spawn routing (Cursor vs provider).
 * Extracted from SessionManagerPage to shrink upstream conflict surface.
 */
export function useSessionLiveTerminal({
  readerSession,
  readerKey,
  cursorPrimaryAction,
}: UseSessionLiveTerminalArgs) {
  const { t } = useTranslation();
  const [readerPane, setReaderPane] = useState<ReaderPane>("transcript");
  const [terminalVisited, setTerminalVisited] = useState(false);
  const isCursorReaderSession = readerSession?.providerId === "cursor";

  useEffect(() => {
    setReaderPane("transcript");
    setTerminalVisited(false);
  }, [readerKey]);

  const openLiveTerminalPane = useCallback(() => {
    setTerminalVisited(true);
    setReaderPane("terminal");
  }, []);

  const handleLiveTerminalSpawn = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!readerSession) {
        return {
          kind: "unavailable" as const,
          reason: t("sessionManager.liveTerminalNoSession", {
            defaultValue: "请先选择一个会话",
          }),
        };
      }
      if (!isMac()) {
        return {
          kind: "unavailable" as const,
          reason: t("sessionManager.liveTerminalMacOnly", {
            defaultValue: "站内终端目前仅支持 macOS",
          }),
        };
      }
      if (readerSession.providerId === "cursor") {
        if (!cursorPrimaryAction || cursorPrimaryAction.disabled) {
          return {
            kind: "unavailable" as const,
            reason: t("sessionManager.liveTerminalCursorNotReady", {
              defaultValue: "Cursor 会话尚未就绪，无法打开站内终端",
            }),
          };
        }
        return spawnCursorLiveTerminal({
          sessionId: readerSession.sessionId,
          cols,
          rows,
        });
      }
      if (!readerSession.resumeCommand) {
        return {
          kind: "unavailable" as const,
          reason: t("sessionManager.noResumeCommand", {
            defaultValue: "此会话无法恢复",
          }),
        };
      }
      const result = await spawnProviderLiveTerminal({
        session: readerSession,
        cols,
        rows,
      });
      if (result.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          reason: t("sessionManager.noResumeCommand", {
            defaultValue: "此会话无法恢复",
          }),
        };
      }
      return result;
    },
    [cursorPrimaryAction, readerSession, t],
  );

  const liveTerminalEnabled = Boolean(
    readerSession &&
      isMac() &&
      (isCursorReaderSession
        ? cursorPrimaryAction && !cursorPrimaryAction.disabled
        : readerSession.resumeCommand),
  );

  return {
    readerPane,
    setReaderPane,
    terminalVisited,
    openLiveTerminalPane,
    handleLiveTerminalSpawn,
    liveTerminalEnabled,
  };
}

import { useEffect, useMemo, useState } from "react";
import { useCursorSessionIndex } from "@/hooks/useCursorSessionIndex";
import { extractErrorMessage } from "@/utils/errorUtils";
import type { CursorResumePrimaryAction } from "./CursorResumeGate";

type AppFilter = string;

interface UseSessionCursorArgs {
  providerFilter: AppFilter;
  readerKey: string | null;
}

/**
 * Cursor index diagnostics + reader resume chrome state.
 * Owns useCursorSessionIndex(providerFilter === "cursor") for SSOT.
 */
export function useSessionCursor({
  providerFilter,
  readerKey,
}: UseSessionCursorArgs) {
  const cursorSessionIndex = useCursorSessionIndex(providerFilter === "cursor");
  const [cursorPrimaryAction, setCursorPrimaryAction] =
    useState<CursorResumePrimaryAction | null>(null);
  const [cursorResumeCommand, setCursorResumeCommand] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setCursorPrimaryAction(null);
    setCursorResumeCommand(null);
  }, [readerKey]);

  const cursorIndexUnavailableReason = useMemo(() => {
    if (providerFilter !== "cursor") return null;
    if (cursorSessionIndex.status?.state === "indexUnavailable") {
      return cursorSessionIndex.status.reason;
    }
    if (cursorSessionIndex.isError) {
      return extractErrorMessage(cursorSessionIndex.error);
    }
    return null;
  }, [
    cursorSessionIndex.error,
    cursorSessionIndex.isError,
    cursorSessionIndex.status,
    providerFilter,
  ]);

  const refreshCursorIndex = async () => {
    if (providerFilter === "cursor") {
      await cursorSessionIndex.refresh();
    }
  };

  return {
    cursorPrimaryAction,
    setCursorPrimaryAction,
    cursorResumeCommand,
    setCursorResumeCommand,
    cursorIndexUnavailableReason,
    refreshCursorIndex,
  };
}

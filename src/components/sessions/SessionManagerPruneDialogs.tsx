import type { SessionMeta } from "@/types";
import type { SessionCleanupMode } from "./sessionCapabilities";
import { StaleSessionCleanupDialog } from "./StaleSessionCleanupDialog";
import { StaleWtsWorktreeCleanupDialog } from "./StaleWtsWorktreeCleanupDialog";

interface SessionManagerPruneDialogsProps {
  sessions: SessionMeta[];
  staleCleanupOpen: boolean;
  onStaleCleanupOpenChange: (open: boolean) => void;
  wtsCleanupOpen: boolean;
  onWtsCleanupOpenChange: (open: boolean) => void;
  staleCleanupDays: number;
  onConfirmDelete: (
    targets: SessionMeta[],
    mode: SessionCleanupMode,
    days: number,
  ) => void;
  onPruneEmptyCursorBuckets: () => void | Promise<void>;
  onOpenWtsCleanup: () => void;
  onWtsCleanupCompleted: (removed: number) => void | Promise<void>;
}

/** Fork prune dialogs — keep out of SessionManagerPage orchestration. */
export function SessionManagerPruneDialogs({
  sessions,
  staleCleanupOpen,
  onStaleCleanupOpenChange,
  wtsCleanupOpen,
  onWtsCleanupOpenChange,
  staleCleanupDays,
  onConfirmDelete,
  onPruneEmptyCursorBuckets,
  onOpenWtsCleanup,
  onWtsCleanupCompleted,
}: SessionManagerPruneDialogsProps) {
  return (
    <>
      <StaleSessionCleanupDialog
        open={staleCleanupOpen}
        onOpenChange={onStaleCleanupOpenChange}
        sessions={sessions}
        initialDays={staleCleanupDays}
        onConfirm={onConfirmDelete}
        onPruneEmptyCursorBuckets={onPruneEmptyCursorBuckets}
        onCleanupStaleWtsWorktrees={onOpenWtsCleanup}
      />
      <StaleWtsWorktreeCleanupDialog
        open={wtsCleanupOpen}
        onOpenChange={onWtsCleanupOpenChange}
        onCompleted={onWtsCleanupCompleted}
      />
    </>
  );
}

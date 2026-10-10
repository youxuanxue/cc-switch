import type { ComponentProps, ReactNode } from "react";
import type { TFunction } from "i18next";
import type { SessionMeta } from "@/types";
import type { SessionResumeAppearance } from "@/lib/api/sessions";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { isMac } from "@/lib/platform";
import { CursorResumeGate } from "./CursorResumeGate";
import type { CursorResumePrimaryAction } from "./CursorResumeGate";
import { LiveTerminalPane } from "./LiveTerminalPane";
import { getSessionKey } from "./utils";
import type { ReaderPane } from "./useSessionLiveTerminal";

type LiveTerminalSpawn = NonNullable<
  ComponentProps<typeof LiveTerminalPane>["onSpawn"]
>;

export interface SessionReaderForkChromeProps {
  t: TFunction;
  session: SessionMeta;
  isCursorSession: boolean;
  resumeAppearance?: SessionResumeAppearance;
  onPrimaryActionChange: (action: CursorResumePrimaryAction | null) => void;
  onResumeCommandChange: (command: string | null) => void;
  readerPane: ReaderPane;
  setReaderPane: (pane: ReaderPane) => void;
  terminalVisited: boolean;
  liveTerminalEnabled: boolean;
  openLiveTerminalPane: () => void;
  onLiveTerminalSpawn: LiveTerminalSpawn;
}

/**
 * Fork-owned reader chrome: Cursor resume gate + in-app live terminal.
 * Kept out of SessionManagerPage so upstream reader-shell merges collide less.
 */
export function SessionReaderForkChrome({
  t,
  session,
  isCursorSession,
  resumeAppearance,
  onPrimaryActionChange,
  onResumeCommandChange,
  readerPane,
  setReaderPane,
  terminalVisited,
  liveTerminalEnabled,
  openLiveTerminalPane,
  onLiveTerminalSpawn,
}: SessionReaderForkChromeProps): {
  afterHeader?: ReactNode;
  toolbarAddon?: ReactNode;
  alternateBody?: ReactNode;
} {
  const afterHeader = isCursorSession ? (
    <div className="shrink-0 border-b border-border px-6 pb-3">
      <CursorResumeGate
        session={session}
        appearance={resumeAppearance}
        onPrimaryActionChange={onPrimaryActionChange}
        onResumeCommandChange={onResumeCommandChange}
      />
    </div>
  ) : undefined;

  const toolbarAddon = isMac() ? (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2">
      <SegmentedControl<ReaderPane>
        aria-label={t("sessionManager.readerPane", {
          defaultValue: "阅读视图",
        })}
        value={readerPane}
        onValueChange={(value) => {
          if (value === "terminal") {
            openLiveTerminalPane();
            return;
          }
          setReaderPane("transcript");
        }}
        className="h-8 shrink-0 rounded-[8px] [&>button]:rounded-[5px] [&>button]:px-3"
        items={[
          {
            value: "transcript",
            label: t("sessionManager.conversationHistory", {
              defaultValue: "对话记录",
            }),
          },
          {
            value: "terminal",
            label: t("sessionManager.liveTerminal", {
              defaultValue: "站内终端",
            }),
            disabled: !liveTerminalEnabled,
          },
        ]}
      />
    </div>
  ) : undefined;

  const alternateBody =
    readerPane === "terminal" && terminalVisited ? (
      <LiveTerminalPane
        active={readerPane === "terminal"}
        onSpawn={onLiveTerminalSpawn}
        onBlocked={() => setReaderPane("transcript")}
        sessionKey={getSessionKey(session)}
      />
    ) : undefined;

  return { afterHeader, toolbarAddon, alternateBody };
}

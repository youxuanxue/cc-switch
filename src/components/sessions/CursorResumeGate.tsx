import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AlertTriangle, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { CursorOfficialAuthControl } from "@/components/cursor/CursorOfficialAuthControl";
import { Button } from "@/components/ui/button";
import { useCursorOfficial } from "@/hooks/useCursorOfficial";
import { cursorApi, type CursorLaunchResult } from "@/lib/api/cursor";
import { settingsApi } from "@/lib/api/settings";
import { isMac } from "@/lib/platform";
import type { SessionMeta } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";
import { deriveCursorResumeState } from "./cursorResumeState";

export interface CursorResumePrimaryAction {
  label: string;
  disabled: boolean;
  onClick: () => void;
}

interface CursorResumeGateProps {
  session: SessionMeta;
  onPrimaryActionChange?: (action: CursorResumePrimaryAction | null) => void;
  onResumeCommandChange?: (command: string | null) => void;
}

interface SessionWorkspaceOverride {
  sessionId: string;
  path: string;
}

interface LaunchVariables {
  sessionId: string;
  workspaceOverride?: string;
  withLogin: boolean;
}

export function CursorResumeGate({
  session,
  onPrimaryActionChange,
  onResumeCommandChange,
}: CursorResumeGateProps) {
  const { t } = useTranslation();
  const official = useCursorOfficial();
  const [workspaceOverrideState, setWorkspaceOverrideState] =
    useState<SessionWorkspaceOverride | null>(null);
  const [
    launchWorkspaceRequiredSessionId,
    setLaunchWorkspaceRequiredSessionId,
  ] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const workspaceOverride =
    workspaceOverrideState?.sessionId === session.sessionId
      ? workspaceOverrideState.path
      : undefined;
  const launchWorkspaceRequired =
    launchWorkspaceRequiredSessionId === session.sessionId;

  useEffect(() => {
    setWorkspaceOverrideState(null);
    setLaunchWorkspaceRequiredSessionId(null);
    setActionError(null);
  }, [session.sessionId]);

  const resumeContext = useQuery({
    queryKey: ["cursor-resume-context", session.sessionId, workspaceOverride],
    queryFn: () =>
      cursorApi.getSessionResumeContext({
        sessionId: session.sessionId,
        workspaceOverride,
      }),
  });

  const launchMutation = useMutation<
    CursorLaunchResult,
    unknown,
    LaunchVariables
  >({
    mutationFn: ({ sessionId, workspaceOverride, withLogin }) => {
      const request = { sessionId, workspaceOverride };
      return withLogin
        ? cursorApi.launchLoginAndSession(request)
        : cursorApi.launchSession(request);
    },
    onMutate: () => {
      setActionError(null);
    },
    onSuccess: (result, variables) => {
      if (result.state !== "workspaceRequired") return;

      setWorkspaceOverrideState((current) =>
        current?.sessionId === variables.sessionId ? null : current,
      );
      setLaunchWorkspaceRequiredSessionId(variables.sessionId);
    },
    onError: (error) => {
      setActionError(extractErrorMessage(error));
    },
  });

  const workspaceState = launchWorkspaceRequired
    ? "required"
    : resumeContext.data?.workspaceState === "workspaceRequired"
      ? "required"
      : resumeContext.data?.workspaceState === "ready"
        ? "ready"
        : null;

  const resumeState = useMemo(() => {
    if (!isMac()) return "platformUnavailable" as const;
    if (official.status && !official.status.installed) {
      return "cliMissing" as const;
    }
    if (!official.status || !workspaceState) return null;

    return deriveCursorResumeState({
      isMac: true,
      installed: official.status.installed,
      workspaceState,
      authMode: official.status.authMode,
      authenticated: official.status.authenticated,
    });
  }, [official.status, workspaceState]);

  const resolvedWorkspace =
    workspaceOverride ??
    (resumeContext.data?.workspaceState === "ready"
      ? resumeContext.data.workspace
      : session.projectDir?.trim() || undefined);
  const commandWorkspace = resolvedWorkspace ?? "<workspace>";
  const fixedCommand = `agent --workspace ${commandWorkspace} --resume ${session.sessionId}`;

  const launch = (withLogin: boolean, override = workspaceOverride) => {
    launchMutation.mutate({
      sessionId: session.sessionId,
      workspaceOverride: override,
      withLogin,
    });
  };

  const handleChooseWorkspace = async () => {
    setActionError(null);
    try {
      const selected = await settingsApi.pickDirectory(
        workspaceOverride ?? (session.projectDir?.trim() || undefined),
      );
      if (!selected) return;

      const context = await cursorApi.getSessionResumeContext({
        sessionId: session.sessionId,
        workspaceOverride: selected,
      });
      if (context.workspaceState === "workspaceRequired") {
        setLaunchWorkspaceRequiredSessionId(session.sessionId);
        return;
      }

      const canonicalWorkspace = context.workspace;
      setWorkspaceOverrideState({
        sessionId: session.sessionId,
        path: canonicalWorkspace,
      });
      setLaunchWorkspaceRequiredSessionId(null);

      if (official.status?.authenticated) {
        launch(false, canonicalWorkspace);
      }
    } catch (error) {
      setActionError(extractErrorMessage(error));
    }
  };

  const contextError = resumeContext.isError
    ? extractErrorMessage(resumeContext.error)
    : null;
  const statusError = official.isError
    ? extractErrorMessage(official.error)
    : null;

  const primaryLabel =
    resumeState === "ready"
      ? t("sessionManager.resume", { defaultValue: "恢复会话" })
      : null;
  const primaryClickRef = useRef<() => void>(() => {});
  primaryClickRef.current = () => {
    if (resumeState === "ready") {
      launch(false);
    }
  };

  useEffect(() => {
    if (!onPrimaryActionChange) return;
    if (!primaryLabel) {
      onPrimaryActionChange(null);
      return () => onPrimaryActionChange(null);
    }
    onPrimaryActionChange({
      label: primaryLabel,
      disabled: launchMutation.isPending,
      onClick: () => primaryClickRef.current(),
    });
    return () => onPrimaryActionChange(null);
  }, [launchMutation.isPending, onPrimaryActionChange, primaryLabel]);

  useEffect(() => {
    if (!onResumeCommandChange) return;
    onResumeCommandChange(fixedCommand);
    return () => onResumeCommandChange(null);
  }, [fixedCommand, onResumeCommandChange]);

  const blocking =
    Boolean(statusError || contextError || actionError) ||
    resumeState === "platformUnavailable" ||
    resumeState === "cliMissing" ||
    resumeState === "workspaceRequired" ||
    resumeState === "needsLogin" ||
    resumeState === "needsApiKey";

  if (!blocking) {
    return null;
  }

  return (
    <div className="shrink-0 space-y-3 px-4 pb-1 min-w-0">
      {resumeState === "platformUnavailable" ? (
        <p className="text-sm text-muted-foreground">
          {t("sessionManager.cursorPlatformUnavailable", {
            defaultValue: "当前仅支持在 macOS 恢复 Cursor 会话。",
          })}
        </p>
      ) : resumeState === "cliMissing" ? (
        <p className="text-sm text-muted-foreground">
          {t("sessionManager.cursorCliMissing", {
            defaultValue:
              "未找到 Cursor Agent CLI。请先在 Cursor 中安装 Agent CLI。",
          })}
        </p>
      ) : statusError ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <p>{statusError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void official.refresh()}
          >
            <RefreshCw className="size-4" />
            {t("sessionManager.cursorRetryStatus", {
              defaultValue: "重新检查状态",
            })}
          </Button>
        </div>
      ) : contextError ? (
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
          <p>{contextError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void resumeContext.refetch()}
          >
            <RefreshCw className="size-4" />
            {t("sessionManager.cursorRetryContext", {
              defaultValue: "重新检查目录",
            })}
          </Button>
        </div>
      ) : resumeState === "workspaceRequired" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={() => void handleChooseWorkspace()}
            disabled={launchMutation.isPending}
          >
            {launchMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FolderOpen className="size-3.5" />
            )}
            {t("sessionManager.cursorChooseDirectoryAndContinue", {
              defaultValue: "选择目录并继续",
            })}
          </Button>
        </div>
      ) : resumeState === "needsLogin" || resumeState === "needsApiKey" ? (
        <CursorOfficialAuthControl
          variant="compact"
          onLogin={() => launch(true)}
          onApiKeyReady={() => launch(false)}
        />
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{actionError}</span>
        </div>
      ) : null}
    </div>
  );
}

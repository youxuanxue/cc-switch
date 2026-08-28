import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import { CursorOfficialAuthControl } from "@/components/cursor/CursorOfficialAuthControl";
import { Button } from "@/components/ui/button";
import { useCursorOfficial } from "@/hooks/useCursorOfficial";
import { useCursorSessionIndex } from "@/hooks/useCursorSessionIndex";
import { cursorApi, type CursorLaunchResult } from "@/lib/api/cursor";
import { settingsApi } from "@/lib/api/settings";
import { isMac } from "@/lib/platform";
import type { SessionMeta } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";
import { deriveCursorResumeState } from "./cursorResumeState";

interface CursorResumeGateProps {
  session: SessionMeta;
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

export function CursorResumeGate({ session }: CursorResumeGateProps) {
  const { t } = useTranslation();
  const official = useCursorOfficial();
  const index = useCursorSessionIndex();
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

  const indexUnavailableReason =
    index.status?.state === "indexUnavailable"
      ? index.status.reason
      : index.isError
        ? extractErrorMessage(index.error)
        : null;
  const contextError = resumeContext.isError
    ? extractErrorMessage(resumeContext.error)
    : null;
  const statusError = official.isError
    ? extractErrorMessage(official.error)
    : null;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        {indexUnavailableReason ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {t("sessionManager.cursorIndexUnavailable", {
                defaultValue: "Cursor 会话索引不可用",
              })}
              ：{indexUnavailableReason}
            </span>
          </div>
        ) : null}

        <div className="space-y-4 rounded-lg border border-border/60 bg-background/50 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              {t("sessionManager.cursorContinueTitle", {
                defaultValue: "继续 Cursor 会话",
              })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("sessionManager.cursorContinueDescription", {
                defaultValue: "在原项目目录中继续这段 Cursor Agent 会话。",
              })}
            </p>
          </div>

          {resumeState === "platformUnavailable" ? (
            <div className="rounded-md bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              {t("sessionManager.cursorPlatformUnavailable", {
                defaultValue: "当前仅支持在 macOS 恢复 Cursor 会话。",
              })}
            </div>
          ) : resumeState === "cliMissing" ? (
            <div className="rounded-md bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              {t("sessionManager.cursorCliMissing", {
                defaultValue:
                  "未找到 Cursor Agent CLI。请先在 Cursor 中安装 Agent CLI。",
              })}
            </div>
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
            <Button
              type="button"
              onClick={() => void handleChooseWorkspace()}
              disabled={launchMutation.isPending}
            >
              {launchMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              {t("sessionManager.cursorChooseDirectoryAndContinue", {
                defaultValue: "选择目录并继续",
              })}
            </Button>
          ) : resumeState === "needsLogin" || resumeState === "needsApiKey" ? (
            <CursorOfficialAuthControl
              variant="compact"
              onLogin={() => launch(true)}
              onApiKeyReady={() => launch(false)}
            />
          ) : resumeState === "ready" ? (
            <Button
              type="button"
              onClick={() => void launch(false)}
              disabled={launchMutation.isPending}
            >
              {launchMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {t("sessionManager.cursorContinue", {
                defaultValue: "继续会话",
              })}
            </Button>
          ) : (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("sessionManager.cursorCheckingResume", {
                defaultValue: "正在检查恢复条件…",
              })}
            </div>
          )}

          {actionError ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{actionError}</span>
            </div>
          ) : null}

          <details className="border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {t("sessionManager.cursorTechnicalDetails", {
                defaultValue: "技术详情",
              })}
            </summary>
            <dl className="mt-3 grid gap-3">
              <div>
                <dt className="font-medium text-foreground">
                  {t("sessionManager.cursorWorkspacePath", {
                    defaultValue: "完整路径",
                  })}
                </dt>
                <dd className="mt-1 break-all font-mono">
                  {resolvedWorkspace ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">Chat ID</dt>
                <dd className="mt-1 break-all font-mono">
                  {session.sessionId}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  {t("sessionManager.cursorFixedCommand", {
                    defaultValue: "固定恢复命令",
                  })}
                </dt>
                <dd className="mt-1 break-all font-mono">{fixedCommand}</dd>
              </div>
              {official.status?.version ? (
                <div>
                  <dt className="font-medium text-foreground">CLI</dt>
                  <dd className="mt-1 break-all font-mono">
                    {official.status.version}
                  </dd>
                </div>
              ) : null}
            </dl>
          </details>
        </div>
      </div>
    </div>
  );
}

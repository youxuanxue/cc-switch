import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  KeyRound,
  Loader2,
  LogIn,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCursorOfficial } from "@/hooks/useCursorOfficial";
import type {
  CursorOfficialRuntimeState,
  CursorOfficialStatus,
} from "@/lib/api/cursor";
import { cn } from "@/lib/utils";

export interface CursorOfficialAuthControlProps {
  variant: "full" | "compact";
  onLogin?: () => void | Promise<void>;
  onApiKeyReady?: () => void | Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CursorOfficialAuthControl({
  variant,
  onLogin,
  onApiKeyReady,
}: CursorOfficialAuthControlProps) {
  const { t } = useTranslation();
  const {
    status,
    error,
    isLoading,
    updateAuth,
    clearUserApiKey,
    launchLogin,
    refresh,
    isUpdating,
    isClearing,
    isLaunchingLogin,
  } = useCursorOfficial();
  const [showOtherMethods, setShowOtherMethods] = useState(false);
  const [userApiKey, setUserApiKey] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const stateLabels: Record<CursorOfficialRuntimeState, string> = {
    ready: t("settings.authCenter.cursorReady", {
      defaultValue: "已就绪",
    }),
    needsLogin: t("settings.authCenter.cursorNeedsLogin", {
      defaultValue: "需要登录",
    }),
    needsApiKey: t("settings.authCenter.cursorNeedsApiKey", {
      defaultValue: "需要 API Key",
    }),
    cliMissing: t("settings.authCenter.cursorCliMissing", {
      defaultValue: "CLI 未安装",
    }),
    statusUnavailable: t("settings.authCenter.cursorStatusUnavailable", {
      defaultValue: "状态不可用",
    }),
  };
  const stateLabel = isLoading
    ? t("settings.authCenter.cursorStatusLoading", {
        defaultValue: "正在检查…",
      })
    : status
      ? stateLabels[status.state]
      : t("settings.authCenter.cursorStatusUnavailable", {
          defaultValue: "状态不可用",
        });
  const configuredLabel = t("settings.authCenter.cursorApiKeyConfigured", {
    defaultValue: "已配置 ••••••••",
  });
  const displayedError =
    actionError ?? status?.error ?? (error ? errorMessage(error) : null);
  const loginDisabled = status?.state === "cliMissing" || isLoading;

  const handleLogin = async () => {
    setActionError(null);
    try {
      if (status?.authMode === "userApiKey") {
        await updateAuth({ authMode: "login" });
      }
      if (onLogin) {
        await onLogin();
      } else {
        await launchLogin();
      }
    } catch (loginError) {
      setActionError(errorMessage(loginError));
    }
  };

  const handleSaveApiKey = async () => {
    if (!userApiKey.trim()) return;

    setActionError(null);
    try {
      const nextStatus: CursorOfficialStatus = await updateAuth({
        authMode: "userApiKey",
        userApiKey,
      });
      setUserApiKey("");
      setShowOtherMethods(false);
      if (nextStatus.state === "ready") {
        await onApiKeyReady?.();
      }
    } catch (saveError) {
      setActionError(errorMessage(saveError));
    }
  };

  const handleClearApiKey = async () => {
    setActionError(null);
    try {
      await clearUserApiKey();
      setUserApiKey("");
    } catch (clearError) {
      setActionError(errorMessage(clearError));
    }
  };

  return (
    <div
      className={cn(
        "space-y-3",
        variant === "full" &&
          "rounded-lg border border-border/60 bg-background/50 p-4",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Badge
              variant={status?.state === "ready" ? "default" : "secondary"}
              className={cn(
                status?.state === "ready" &&
                  "bg-emerald-500 hover:bg-emerald-600",
              )}
            >
              {stateLabel}
            </Badge>
            {status?.account?.email ? (
              <span className="truncate text-sm text-muted-foreground">
                {status.account.email}
              </span>
            ) : null}
          </div>
          {variant === "full" ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.authCenter.cursorLoginDescription", {
                defaultValue: "使用 Cursor 官方登录状态恢复 Agent CLI 会话。",
              })}
            </p>
          ) : null}
        </div>

        <Button
          type="button"
          onClick={() => void handleLogin()}
          disabled={loginDisabled || isUpdating || isLaunchingLogin}
        >
          {isUpdating || isLaunchingLogin ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogIn className="h-4 w-4" />
          )}
          {onLogin
            ? t("settings.authCenter.cursorLoginAndContinue", {
                defaultValue: "登录并继续",
              })
            : t("settings.authCenter.cursorLogin", {
                defaultValue: "登录 Cursor",
              })}
        </Button>
      </div>

      <div className="border-t border-border/50 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-between px-2"
          aria-label={t("settings.authCenter.cursorOtherMethods", {
            defaultValue: "其他方式",
          })}
          aria-expanded={showOtherMethods}
          onClick={() => setShowOtherMethods((current) => !current)}
        >
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            {t("settings.authCenter.cursorOtherMethods", {
              defaultValue: "其他方式",
            })}
          </span>
          <span className="flex items-center gap-2">
            {status?.hasUserApiKey ? (
              <span className="text-xs text-muted-foreground">
                {configuredLabel}
              </span>
            ) : null}
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                showOtherMethods && "rotate-180",
              )}
            />
          </span>
        </Button>

        {showOtherMethods ? (
          <div className="mt-3 space-y-3 rounded-md bg-muted/35 p-3">
            <div className="space-y-2">
              <Label htmlFor={`cursor-user-api-key-${variant}`}>
                Cursor User API Key
              </Label>
              <Input
                id={`cursor-user-api-key-${variant}`}
                type="password"
                autoComplete="new-password"
                value={userApiKey}
                onChange={(event) => setUserApiKey(event.target.value)}
                placeholder={t("settings.authCenter.cursorApiKeyPlaceholder", {
                  defaultValue: "粘贴 Cursor User API Key",
                })}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.authCenter.cursorApiKeyLocalOnly", {
                  defaultValue: "仅保存在本机 CC Switch 设置中。",
                })}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!userApiKey.trim() || isUpdating}
                onClick={() => void handleSaveApiKey()}
              >
                {isUpdating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
                {onApiKeyReady
                  ? t("settings.authCenter.cursorConfigureAndContinue", {
                      defaultValue: "配置并继续",
                    })
                  : t("settings.authCenter.cursorSaveApiKey", {
                      defaultValue: "保存 User API Key",
                    })}
              </Button>
              {status?.hasUserApiKey ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isClearing}
                  onClick={() => void handleClearApiKey()}
                >
                  {isClearing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  {t("settings.authCenter.cursorClearApiKey", {
                    defaultValue: "清除 User API Key",
                  })}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {displayedError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{displayedError}</span>
        </div>
      ) : null}

      {variant === "full" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              {t("settings.authCenter.cursorTechnicalDetails", {
                defaultValue: "技术详情",
              })}
            </summary>
            <div className="mt-2 space-y-1 pl-1">
              <p>
                {t("settings.authCenter.cursorAuthMode", {
                  defaultValue: "认证方式",
                })}
                ：{status?.authMode === "userApiKey" ? "User API Key" : "Login"}
              </p>
              {status?.version ? <p>{status.version}</p> : null}
            </div>
          </details>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
            {t("settings.authCenter.cursorRefresh", {
              defaultValue: "刷新状态",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

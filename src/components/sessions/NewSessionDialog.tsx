import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import type { SessionMeta } from "@/types";
import { sessionsApi } from "@/lib/api";
import { settingsApi } from "@/lib/api/settings";
import { isCaseInsensitiveFs } from "@/lib/platform";
import { extractErrorMessage } from "@/utils/errorUtils";
import { getSessionProjectGroupKey } from "./utils";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAIN_WORKSPACE,
  NEW_SESSION_PROVIDERS,
  buildNewSessionLaunch,
  canUseNamedWorkspace,
  collectKnownProjects,
  defaultNewSessionProjectDir,
  defaultNewSessionProvider,
  mergeWorkspaceSlugs,
  normalizeWorkspaceSlug,
  type NewSessionLaunch,
  type NewSessionProvider,
  type WtsWorkspace,
} from "./newSessionLaunch";

const PROVIDER_LABELS: Record<NewSessionProvider, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
  grokbuild: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
};

export function NewSessionDialog({
  open,
  onOpenChange,
  sessions,
  selectedSession,
  providerFilter,
  onLaunch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: SessionMeta[];
  selectedSession: SessionMeta | null;
  providerFilter: string;
  onLaunch: (launch: Extract<NewSessionLaunch, { command: string }>) => void;
}) {
  const { t } = useTranslation();
  const projectIdentityOptions = useMemo(
    () => ({ caseInsensitive: isCaseInsensitiveFs() }),
    [],
  );
  const knownProjects = useMemo(
    () => collectKnownProjects(sessions, projectIdentityOptions),
    [projectIdentityOptions, sessions],
  );
  const [providerId, setProviderId] = useState<NewSessionProvider>("claude");
  const [projectDir, setProjectDir] = useState("");
  const [workspaceChoice, setWorkspaceChoice] = useState(MAIN_WORKSPACE);
  const [customSlug, setCustomSlug] = useState("");
  const [diskWorkspaces, setDiskWorkspaces] = useState<WtsWorkspace[]>([]);
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    setProviderId(defaultNewSessionProvider(providerFilter, selectedSession));
    setProjectDir(
      defaultNewSessionProjectDir(
        selectedSession,
        sessions,
        projectIdentityOptions,
      ),
    );
    setWorkspaceChoice(MAIN_WORKSPACE);
    setCustomSlug("");
    setIsGitRepo(null);
    setWorkspaceError(null);
  }, [open, projectIdentityOptions, providerFilter, selectedSession, sessions]);

  useEffect(() => {
    if (!open || !projectDir.trim()) {
      setDiskWorkspaces([]);
      setIsGitRepo(null);
      setWorkspaceError(null);
      return;
    }

    let cancelled = false;
    setIsGitRepo(null);
    void sessionsApi
      .listWtsWorkspaces(projectDir.trim())
      .then((context) => {
        if (!cancelled) {
          setDiskWorkspaces(context.workspaces);
          setIsGitRepo(context.isGitRepo);
          setWorkspaceError(null);
          if (!context.isGitRepo) {
            setWorkspaceChoice(MAIN_WORKSPACE);
            setCustomSlug("");
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDiskWorkspaces([]);
          setIsGitRepo(false);
          setWorkspaceChoice(MAIN_WORKSPACE);
          setCustomSlug("");
          setWorkspaceError(extractErrorMessage(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectDir]);

  const namedWorkspaceAllowed = canUseNamedWorkspace(isGitRepo);
  const matchingKnownProject = knownProjects.find(
    (project) =>
      getSessionProjectGroupKey(project.dir, projectIdentityOptions) ===
      getSessionProjectGroupKey(projectDir.trim(), projectIdentityOptions),
  );
  const sessionSlugs = namedWorkspaceAllowed
    ? (matchingKnownProject?.slugs ?? [])
    : [];
  const workspaces = namedWorkspaceAllowed
    ? mergeWorkspaceSlugs(sessionSlugs, diskWorkspaces)
    : [];
  const workspace = namedWorkspaceAllowed
    ? customSlug.trim() || workspaceChoice
    : MAIN_WORKSPACE;
  const launch = buildNewSessionLaunch({
    providerId,
    projectDir,
    workspace,
    knownWorkspaces: workspaces,
    isGitRepo,
  });
  const canLaunch = !("error" in launch);

  const launchError =
    "error" in launch
      ? launch.error === "invalid-project"
        ? t("sessionManager.newSessionInvalidProject", {
            defaultValue: "请选择一个项目目录。",
          })
        : launch.error === "create-requires-wts"
          ? t("sessionManager.newSessionCreateRequiresWts", {
              defaultValue:
                "新建命名工作区请改用 Cursor / Claude / Codex，或先关联已有工作区。",
            })
          : launch.error === "requires-git"
            ? t("sessionManager.newSessionRequiresGit", {
                defaultValue:
                  "这个目录不是 git 仓库，不能创建隔离工作区。可以在当前目录打开会话。",
              })
            : t("sessionManager.newSessionInvalidWorkspace", {
                defaultValue:
                  "工作区名称只能使用字母、数字、点、下划线和连字符。",
              })
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("sessionManager.newSessionTitle", {
              defaultValue: "新建会话",
            })}
          </DialogTitle>
          <DialogDescription>
            {t("sessionManager.newSessionDescription", {
              defaultValue:
                "用所选应用打开指定项目和工作区的新会话，窗口与恢复会话相同。工作区默认 main；输入名称则通过 wts 创建或关联。",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-4">
          <div className="space-y-2">
            <Label htmlFor="new-session-provider">
              {t("sessionManager.newSessionAgent", {
                defaultValue: "应用",
              })}
            </Label>
            <Select
              value={providerId}
              onValueChange={(value) =>
                setProviderId(value as NewSessionProvider)
              }
            >
              <SelectTrigger id="new-session-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEW_SESSION_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-session-project">
              {t("sessionManager.newSessionProject", {
                defaultValue: "项目目录",
              })}
            </Label>
            {knownProjects.length > 0 ? (
              <Select
                value={matchingKnownProject?.dir ?? "__custom__"}
                onValueChange={(value) => {
                  if (value !== "__custom__") {
                    setProjectDir(value);
                    setWorkspaceChoice(MAIN_WORKSPACE);
                    setCustomSlug("");
                  }
                }}
              >
                <SelectTrigger
                  aria-label={t("sessionManager.newSessionPickProject", {
                    defaultValue: "选择已知项目",
                  })}
                >
                  <SelectValue
                    placeholder={t("sessionManager.newSessionPickProject", {
                      defaultValue: "选择已知项目",
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {knownProjects.map((project) => (
                    <SelectItem key={project.dir} value={project.dir}>
                      {project.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="flex items-center gap-2">
              <Input
                id="new-session-project"
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                placeholder="/Users/you/Codes/repo"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label={t("sessionManager.newSessionBrowse", {
                  defaultValue: "选择目录",
                })}
                onClick={() => {
                  void settingsApi
                    .pickDirectory(projectDir || undefined)
                    .then((selected) => {
                      if (selected) {
                        setProjectDir(selected);
                        setWorkspaceChoice(MAIN_WORKSPACE);
                        setCustomSlug("");
                      }
                    });
                }}
              >
                <FolderOpen className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-session-workspace">
              {t("sessionManager.newSessionWorkspace", {
                defaultValue: "工作区",
              })}
            </Label>
            {namedWorkspaceAllowed ? (
              <>
                <Select
                  value={workspaceChoice}
                  onValueChange={(value) => {
                    setWorkspaceChoice(value);
                    setCustomSlug("");
                  }}
                >
                  <SelectTrigger id="new-session-workspace">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MAIN_WORKSPACE}>
                      {t("sessionManager.newSessionMainWorkspace", {
                        defaultValue: "main（主仓库）",
                      })}
                    </SelectItem>
                    {workspaces.map((item) => (
                      <SelectItem key={item.slug} value={item.slug}>
                        {item.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={customSlug}
                  onChange={(event) => setCustomSlug(event.target.value)}
                  placeholder={t(
                    "sessionManager.newSessionWorkspacePlaceholder",
                    {
                      defaultValue: "或输入工作区名称，例如 review",
                    },
                  )}
                  aria-label={t("sessionManager.newSessionWorkspaceName", {
                    defaultValue: "工作区名称",
                  })}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {isGitRepo === false
                  ? t("sessionManager.newSessionRequiresGit", {
                      defaultValue:
                        "这个目录不是 git 仓库，不能创建隔离工作区。可以在当前目录打开会话。",
                    })
                  : t("sessionManager.newSessionCheckingWorkspace", {
                      defaultValue: "正在检查这个目录能不能创建隔离工作区。",
                    })}
              </p>
            )}
            {workspaceError ? (
              <p className="text-sm text-muted-foreground">{workspaceError}</p>
            ) : null}
          </div>

          {launchError ? (
            <p className="text-sm text-destructive">{launchError}</p>
          ) : customSlug.trim() &&
            normalizeWorkspaceSlug(customSlug) &&
            !workspaces.some((item) => item.slug === customSlug.trim()) ? (
            <p className="text-sm text-muted-foreground">
              {t("sessionManager.newSessionWillCreate", {
                defaultValue: "将通过 wts 创建工作区 {{slug}}。",
                slug: customSlug.trim(),
              })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "取消" })}
          </Button>
          <Button
            disabled={!canLaunch}
            onClick={() => {
              if (!canLaunch) {
                return;
              }
              onLaunch(launch);
            }}
          >
            {t("sessionManager.newSessionConfirm", {
              defaultValue: "打开会话",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

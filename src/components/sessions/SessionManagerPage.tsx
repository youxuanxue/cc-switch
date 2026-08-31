import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Copy,
  RefreshCw,
  Search,
  Play,
  Trash2,
  MessageSquare,
  Clock,
  FolderOpen,
  FileText,
  X,
  CalendarClock,
  CheckSquare,
  Plus,
  ListTree,
  List,
  FolderTree,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
} from "lucide-react";
import {
  piKeys,
  sessionResumeStateKey,
  useDeleteSessionMutation,
  useSessionMessagesQuery,
  useSessionResumeStateQuery,
  useSessionsQuery,
} from "@/lib/query";
import { piApi, sessionsApi } from "@/lib/api";
import type { SessionMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isCaseInsensitiveFs, isMac } from "@/lib/platform";
import { useCursorSessionIndex } from "@/hooks/useCursorSessionIndex";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SessionItem } from "./SessionItem";
import {
  CursorResumeGate,
  type CursorResumePrimaryAction,
} from "./CursorResumeGate";
import {
  STALE_CLEANUP_DEFAULT_DAYS,
  isSessionDeletable,
  sessionMessageSourcePath,
  normalizeStaleCleanupDays,
} from "./sessionCapabilities";
import { NewSessionDialog } from "./NewSessionDialog";
import { StaleSessionCleanupDialog } from "./StaleSessionCleanupDialog";
import { SessionMessageItem } from "./SessionMessageItem";
import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";
import {
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionDirectoryGroupKey,
  getSessionKey,
  getSessionProjectGroupKey,
  getSessionResumeI18nKeys,
  groupSessionsByProject,
  groupSessionsByProviderAndDirectory,
  type SessionDirectoryGroup,
  type SessionProjectGroup,
  type SessionProviderGroup,
} from "./utils";
import { buildSessionTocItems, toDisplayMessages } from "./sessionChrome";

const SESSION_LIST_VIEW_MODE_STORAGE_KEY =
  "cc-switch.sessionManager.listViewMode";
const SESSION_GROUP_EXPANSION_STORAGE_KEY =
  "cc-switch.sessionManager.groupExpansionState";
const SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY =
  "cc-switch.sessionManager.staleCleanupDays";

type ProviderFilter =
  | "all"
  | "cursor"
  | "codex"
  | "grokbuild"
  | "claude"
  | "opencode"
  | "openclaw"
  | "gemini"
  | "hermes"
  | "pi";

type SessionListViewMode = "flat" | "grouped" | "byProject";

type GroupSelectionState = {
  checked: boolean | "indeterminate";
  isSelected: boolean;
  selectedCount: number;
  selectableCount: number;
};

type SessionGroupExpansionState = {
  expandedProviderIds: Set<string>;
  expandedDirectoryKeys: Set<string>;
  expandedProjectKeys: Set<string>;
};

const readInitialSessionListViewMode = (): SessionListViewMode => {
  if (typeof window === "undefined") return "byProject";
  const stored = window.localStorage.getItem(
    SESSION_LIST_VIEW_MODE_STORAGE_KEY,
  );
  return stored === "grouped" || stored === "flat" || stored === "byProject"
    ? stored
    : "byProject";
};

const readInitialStaleCleanupDays = (): number => {
  if (typeof window === "undefined") return STALE_CLEANUP_DEFAULT_DAYS;
  const stored = Number(
    window.localStorage.getItem(SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY),
  );
  return normalizeStaleCleanupDays(stored) ?? STALE_CLEANUP_DEFAULT_DAYS;
};

const readInitialSessionGroupExpansionState =
  (): SessionGroupExpansionState => {
    if (typeof window === "undefined") {
      return {
        expandedProviderIds: new Set(),
        expandedDirectoryKeys: new Set(),
        expandedProjectKeys: new Set(),
      };
    }

    try {
      const stored = window.localStorage.getItem(
        SESSION_GROUP_EXPANSION_STORAGE_KEY,
      );
      const parsed = stored ? JSON.parse(stored) : null;

      if (!parsed || typeof parsed !== "object") {
        return {
          expandedProviderIds: new Set(),
          expandedDirectoryKeys: new Set(),
          expandedProjectKeys: new Set(),
        };
      }

      const expandedProviderIds = Array.isArray(parsed.expandedProviderIds)
        ? parsed.expandedProviderIds.filter(
            (providerId: unknown): providerId is string =>
              typeof providerId === "string",
          )
        : [];
      const expandedDirectoryKeys = Array.isArray(parsed.expandedDirectoryKeys)
        ? parsed.expandedDirectoryKeys.filter(
            (directoryKey: unknown): directoryKey is string =>
              typeof directoryKey === "string",
          )
        : [];
      const expandedProjectKeys = Array.isArray(parsed.expandedProjectKeys)
        ? parsed.expandedProjectKeys.filter(
            (projectKey: unknown): projectKey is string =>
              typeof projectKey === "string",
          )
        : [];

      return {
        expandedProviderIds: new Set(expandedProviderIds),
        expandedDirectoryKeys: new Set(expandedDirectoryKeys),
        expandedProjectKeys: new Set(expandedProjectKeys),
      };
    } catch {
      return {
        expandedProviderIds: new Set(),
        expandedDirectoryKeys: new Set(),
        expandedProjectKeys: new Set(),
      };
    }
  };

const serializeSessionGroupExpansionState = (
  expandedProviderGroups: Set<string>,
  expandedDirectoryGroups: Set<string>,
  expandedProjectGroups: Set<string>,
) =>
  JSON.stringify({
    expandedProviderIds: Array.from(expandedProviderGroups).sort(),
    expandedDirectoryKeys: Array.from(expandedDirectoryGroups).sort(),
    expandedProjectKeys: Array.from(expandedProjectGroups).sort(),
  });

const filterSetToAllowedValues = (
  current: Set<string>,
  allowedValues: Set<string>,
) => {
  let changed = false;
  const next = new Set<string>();

  current.forEach((value) => {
    if (allowedValues.has(value)) {
      next.add(value);
    } else {
      changed = true;
    }
  });

  return changed ? next : current;
};

export function SessionManagerPage({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useSessionsQuery();
  const sessions = data ?? [];
  const piSessionDiscovery = useQuery({
    queryKey: piKeys.sessionDiscovery,
    queryFn: () => piApi.getSessionDiscovery(),
    enabled: appId === "pi",
    staleTime: 30 * 1000,
  });
  const detailRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null,
  );
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<SessionMeta[] | null>(
    null,
  );
  const [selectedSessionKeys, setSelectedSessionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedSessionKeys(new Set());
  }, []);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [search, setSearch] = useState("");
  const [cursorPrimaryAction, setCursorPrimaryAction] =
    useState<CursorResumePrimaryAction | null>(null);
  const [cursorResumeCommand, setCursorResumeCommand] = useState<string | null>(
    null,
  );
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const cursorSessionIndex = useCursorSessionIndex(providerFilter === "cursor");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [listViewMode, setListViewMode] = useState<SessionListViewMode>(
    readInitialSessionListViewMode,
  );
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [staleCleanupOpen, setStaleCleanupOpen] = useState(false);
  const [staleCleanupDays, setStaleCleanupDays] = useState(
    readInitialStaleCleanupDays,
  );
  const [initialGroupExpansionState] = useState(
    readInitialSessionGroupExpansionState,
  );
  const [expandedProviderGroups, setExpandedProviderGroups] = useState<
    Set<string>
  >(() => initialGroupExpansionState.expandedProviderIds);
  const [expandedDirectoryGroups, setExpandedDirectoryGroups] = useState<
    Set<string>
  >(() => initialGroupExpansionState.expandedDirectoryKeys);
  const [expandedProjectGroups, setExpandedProjectGroups] = useState<
    Set<string>
  >(() => initialGroupExpansionState.expandedProjectKeys);

  // 使用 FlexSearch 全文搜索
  const { search: searchSessions } = useSessionSearch({
    sessions,
    providerFilter,
  });

  const filteredSessions = useMemo(() => {
    return searchSessions(search);
  }, [searchSessions, search]);

  const unknownDirectoryLabel = t("sessionManager.unknownDirectory", {
    defaultValue: "未知目录",
  });
  const groupedSessions = useMemo(
    () =>
      groupSessionsByProviderAndDirectory(
        filteredSessions,
        unknownDirectoryLabel,
      ),
    [filteredSessions, unknownDirectoryLabel],
  );
  const projectIdentityOptions = useMemo(
    () => ({ caseInsensitive: isCaseInsensitiveFs() }),
    [],
  );
  const projectGroupedSessions = useMemo(
    () =>
      groupSessionsByProject(
        filteredSessions,
        unknownDirectoryLabel,
        projectIdentityOptions,
      ),
    [filteredSessions, unknownDirectoryLabel, projectIdentityOptions],
  );

  const validGroupExpansionKeys = useMemo(
    () => ({
      providerIds: new Set(sessions.map((session) => session.providerId)),
      directoryKeys: new Set(
        sessions.map((session) =>
          getSessionDirectoryGroupKey(session.providerId, session.projectDir),
        ),
      ),
      projectKeys: new Set(
        sessions.map((session) =>
          getSessionProjectGroupKey(session.projectDir, projectIdentityOptions),
        ),
      ),
    }),
    [projectIdentityOptions, sessions],
  );

  useEffect(() => {
    window.localStorage.setItem(
      SESSION_LIST_VIEW_MODE_STORAGE_KEY,
      listViewMode,
    );
  }, [listViewMode]);

  useEffect(() => {
    window.localStorage.setItem(
      SESSION_STALE_CLEANUP_DAYS_STORAGE_KEY,
      String(staleCleanupDays),
    );
  }, [staleCleanupDays]);

  useEffect(() => {
    window.localStorage.setItem(
      SESSION_GROUP_EXPANSION_STORAGE_KEY,
      serializeSessionGroupExpansionState(
        expandedProviderGroups,
        expandedDirectoryGroups,
        expandedProjectGroups,
      ),
    );
  }, [expandedDirectoryGroups, expandedProjectGroups, expandedProviderGroups]);

  useEffect(() => {
    if (isLoading) return;

    setExpandedProviderGroups((current) =>
      filterSetToAllowedValues(current, validGroupExpansionKeys.providerIds),
    );
    setExpandedDirectoryGroups((current) =>
      filterSetToAllowedValues(current, validGroupExpansionKeys.directoryKeys),
    );
    setExpandedProjectGroups((current) =>
      filterSetToAllowedValues(current, validGroupExpansionKeys.projectKeys),
    );
  }, [isLoading, validGroupExpansionKeys]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedKey(null);
      return;
    }
    const exists = selectedKey
      ? filteredSessions.some(
          (session) => getSessionKey(session) === selectedKey,
        )
      : false;
    if (!exists) {
      setSelectedKey(getSessionKey(filteredSessions[0]));
    }
  }, [filteredSessions, selectedKey]);

  const selectedSession = useMemo(() => {
    if (!selectedKey) return null;
    return (
      filteredSessions.find(
        (session) => getSessionKey(session) === selectedKey,
      ) || null
    );
  }, [filteredSessions, selectedKey]);

  const listViewModeLabel =
    listViewMode === "byProject"
      ? t("sessionManager.viewModeByProject", {
          defaultValue: "项目",
        })
      : listViewMode === "grouped"
        ? t("sessionManager.viewModeGrouped", {
            defaultValue: "分类",
          })
        : t("sessionManager.viewModeFlat", {
            defaultValue: "列表",
          });
  const isGroupedListView =
    listViewMode === "grouped" || listViewMode === "byProject";

  const isCursorSession = selectedSession?.providerId === "cursor";
  const headerResumeCommand = selectedSession
    ? isCursorSession
      ? (cursorResumeCommand ??
        `agent --workspace ${selectedSession.projectDir?.trim() || "<workspace>"} --resume ${selectedSession.sessionId}`)
      : selectedSession.resumeCommand
    : undefined;
  const cursorIndexUnavailableReason =
    providerFilter === "cursor" &&
    cursorSessionIndex.status?.state === "indexUnavailable"
      ? cursorSessionIndex.status.reason
      : providerFilter === "cursor" && cursorSessionIndex.isError
        ? extractErrorMessage(cursorSessionIndex.error)
        : null;

  const { data: messages = [], isLoading: isLoadingMessages } =
    useSessionMessagesQuery(
      selectedSession?.providerId,
      sessionMessageSourcePath(selectedSession),
    );
  const { data: resumeState } = useSessionResumeStateQuery(
    selectedSession?.providerId,
    selectedSession?.sessionId,
    selectedSession?.sourcePath,
  );
  const resumeCopy = getSessionResumeI18nKeys(resumeState?.appearance);
  const deleteSessionMutation = useDeleteSessionMutation();
  const isDeleting = deleteSessionMutation.isPending || isBatchDeleting;
  const displayMessages = useMemo(
    () => toDisplayMessages(messages, selectedSession?.providerId),
    [messages, selectedSession?.providerId],
  );

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 5,
    gap: 12,
  });

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [selectedKey]);

  useEffect(() => {
    const validKeys = new Set(
      sessions.map((session) => getSessionKey(session)),
    );
    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      current.forEach((key) => {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [sessions]);

  const userMessagesToc = useMemo(
    () => buildSessionTocItems(displayMessages, selectedSession?.providerId),
    [displayMessages, selectedSession?.providerId],
  );

  const scrollToMessage = (index: number) => {
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    setActiveMessageIndex(index);
    setTocDialogOpen(false);
    setTimeout(() => setActiveMessageIndex(null), 2000);
  };

  const handleCopy = useCallback(
    async (text: string, successMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(successMessage);
      } catch (error) {
        toast.error(
          extractErrorMessage(error) ||
            t("common.error", { defaultValue: "Copy failed" }),
        );
      }
    },
    [t],
  );

  const handleMessageCopy = useCallback(
    (content: string) => {
      void handleCopy(
        content,
        t("sessionManager.messageCopied", { defaultValue: "已复制消息内容" }),
      );
    },
    [handleCopy, t],
  );

  const handleResume = async () => {
    if (!selectedSession?.resumeCommand) return;

    if (!isMac()) {
      await handleCopy(
        selectedSession.resumeCommand,
        t("sessionManager.resumeCommandCopied"),
      );
      return;
    }

    try {
      const result = await sessionsApi.launchTerminal({
        command: selectedSession.resumeCommand,
        cwd: selectedSession.projectDir ?? undefined,
        sessionId: selectedSession.sessionId,
        providerId: selectedSession.providerId,
        sourcePath: selectedSession.sourcePath,
      });
      if (result?.action === "focused") {
        toast.success(
          t("sessionManager.resumeFocused", {
            defaultValue: "已切换到已打开的会话窗口（{{app}}）",
            app: result.app,
          }),
        );
      } else if (result?.action === "occupied") {
        toast.error(
          t("sessionManager.resumeOccupied", {
            defaultValue: "该会话已在 {{holder}} 中打开，请先回到那个窗口",
            holder: result.holder,
          }),
        );
      } else {
        toast.success(
          t("sessionManager.terminalLaunched", {
            defaultValue: "终端已启动",
          }),
        );
      }
      await queryClient.invalidateQueries({
        queryKey: sessionResumeStateKey(
          selectedSession.providerId,
          selectedSession.sessionId,
          selectedSession.sourcePath,
        ),
      });
    } catch (error) {
      const fallback = selectedSession.resumeCommand;
      await handleCopy(fallback, t("sessionManager.resumeFallbackCopied"));
      toast.error(extractErrorMessage(error) || t("sessionManager.openFailed"));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTargets || deleteTargets.length === 0 || isDeleting) {
      return;
    }

    const targets = deleteTargets.filter(isSessionDeletable);
    setDeleteTargets(null);

    if (targets.length === 0) {
      return;
    }

    if (targets.length === 1) {
      const [target] = targets;
      await deleteSessionMutation.mutateAsync({
        providerId: target.providerId,
        sessionId: target.sessionId,
        sourcePath: target.sourcePath!,
      });
      setSelectedSessionKeys((current) => {
        const next = new Set(current);
        next.delete(getSessionKey(target));
        return next;
      });
      return;
    }

    setIsBatchDeleting(true);
    try {
      const results = await sessionsApi.deleteMany(
        targets.map((session) => ({
          providerId: session.providerId,
          sessionId: session.sessionId,
          sourcePath: session.sourcePath!,
        })),
      );

      const deletedKeys = results
        .filter((result) => result.success)
        .map(
          (result) =>
            `${result.providerId}:${result.sessionId}:${result.sourcePath ?? ""}`,
        );

      const failedErrors = results
        .filter((result) => !result.success)
        .map((result) => result.error || t("common.unknown"));

      if (deletedKeys.length > 0) {
        const deletedKeySet = new Set(deletedKeys);
        queryClient.setQueryData<SessionMeta[]>(["sessions"], (current) =>
          (current ?? []).filter(
            (session) => !deletedKeySet.has(getSessionKey(session)),
          ),
        );
      }

      results
        .filter((result) => result.success)
        .forEach((result) => {
          queryClient.removeQueries({
            queryKey: ["sessionMessages", result.providerId, result.sourcePath],
          });
        });

      setSelectedSessionKeys((current) => {
        const next = new Set(current);
        deletedKeys.forEach((key) => next.delete(key));
        return next;
      });

      await queryClient.invalidateQueries({ queryKey: ["sessions"] });

      if (deletedKeys.length > 0) {
        toast.success(
          t("sessionManager.batchDeleteSuccess", {
            defaultValue: "已删除 {{count}} 个会话",
            count: deletedKeys.length,
          }),
        );
      }

      if (failedErrors.length > 0) {
        toast.error(
          t("sessionManager.batchDeleteFailed", {
            defaultValue: "{{failed}} 个会话删除失败",
            failed: failedErrors.length,
          }),
          {
            description: failedErrors[0],
          },
        );
      }
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("sessionManager.batchDeleteRequestFailed", {
            defaultValue: "批量删除失败，请稍后重试",
          }),
      );
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const deletableFilteredSessions = useMemo(
    () => filteredSessions.filter(isSessionDeletable),
    [filteredSessions],
  );

  const hasDeletableSessionsForProvider = useMemo(
    () =>
      sessions.some(
        (session) =>
          (providerFilter === "all" || session.providerId === providerFilter) &&
          isSessionDeletable(session),
      ),
    [providerFilter, sessions],
  );

  const selectedSessions = useMemo(
    () =>
      sessions.filter((session) =>
        selectedSessionKeys.has(getSessionKey(session)),
      ),
    [sessions, selectedSessionKeys],
  );

  const selectedDeletableSessions = useMemo(
    () => selectedSessions.filter(isSessionDeletable),
    [selectedSessions],
  );

  useEffect(() => {
    if (selectionMode && !hasDeletableSessionsForProvider) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, hasDeletableSessionsForProvider, selectionMode]);

  useEffect(() => {
    if (!selectionMode) return;

    const visibleKeys = new Set(
      deletableFilteredSessions.map((session) => getSessionKey(session)),
    );

    setSelectedSessionKeys((current) => {
      let changed = false;
      const next = new Set<string>();

      current.forEach((key) => {
        if (visibleKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [deletableFilteredSessions, selectionMode]);

  const allFilteredSelected =
    deletableFilteredSessions.length > 0 &&
    deletableFilteredSessions.every((session) =>
      selectedSessionKeys.has(getSessionKey(session)),
    );

  const getGroupSelectionState = (
    groupSessions: SessionMeta[],
  ): GroupSelectionState => {
    const selectableSessions = groupSessions.filter(isSessionDeletable);
    const selectedCount = selectableSessions.filter((session) =>
      selectedSessionKeys.has(getSessionKey(session)),
    ).length;
    const isSelected =
      selectableSessions.length > 0 &&
      selectedCount === selectableSessions.length;

    return {
      checked:
        selectedCount === 0 ? false : isSelected ? true : "indeterminate",
      isSelected,
      selectedCount,
      selectableCount: selectableSessions.length,
    };
  };

  const toggleSessionChecked = (session: SessionMeta, checked: boolean) => {
    if (!isSessionDeletable(session)) return;
    const key = getSessionKey(session);
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const toggleSessionGroupChecked = (
    groupSessions: SessionMeta[],
    checked: boolean,
  ) => {
    const selectableSessions = groupSessions.filter(isSessionDeletable);
    if (selectableSessions.length === 0) return;

    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      selectableSessions.forEach((session) => {
        const sessionKey = getSessionKey(session);
        if (checked) {
          next.add(sessionKey);
        } else {
          next.delete(sessionKey);
        }
      });
      return next;
    });
  };

  const toggleProviderGroup = (providerId: string) => {
    setExpandedProviderGroups((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  const toggleDirectoryGroup = (directoryKey: string) => {
    setExpandedDirectoryGroups((current) => {
      const next = new Set(current);
      if (next.has(directoryKey)) {
        next.delete(directoryKey);
      } else {
        next.add(directoryKey);
      }
      return next;
    });
  };

  const toggleProjectGroup = (projectKey: string) => {
    setExpandedProjectGroups((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  };

  const handleCollapseAllGroups = () => {
    setExpandedProviderGroups(new Set());
    setExpandedDirectoryGroups(new Set());
    setExpandedProjectGroups(new Set());
  };

  const renderSessionItem = (session: SessionMeta) => {
    const sessionKey = getSessionKey(session);
    const isSelected = selectedKey !== null && sessionKey === selectedKey;

    return (
      <SessionItem
        key={sessionKey}
        session={session}
        isSelected={isSelected}
        showSelectionControl={selectionMode && isSessionDeletable(session)}
        searchQuery={search}
        isChecked={selectedSessionKeys.has(sessionKey)}
        onSelect={setSelectedKey}
        onToggleChecked={(checked) => toggleSessionChecked(session, checked)}
      />
    );
  };

  const renderGroupSelectionBadge = (
    selectionState: GroupSelectionState,
    totalCount: number,
    variant: "secondary" | "outline",
  ) => (
    <Badge variant={variant} className="shrink-0 text-xs">
      {selectionMode && selectionState.selectableCount > 0
        ? `${selectionState.selectedCount}/${selectionState.selectableCount}`
        : totalCount}
    </Badge>
  );

  const renderProviderGroupCheckbox = (
    providerGroup: SessionProviderGroup,
    providerLabel: string,
    selectionState: GroupSelectionState,
  ) => {
    if (!selectionMode || selectionState.selectableCount === 0) return null;

    return (
      <Checkbox
        checked={selectionState.checked}
        aria-label={t("sessionManager.selectProviderGroupForBatch", {
          defaultValue: "选择 {{provider}} 供应商分组内会话",
          provider: providerLabel,
        })}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() =>
          toggleSessionGroupChecked(
            providerGroup.sessions,
            !selectionState.isSelected,
          )
        }
      />
    );
  };

  const renderDirectoryGroupCheckbox = (
    directoryGroup: SessionDirectoryGroup,
    selectionState: GroupSelectionState,
  ) => {
    if (!selectionMode || selectionState.selectableCount === 0) return null;

    return (
      <Checkbox
        checked={selectionState.checked}
        aria-label={t("sessionManager.selectDirectoryGroupForBatch", {
          defaultValue: "选择 {{directory}} 目录分组内会话",
          directory: directoryGroup.label,
        })}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() =>
          toggleSessionGroupChecked(
            directoryGroup.sessions,
            !selectionState.isSelected,
          )
        }
      />
    );
  };

  const renderProjectGroupCheckbox = (
    projectGroup: SessionProjectGroup,
    selectionState: GroupSelectionState,
  ) => {
    if (!selectionMode || selectionState.selectableCount === 0) return null;

    return (
      <Checkbox
        checked={selectionState.checked}
        aria-label={t("sessionManager.selectProjectGroupForBatch", {
          defaultValue: "选择 {{project}} 项目分组内会话",
          project: projectGroup.label,
        })}
        onClick={(event) => event.stopPropagation()}
        onCheckedChange={() =>
          toggleSessionGroupChecked(
            projectGroup.sessions,
            !selectionState.isSelected,
          )
        }
      />
    );
  };

  const handleToggleSelectAll = () => {
    setSelectedSessionKeys((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        deletableFilteredSessions.forEach((session) =>
          next.delete(getSessionKey(session)),
        );
      } else {
        deletableFilteredSessions.forEach((session) =>
          next.add(getSessionKey(session)),
        );
      }
      return next;
    });
  };

  const openBatchDeleteDialog = () => {
    if (selectedDeletableSessions.length === 0) return;
    setDeleteTargets(selectedDeletableSessions);
  };

  return (
    <TooltipProvider>
      <div
        className="mx-auto px-4 sm:px-6 flex flex-col h-full min-h-0"
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {appId === "pi" &&
            piSessionDiscovery.data?.status === "requires_project_context" && (
              <div
                role="status"
                className="flex shrink-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("sessionManager.piRelativeSessionDir")}{" "}
                  <code>{piSessionDiscovery.data.configuredPath}</code>
                </span>
              </div>
            )}
          {appId === "pi" &&
            (piSessionDiscovery.data?.status === "unavailable" ||
              piSessionDiscovery.isError) && (
              <div
                role="alert"
                className="flex shrink-0 items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {t("sessionManager.piDiscoveryUnavailable", {
                    error:
                      piSessionDiscovery.data?.status === "unavailable"
                        ? piSessionDiscovery.data.reason
                        : extractErrorMessage(piSessionDiscovery.error),
                  })}
                </span>
              </div>
            )}
          {/* 主内容区域 - 左右分栏 */}
          <div className="flex-1 overflow-hidden grid gap-4 md:grid-cols-[320px_1fr]">
            {/* 左侧会话列表 */}
            <Card className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <CardHeader className="py-2 px-3 border-b">
                {isSearchOpen ? (
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                      <Input
                        ref={searchInputRef}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={t("sessionManager.searchPlaceholder")}
                        className="h-8 pl-8 pr-8 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setIsSearchOpen(false);
                            setSearch("");
                          }
                        }}
                        onBlur={() => {
                          if (search.trim() === "") {
                            setIsSearchOpen(false);
                          }
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 -translate-y-1/2 size-6"
                        onClick={() => {
                          setIsSearchOpen(false);
                          setSearch("");
                        }}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                    {selectionMode && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="secondary"
                            size="icon"
                            className="size-7 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60"
                            aria-label={t(
                              "sessionManager.exitBatchModeTooltip",
                              {
                                defaultValue: "退出批量管理",
                              },
                            )}
                            onClick={exitSelectionMode}
                          >
                            <CheckSquare className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("sessionManager.exitBatchModeTooltip", {
                            defaultValue: "退出批量管理",
                          })}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                      <div className="flex items-center gap-2">
                        <CardTitle className="text-sm font-medium whitespace-nowrap">
                          {t("sessionManager.sessionList")}
                        </CardTitle>
                        <Badge
                          variant="secondary"
                          className="shrink-0 text-xs tabular-nums"
                        >
                          {filteredSessions.length}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-label={t(
                                "sessionManager.newSessionTooltip",
                                {
                                  defaultValue: "新建会话",
                                },
                              )}
                              onClick={() => setNewSessionOpen(true)}
                            >
                              <Plus className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.newSessionTooltip", {
                              defaultValue: "新建会话",
                            })}
                          </TooltipContent>
                        </Tooltip>
                        {(selectionMode ||
                          deletableFilteredSessions.length > 0) && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant={selectionMode ? "secondary" : "ghost"}
                                size="icon"
                                className={
                                  selectionMode
                                    ? "size-7 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/60"
                                    : "size-7"
                                }
                                aria-label={
                                  selectionMode
                                    ? t("sessionManager.exitBatchModeTooltip", {
                                        defaultValue: "退出批量管理",
                                      })
                                    : t("sessionManager.manageBatchTooltip", {
                                        defaultValue: "批量管理",
                                      })
                                }
                                onClick={() => {
                                  if (selectionMode) {
                                    exitSelectionMode();
                                  } else {
                                    setSelectionMode(true);
                                  }
                                }}
                              >
                                <CheckSquare className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {selectionMode
                                ? t("sessionManager.exitBatchModeTooltip", {
                                    defaultValue: "退出批量管理",
                                  })
                                : t("sessionManager.manageBatchTooltip", {
                                    defaultValue: "批量管理",
                                  })}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {filteredSessions.length > 0 && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label={t(
                                  "sessionManager.staleCleanupTooltip",
                                  {
                                    defaultValue: "清理闲置会话",
                                  },
                                )}
                                onClick={() => setStaleCleanupOpen(true)}
                              >
                                <CalendarClock className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t("sessionManager.staleCleanupTooltip", {
                                defaultValue: "清理闲置会话",
                              })}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Select
                          value={listViewMode}
                          onValueChange={(value) =>
                            setListViewMode(value as SessionListViewMode)
                          }
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <SelectTrigger
                                className="size-7 p-0 justify-center border-0 bg-transparent hover:bg-muted"
                                aria-label={t(
                                  "sessionManager.viewModeTooltip",
                                  {
                                    defaultValue: "查看方式",
                                  },
                                )}
                              >
                                <span className="sr-only">
                                  {t("sessionManager.viewModeTooltip", {
                                    defaultValue: "查看方式",
                                  })}
                                </span>
                                {listViewMode === "byProject" ? (
                                  <FolderTree className="size-3.5" />
                                ) : listViewMode === "grouped" ? (
                                  <ListTree className="size-3.5" />
                                ) : (
                                  <List className="size-3.5" />
                                )}
                              </SelectTrigger>
                            </TooltipTrigger>
                            <TooltipContent>{listViewModeLabel}</TooltipContent>
                          </Tooltip>
                          <SelectContent className="w-40">
                            <SelectItem value="flat">
                              <div className="flex items-center gap-2">
                                <List className="size-3.5" />
                                <span>
                                  {t("sessionManager.viewModeFlat", {
                                    defaultValue: "列表",
                                  })}
                                </span>
                              </div>
                            </SelectItem>
                            <SelectItem value="grouped">
                              <div className="flex items-center gap-2">
                                <ListTree className="size-3.5" />
                                <span>
                                  {t("sessionManager.viewModeGrouped", {
                                    defaultValue: "分类",
                                  })}
                                </span>
                              </div>
                            </SelectItem>
                            <SelectItem value="byProject">
                              <div className="flex items-center gap-2">
                                <FolderTree className="size-3.5" />
                                <span>
                                  {t("sessionManager.viewModeByProject", {
                                    defaultValue: "项目",
                                  })}
                                </span>
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        {isGroupedListView && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label={t(
                                  "sessionManager.collapseAllGroups",
                                  {
                                    defaultValue: "全部收起",
                                  },
                                )}
                                onClick={handleCollapseAllGroups}
                              >
                                <ChevronsDownUp className="size-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t("sessionManager.collapseAllGroups", {
                                defaultValue: "全部收起",
                              })}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => {
                                setIsSearchOpen(true);
                                setTimeout(
                                  () => searchInputRef.current?.focus(),
                                  0,
                                );
                              }}
                            >
                              <Search className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.searchSessions")}
                          </TooltipContent>
                        </Tooltip>

                        <Select
                          value={providerFilter}
                          onValueChange={(value) =>
                            setProviderFilter(value as ProviderFilter)
                          }
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <SelectTrigger
                                className="size-7 p-0 justify-center border-0 bg-transparent hover:bg-muted"
                                aria-label={t(
                                  "sessionManager.providerFilterTooltip",
                                  {
                                    defaultValue: "供应商筛选",
                                  },
                                )}
                              >
                                <span className="sr-only">
                                  {t("sessionManager.providerFilterTooltip", {
                                    defaultValue: "供应商筛选",
                                  })}
                                </span>
                                <ProviderIcon
                                  icon={
                                    providerFilter === "all"
                                      ? "apps"
                                      : getProviderIconName(providerFilter)
                                  }
                                  name={providerFilter}
                                  size={14}
                                />
                              </SelectTrigger>
                            </TooltipTrigger>
                            <TooltipContent>
                              {providerFilter === "all"
                                ? t("sessionManager.providerFilterAll")
                                : providerFilter}
                            </TooltipContent>
                          </Tooltip>
                          <SelectContent>
                            <SelectItem value="all">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="apps"
                                  name="all"
                                  size={14}
                                />
                                <span>
                                  {t("sessionManager.providerFilterAll")}
                                </span>
                              </div>
                            </SelectItem>
                            <SelectItem value="cursor">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon={getProviderIconName("cursor")}
                                  name="cursor"
                                  size={14}
                                />
                                <span>Cursor</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="codex">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="openai"
                                  name="codex"
                                  size={14}
                                />
                                <span>Codex</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="grokbuild">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="grok"
                                  name="grokbuild"
                                  size={14}
                                />
                                <span>Grok Build</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="claude">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="claude"
                                  name="claude"
                                  size={14}
                                />
                                <span>Claude Code</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="opencode">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="opencode"
                                  name="opencode"
                                  size={14}
                                />
                                <span>OpenCode</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="openclaw">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="openclaw"
                                  name="openclaw"
                                  size={14}
                                />
                                <span>OpenClaw</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="gemini">
                              <div className="flex items-center gap-2">
                                <ProviderIcon
                                  icon="gemini"
                                  name="gemini"
                                  size={14}
                                />
                                <span>Gemini CLI</span>
                              </div>
                            </SelectItem>
                            <SelectItem value="pi">
                              <div className="flex items-center gap-2">
                                <ProviderIcon icon="pi" name="pi" size={14} />
                                <span>Pi</span>
                              </div>
                            </SelectItem>
                          </SelectContent>
                        </Select>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              onClick={() => {
                                void refetch();
                                if (providerFilter === "cursor") {
                                  void cursorSessionIndex.refresh();
                                }
                              }}
                            >
                              <RefreshCw className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{t("common.refresh")}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    {selectionMode && (
                      <div className="grid gap-3 rounded-md border bg-muted/40 px-3 py-2.5">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-xs">
                            {t("sessionManager.selectedCount", {
                              defaultValue: "已选 {{count}} 项",
                              count: selectedDeletableSessions.length,
                            })}
                          </Badge>
                          <span className="truncate">
                            {t("sessionManager.batchModeHint", {
                              defaultValue: "勾选要删除的会话",
                            })}
                          </span>
                        </div>
                        <div className="grid gap-3 min-[520px]:grid-cols-[minmax(0,1fr)_auto] min-[520px]:items-center">
                          <div className="flex flex-wrap items-center gap-2">
                            {deletableFilteredSessions.length > 0 && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2.5 text-xs whitespace-nowrap"
                                onClick={handleToggleSelectAll}
                              >
                                {allFilteredSelected
                                  ? t("sessionManager.clearFilteredSelection", {
                                      defaultValue: "取消全选",
                                    })
                                  : t("sessionManager.selectAllFiltered", {
                                      defaultValue: "全选当前",
                                    })}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2.5 text-xs whitespace-nowrap"
                              onClick={() => setSelectedSessionKeys(new Set())}
                            >
                              {t("sessionManager.clearSelection", {
                                defaultValue: "清空已选",
                              })}
                            </Button>
                          </div>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 gap-1.5 px-2.5 whitespace-nowrap justify-self-start min-[520px]:justify-self-end"
                            onClick={openBatchDeleteDialog}
                            disabled={
                              isDeleting ||
                              selectedDeletableSessions.length === 0
                            }
                          >
                            <Trash2 className="size-3.5" />
                            <span className="text-xs">
                              {isBatchDeleting
                                ? t("sessionManager.batchDeleting", {
                                    defaultValue: "删除中...",
                                  })
                                : t("sessionManager.deleteSelected", {
                                    defaultValue: "批量删除",
                                  })}
                            </span>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1 min-h-0 p-0">
                <ScrollArea className="h-full">
                  <div className="p-2">
                    {isLoading ||
                    (providerFilter === "cursor" &&
                      cursorSessionIndex.isLoading) ? (
                      <div className="flex items-center justify-center py-12">
                        <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredSessions.length === 0 ? (
                      cursorIndexUnavailableReason ? (
                        <div
                          role="alert"
                          className="mx-2 my-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-amber-800 dark:text-amber-200"
                        >
                          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                          <div className="min-w-0 space-y-1">
                            <p className="text-sm font-medium">
                              {t("sessionManager.cursorIndexUnavailable", {
                                defaultValue: "Cursor 会话索引不可用",
                              })}
                            </p>
                            <p className="break-words text-xs">
                              {cursorIndexUnavailableReason}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                          <p className="text-sm text-muted-foreground">
                            {t("sessionManager.noSessions")}
                          </p>
                        </div>
                      )
                    ) : listViewMode === "grouped" ? (
                      <div className="space-y-2">
                        {groupedSessions.map((providerGroup) => {
                          const providerOpen = expandedProviderGroups.has(
                            providerGroup.providerId,
                          );
                          const providerLabel = getProviderLabel(
                            providerGroup.providerId,
                            t,
                          );
                          const providerSelectionState = getGroupSelectionState(
                            providerGroup.sessions,
                          );

                          return (
                            <Collapsible
                              key={providerGroup.providerId}
                              open={providerOpen}
                              onOpenChange={() =>
                                toggleProviderGroup(providerGroup.providerId)
                              }
                            >
                              <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-2 transition-colors hover:bg-muted">
                                {renderProviderGroupCheckbox(
                                  providerGroup,
                                  providerLabel,
                                  providerSelectionState,
                                )}
                                <CollapsibleTrigger asChild>
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    aria-label={t(
                                      "sessionManager.toggleProviderGroup",
                                      {
                                        defaultValue:
                                          "展开或折叠 {{provider}} 供应商分组",
                                        provider: providerLabel,
                                      },
                                    )}
                                  >
                                    {providerOpen ? (
                                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <ProviderIcon
                                      icon={getProviderIconName(
                                        providerGroup.providerId,
                                      )}
                                      name={providerGroup.providerId}
                                      size={16}
                                    />
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                      {providerLabel}
                                    </span>
                                    {renderGroupSelectionBadge(
                                      providerSelectionState,
                                      providerGroup.sessions.length,
                                      "secondary",
                                    )}
                                  </button>
                                </CollapsibleTrigger>
                              </div>
                              <CollapsibleContent className="mt-1 space-y-1 pl-2">
                                {providerGroup.directories.map(
                                  (directoryGroup) => {
                                    const directoryOpen =
                                      expandedDirectoryGroups.has(
                                        directoryGroup.key,
                                      );
                                    const directorySelectionState =
                                      getGroupSelectionState(
                                        directoryGroup.sessions,
                                      );

                                    return (
                                      <Collapsible
                                        key={directoryGroup.key}
                                        open={directoryOpen}
                                        onOpenChange={() =>
                                          toggleDirectoryGroup(
                                            directoryGroup.key,
                                          )
                                        }
                                      >
                                        <div className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                                          {renderDirectoryGroupCheckbox(
                                            directoryGroup,
                                            directorySelectionState,
                                          )}
                                          <CollapsibleTrigger asChild>
                                            <button
                                              type="button"
                                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                              aria-label={t(
                                                "sessionManager.toggleDirectoryGroup",
                                                {
                                                  defaultValue:
                                                    "展开或折叠 {{directory}} 目录分组",
                                                  directory:
                                                    directoryGroup.label,
                                                },
                                              )}
                                            >
                                              {directoryOpen ? (
                                                <ChevronDown className="size-3.5 shrink-0" />
                                              ) : (
                                                <ChevronRight className="size-3.5 shrink-0" />
                                              )}
                                              <FolderOpen className="size-3.5 shrink-0" />
                                              <Tooltip>
                                                <TooltipTrigger asChild>
                                                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                                                    {directoryGroup.label}
                                                  </span>
                                                </TooltipTrigger>
                                                <TooltipContent
                                                  side="bottom"
                                                  className="max-w-xs"
                                                >
                                                  <p className="font-mono text-xs break-all">
                                                    {directoryGroup.projectDir ??
                                                      t(
                                                        "sessionManager.unknownDirectory",
                                                        {
                                                          defaultValue:
                                                            "未知目录",
                                                        },
                                                      )}
                                                  </p>
                                                </TooltipContent>
                                              </Tooltip>
                                              {renderGroupSelectionBadge(
                                                directorySelectionState,
                                                directoryGroup.sessions.length,
                                                "outline",
                                              )}
                                            </button>
                                          </CollapsibleTrigger>
                                        </div>
                                        <CollapsibleContent className="mt-1 space-y-1 pl-3">
                                          {directoryGroup.sessions.map(
                                            (session) =>
                                              renderSessionItem(session),
                                          )}
                                        </CollapsibleContent>
                                      </Collapsible>
                                    );
                                  },
                                )}
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        })}
                      </div>
                    ) : listViewMode === "byProject" ? (
                      <div className="space-y-2">
                        {projectGroupedSessions.map((projectGroup) => {
                          const projectOpen = expandedProjectGroups.has(
                            projectGroup.key,
                          );
                          const projectSelectionState = getGroupSelectionState(
                            projectGroup.sessions,
                          );

                          return (
                            <Collapsible
                              key={projectGroup.key}
                              open={projectOpen}
                              onOpenChange={() =>
                                toggleProjectGroup(projectGroup.key)
                              }
                            >
                              <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-2.5 py-2 transition-colors hover:bg-muted">
                                {renderProjectGroupCheckbox(
                                  projectGroup,
                                  projectSelectionState,
                                )}
                                <CollapsibleTrigger asChild>
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                    aria-label={t(
                                      "sessionManager.toggleProjectGroup",
                                      {
                                        defaultValue:
                                          "展开或折叠 {{project}} 项目分组",
                                        project: projectGroup.label,
                                      },
                                    )}
                                  >
                                    {projectOpen ? (
                                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                    ) : (
                                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                    )}
                                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                          {projectGroup.label}
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="bottom"
                                        className="max-w-xs"
                                      >
                                        {projectGroup.workspaceDirs.length >
                                        0 ? (
                                          <div className="space-y-1">
                                            {projectGroup.workspaceDirs.map(
                                              (workspaceDir) => (
                                                <p
                                                  key={workspaceDir}
                                                  className="font-mono text-xs break-all"
                                                >
                                                  {workspaceDir}
                                                </p>
                                              ),
                                            )}
                                          </div>
                                        ) : (
                                          <p className="font-mono text-xs break-all">
                                            {projectGroup.projectDir ??
                                              unknownDirectoryLabel}
                                          </p>
                                        )}
                                      </TooltipContent>
                                    </Tooltip>
                                    <div className="flex shrink-0 items-center gap-0.5">
                                      {projectGroup.providerIds.map(
                                        (providerId) => (
                                          <ProviderIcon
                                            key={providerId}
                                            icon={getProviderIconName(
                                              providerId,
                                            )}
                                            name={providerId}
                                            size={12}
                                          />
                                        ),
                                      )}
                                    </div>
                                    {renderGroupSelectionBadge(
                                      projectSelectionState,
                                      projectGroup.sessions.length,
                                      "secondary",
                                    )}
                                  </button>
                                </CollapsibleTrigger>
                              </div>
                              <CollapsibleContent className="mt-1 space-y-1 pl-2">
                                {projectGroup.sessions.map((session) =>
                                  renderSessionItem(session),
                                )}
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {filteredSessions.map((session) =>
                          renderSessionItem(session),
                        )}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* 右侧会话详情 */}
            <Card
              className="flex flex-col overflow-hidden min-h-0"
              ref={detailRef}
            >
              {!selectedSession ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
                  <MessageSquare className="size-12 mb-3 opacity-30" />
                  <p className="text-sm">{t("sessionManager.selectSession")}</p>
                </div>
              ) : (
                <>
                  {/* 详情头部 */}
                  <CardHeader className="py-3 px-4 border-b shrink-0">
                    <div className="flex items-start justify-between gap-4">
                      {/* 左侧：会话信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="shrink-0">
                                <ProviderIcon
                                  icon={getProviderIconName(
                                    selectedSession.providerId,
                                  )}
                                  name={selectedSession.providerId}
                                  size={20}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {getProviderLabel(selectedSession.providerId, t)}
                            </TooltipContent>
                          </Tooltip>
                          <h2 className="text-base font-semibold truncate">
                            {formatSessionTitle(selectedSession)}
                          </h2>
                        </div>

                        {/* 元信息 */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="size-3" />
                            <span>
                              {formatTimestamp(
                                selectedSession.lastActiveAt ??
                                  selectedSession.createdAt,
                              )}
                            </span>
                          </div>
                          {selectedSession.projectDir && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopy(
                                      selectedSession.projectDir!,
                                      t("sessionManager.projectDirCopied"),
                                    )
                                  }
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                >
                                  <FolderOpen className="size-3" />
                                  <span className="truncate max-w-[200px]">
                                    {getBaseName(selectedSession.projectDir)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-xs"
                              >
                                <p className="font-mono text-xs break-all">
                                  {selectedSession.projectDir}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                  {t("sessionManager.clickToCopyPath")}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {selectedSession.sourcePath && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopy(
                                      selectedSession.sourcePath!,
                                      t("sessionManager.sourcePathCopied"),
                                    )
                                  }
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                >
                                  <FileText className="size-3 shrink-0" />
                                  <span className="font-mono truncate max-w-[200px]">
                                    {getBaseName(selectedSession.sourcePath)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-xs"
                              >
                                <p className="font-mono text-xs break-all">
                                  {selectedSession.sourcePath}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                  {t("sessionManager.clickToCopyPath")}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>

                      {/* 右侧：操作按钮组 */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isMac() ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => {
                                  if (isCursorSession) {
                                    cursorPrimaryAction?.onClick();
                                    return;
                                  }
                                  void handleResume();
                                }}
                                disabled={
                                  isCursorSession
                                    ? !cursorPrimaryAction ||
                                      cursorPrimaryAction.disabled
                                    : !selectedSession.resumeCommand
                                }
                              >
                                <Play className="size-3.5" />
                                <span className="hidden sm:inline">
                                  {isCursorSession
                                    ? (cursorPrimaryAction?.label ??
                                      t("sessionManager.resume", {
                                        defaultValue: "恢复会话",
                                      }))
                                    : t(resumeCopy.labelKey)}
                                </span>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {isCursorSession
                                ? cursorPrimaryAction
                                  ? t(resumeCopy.tooltipKey)
                                  : t("sessionManager.noResumeCommand", {
                                      defaultValue: "此会话无法恢复",
                                    })
                                : selectedSession.resumeCommand
                                  ? t(resumeCopy.tooltipKey)
                                  : t("sessionManager.noResumeCommand", {
                                      defaultValue: "此会话无法恢复",
                                    })}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                        {isSessionDeletable(selectedSession) ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="gap-1.5"
                                onClick={() =>
                                  setDeleteTargets([selectedSession])
                                }
                                disabled={isDeleting}
                              >
                                <Trash2 className="size-3.5" />
                                <span className="hidden sm:inline">
                                  {isDeleting
                                    ? t("sessionManager.deleting", {
                                        defaultValue: "删除中...",
                                      })
                                    : t("sessionManager.delete", {
                                        defaultValue: "删除会话",
                                      })}
                                </span>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t("sessionManager.deleteTooltip", {
                                defaultValue: "永久删除此本地会话记录",
                              })}
                            </TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    </div>

                    {/* 恢复命令预览 */}
                    {headerResumeCommand ? (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex-1 rounded-md bg-muted/60 px-3 py-1.5 font-mono text-xs text-muted-foreground truncate">
                          {headerResumeCommand}
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              onClick={() =>
                                void handleCopy(
                                  headerResumeCommand,
                                  t("sessionManager.resumeCommandCopied"),
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.copyCommand", {
                              defaultValue: "复制命令",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    ) : null}
                  </CardHeader>

                  <CardContent className="flex-1 min-h-0 p-0 flex flex-col">
                    {isCursorSession ? (
                      <CursorResumeGate
                        session={selectedSession}
                        appearance={resumeState?.appearance}
                        onPrimaryActionChange={setCursorPrimaryAction}
                        onResumeCommandChange={setCursorResumeCommand}
                      />
                    ) : null}
                    <div className="flex min-h-0 flex-1 min-w-0">
                      {/* 消息列表 */}
                      <div className="flex-1 min-w-0 flex flex-col">
                        <div className="px-4 pt-4 pb-2 min-w-0">
                          <div className="flex items-center gap-2">
                            <MessageSquare className="size-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              {t("sessionManager.conversationHistory", {
                                defaultValue: "对话记录",
                              })}
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {displayMessages.length}
                            </Badge>
                          </div>
                        </div>
                        <div
                          ref={scrollContainerRef}
                          className="flex-1 overflow-y-auto px-4 pb-4 min-w-0"
                        >
                          {isLoadingMessages ? (
                            <div className="flex items-center justify-center py-12">
                              <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                            </div>
                          ) : displayMessages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                              <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                              <p className="text-sm text-muted-foreground">
                                {t("sessionManager.emptySession")}
                              </p>
                            </div>
                          ) : (
                            <div
                              style={{
                                height: virtualizer.getTotalSize(),
                                position: "relative",
                              }}
                            >
                              {virtualizer
                                .getVirtualItems()
                                .map((virtualRow) => (
                                  <div
                                    key={virtualRow.key}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                      position: "absolute",
                                      top: 0,
                                      left: 0,
                                      width: "100%",
                                      transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                  >
                                    <SessionMessageItem
                                      message={
                                        displayMessages[virtualRow.index]
                                      }
                                      isActive={
                                        activeMessageIndex === virtualRow.index
                                      }
                                      searchQuery={search}
                                      onCopy={handleMessageCopy}
                                    />
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* 右侧目录 - 类似少数派 (大屏幕) */}
                      <SessionTocSidebar
                        items={userMessagesToc}
                        onItemClick={scrollToMessage}
                      />
                    </div>

                    {/* 浮动目录按钮 (小屏幕) */}
                    <SessionTocDialog
                      items={userMessagesToc}
                      onItemClick={scrollToMessage}
                      open={tocDialogOpen}
                      onOpenChange={setTocDialogOpen}
                    />
                  </CardContent>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
      <NewSessionDialog
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        sessions={sessions}
        selectedSession={selectedSession}
        providerFilter={providerFilter}
        onLaunch={(launch) => {
          setNewSessionOpen(false);
          void (async () => {
            if (!isMac()) {
              await handleCopy(
                launch.command,
                t("sessionManager.resumeCommandCopied", {
                  defaultValue: "已复制恢复命令",
                }),
              );
              return;
            }
            try {
              const result = await sessionsApi.launchTerminal({
                command: launch.command,
                cwd: launch.cwd,
              });
              if (result?.action === "launched") {
                toast.success(
                  t("sessionManager.terminalLaunched", {
                    defaultValue: "终端已启动",
                  }),
                );
              }
            } catch (error) {
              await handleCopy(
                launch.command,
                t("sessionManager.resumeFallbackCopied", {
                  defaultValue: "已复制命令，请手动在终端中执行",
                }),
              );
              toast.error(
                extractErrorMessage(error) ||
                  t("sessionManager.openFailed", {
                    defaultValue: "打开失败",
                  }),
              );
            }
          })();
        }}
      />
      <StaleSessionCleanupDialog
        open={staleCleanupOpen}
        onOpenChange={setStaleCleanupOpen}
        sessions={filteredSessions}
        initialDays={staleCleanupDays}
        onConfirm={(targets, days) => {
          setStaleCleanupDays(days);
          setStaleCleanupOpen(false);
          setDeleteTargets(targets);
        }}
      />
      <ConfirmDialog
        isOpen={Boolean(deleteTargets)}
        title={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmTitle", {
                defaultValue: "批量删除会话",
              })
            : t("sessionManager.deleteConfirmTitle", {
                defaultValue: "删除会话",
              })
        }
        message={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmMessage", {
                defaultValue:
                  "将永久删除已选中的 {{count}} 个本地会话记录。\n\n此操作不可恢复。",
                count: deleteTargets.length,
              })
            : deleteTargets?.[0]
              ? t("sessionManager.deleteConfirmMessage", {
                  defaultValue:
                    "将永久删除本地会话“{{title}}”\nSession ID: {{sessionId}}\n\n此操作不可恢复。",
                  title: formatSessionTitle(deleteTargets[0]),
                  sessionId: deleteTargets[0].sessionId,
                })
              : ""
        }
        confirmText={
          deleteTargets && deleteTargets.length > 1
            ? t("sessionManager.batchDeleteConfirmAction", {
                defaultValue: "删除所选会话",
              })
            : t("sessionManager.deleteConfirmAction", {
                defaultValue: "删除会话",
              })
        }
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        variant="destructive"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => {
          if (!isDeleting) {
            setDeleteTargets(null);
          }
        }}
      />
    </TooltipProvider>
  );
}

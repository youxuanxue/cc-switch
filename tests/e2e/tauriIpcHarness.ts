import type { Page } from "@playwright/test";

type CursorAuthMode = "login" | "userApiKey";
type CursorRuntimeState =
  | "ready"
  | "needsLogin"
  | "needsApiKey"
  | "cliMissing"
  | "statusUnavailable";

interface CursorOfficialStatus {
  installed: boolean;
  version?: string;
  authMode: CursorAuthMode;
  hasUserApiKey: boolean;
  authenticated: boolean;
  state: CursorRuntimeState;
  error?: string;
}

interface SessionFixture {
  providerId: string;
  sessionId: string;
  title?: string;
  summary?: string;
  projectDir?: string | null;
  createdAt?: number;
  lastActiveAt?: number;
  sourcePath?: string;
  resumeCommand?: string;
}

type CursorResumeContext =
  | { workspaceState: "ready"; workspace: string }
  | { workspaceState: "workspaceRequired" };

type CursorIndexStatus =
  | { state: "indexReady" }
  | { state: "indexUnavailable"; reason: string };

export interface RecordedInvoke {
  command: string;
  payloadKeys: string[];
  payload: Record<string, unknown>;
}

export interface TauriIpcHarnessOptions {
  view?: "sessions" | "settings";
  listViewMode?: "flat" | "grouped";
  sessions?: SessionFixture[];
  cursorStatus?: CursorOfficialStatus;
  cursorIndexStatus?: CursorIndexStatus;
  resumeContext?: CursorResumeContext;
  pickedDirectories?: Array<string | null>;
  canonicalWorkspaces?: Record<string, string>;
}

const defaultCursorStatus: CursorOfficialStatus = {
  installed: true,
  version: "agent fixture",
  authMode: "login",
  hasUserApiKey: false,
  authenticated: true,
  state: "ready",
};

export async function installTauriIpcHarness(
  page: Page,
  options: TauriIpcHarnessOptions = {},
): Promise<void> {
  const initialState = {
    view: options.view ?? "sessions",
    listViewMode: options.listViewMode ?? "flat",
    sessions: options.sessions ?? [],
    cursorStatus: options.cursorStatus ?? defaultCursorStatus,
    cursorIndexStatus: options.cursorIndexStatus ?? {
      state: "indexReady" as const,
    },
    resumeContext: options.resumeContext ?? {
      workspaceState: "ready" as const,
      workspace: "/work/acme/default",
    },
    pickedDirectories: options.pickedDirectories ?? [],
    canonicalWorkspaces: options.canonicalWorkspaces ?? {},
  };

  await page.addInitScript((fixture) => {
    type BrowserCallback = (...args: unknown[]) => unknown;
    type BrowserCall = {
      command: string;
      payloadKeys: string[];
      payload: Record<string, unknown>;
    };

    const browserWindow = window as typeof window & {
      isTauri?: boolean;
      __TAURI_INTERNALS__?: Record<string, unknown>;
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>;
      __CC_SWITCH_E2E__?: {
        calls: BrowserCall[];
      };
    };

    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });

    localStorage.setItem("cc-switch-last-view", fixture.view);
    localStorage.setItem("cc-switch-last-app", "claude");
    localStorage.setItem("language", "zh");
    localStorage.setItem(
      "cc-switch.sessionManager.listViewMode",
      fixture.listViewMode,
    );

    const state = {
      settings: {
        showInTray: true,
        minimizeToTrayOnClose: true,
        useAppWindowControls: false,
        enableClaudePluginIntegration: false,
        showProfileSwitcher: false,
        firstRunNoticeConfirmed: true,
        language: "zh",
      },
      sessions: fixture.sessions,
      cursorStatus: { ...fixture.cursorStatus },
      cursorIndexStatus: { ...fixture.cursorIndexStatus },
      resumeContext: fixture.resumeContext,
      pickedDirectories: [...fixture.pickedDirectories],
      canonicalWorkspaces: { ...fixture.canonicalWorkspaces },
      calls: [] as BrowserCall[],
    };

    browserWindow.__CC_SWITCH_E2E__ = { calls: state.calls };

    const callbacks = new Map<
      number,
      { callback: BrowserCallback; once: boolean }
    >();
    const eventListeners = new Map<number, number>();
    let nextCallbackId = 1;
    let nextEventId = 1;

    const transformCallback = (callback?: BrowserCallback, once = false) => {
      const id = nextCallbackId++;
      if (callback) callbacks.set(id, { callback, once });
      return id;
    };

    const unregisterCallback = (id: number) => {
      callbacks.delete(id);
    };

    const runCallback = (id: number, data: unknown) => {
      const entry = callbacks.get(id);
      if (!entry) return;
      entry.callback(data);
      if (entry.once) callbacks.delete(id);
    };

    const cloneForLog = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(cloneForLog);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).flatMap(([key, nested]) =>
            nested === undefined ? [] : [[key, cloneForLog(nested)]],
          ),
        );
      }
      return value;
    };

    const record = (command: string, rawPayload: Record<string, unknown>) => {
      const payloadKeys = Object.keys(rawPayload);
      const payload = Object.fromEntries(
        Object.entries(rawPayload).flatMap(([key, value]) => {
          if (value === undefined) return [];
          return [
            [key, key === "userApiKey" ? "[REDACTED]" : cloneForLog(value)],
          ];
        }),
      );
      state.calls.push({ command, payloadKeys, payload });
    };

    const invoke = async (
      command: string,
      rawPayload: Record<string, unknown> = {},
    ): Promise<unknown> => {
      record(command, rawPayload);

      switch (command) {
        case "plugin:event|listen": {
          const eventId = nextEventId++;
          eventListeners.set(eventId, rawPayload.handler as number);
          return eventId;
        }
        case "plugin:event|unlisten":
          eventListeners.delete(rawPayload.eventId as number);
          return undefined;
        case "plugin:event|emit":
        case "plugin:event|emit_to":
          return undefined;
        case "plugin:path|resolve_directory":
          return "/home/e2e";
        case "plugin:path|join":
        case "plugin:path|resolve":
          return (rawPayload.paths as string[])
            .join("/")
            .replace(/\/{2,}/g, "/");
        case "plugin:path|normalize":
          return rawPayload.path;
        case "plugin:app|version":
          return "3.20.1";
        case "plugin:updater|check":
          return null;
        case "get_init_error":
          return null;
        case "get_settings":
          return { ...state.settings };
        case "is_portable_mode":
          return false;
        case "get_app_config_dir_override":
          return null;
        case "get_config_dir":
          return `/home/e2e/.${String(rawPayload.app ?? "config")}`;
        case "get_providers":
          return {};
        case "get_current_provider":
          return "";
        case "get_proxy_status":
          return { running: false, active_targets: [] };
        case "get_proxy_takeover_status":
          return {};
        case "check_env_conflicts":
          return [];
        case "get_migration_result":
          return false;
        case "get_skills_migration_result":
          return null;
        case "get_installed_skills":
        case "list_profiles":
        case "scan_unmanaged_skills":
          return [];
        case "get_models_dev_sync_config":
          return {
            config: {
              autoSyncEnabled: false,
              includeCommonModels: true,
              selectedModelKeys: [],
              excludedCommonModelKeys: [],
              lastSyncAt: null,
              lastSyncError: null,
            },
            configPath: "/home/e2e/.cc-switch/models-dev.json",
          };
        case "list_sessions":
          return state.sessions.map((session) => ({ ...session }));
        case "get_cursor_official_status":
          return { ...state.cursorStatus };
        case "update_cursor_official_auth": {
          const authMode = rawPayload.authMode as CursorAuthMode;
          state.cursorStatus = {
            ...state.cursorStatus,
            authMode,
            hasUserApiKey:
              authMode === "userApiKey" || state.cursorStatus.hasUserApiKey,
            authenticated: true,
            state: "ready",
          };
          return { ...state.cursorStatus };
        }
        case "clear_cursor_user_api_key":
          state.cursorStatus = {
            ...state.cursorStatus,
            authMode: "userApiKey",
            hasUserApiKey: false,
            authenticated: false,
            state: "needsApiKey",
          };
          return { ...state.cursorStatus };
        case "get_cursor_session_index_status":
          return { ...state.cursorIndexStatus };
        case "get_cursor_session_resume_context": {
          const override = rawPayload.workspaceOverride;
          if (typeof override === "string") {
            const canonical = state.canonicalWorkspaces[override] ?? override;
            return { workspaceState: "ready", workspace: canonical };
          }
          return { ...state.resumeContext };
        }
        case "launch_cursor_session":
        case "launch_cursor_login":
        case "launch_cursor_login_and_session":
          return { state: "launched" };
        case "pick_directory":
          return state.pickedDirectories.shift() ?? null;
        case "plugin:window|is_maximized":
        case "plugin:window|is_minimized":
        case "plugin:window|is_fullscreen":
          return false;
        case "plugin:window|is_focused":
        case "plugin:window|is_decorated":
        case "plugin:window|is_resizable":
        case "plugin:window|is_maximizable":
        case "plugin:window|is_minimizable":
        case "plugin:window|is_closable":
        case "plugin:window|is_visible":
        case "plugin:window|is_enabled":
          return true;
        case "plugin:window|scale_factor":
          return 1;
        case "plugin:window|inner_position":
        case "plugin:window|outer_position":
          return { x: 0, y: 0 };
        case "plugin:window|inner_size":
        case "plugin:window|outer_size":
          return { width: 1200, height: 800 };
        case "plugin:window|theme":
          return null;
        case "plugin:window|title":
          return "CC Switch";
        default:
          if (command.startsWith("plugin:window|")) return undefined;
          if (command.startsWith("list_") || command.startsWith("scan_")) {
            return [];
          }
          return undefined;
      }
    };

    browserWindow.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback,
      unregisterCallback,
      runCallback,
      callbacks,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      convertFileSrc: (filePath: string, protocol = "asset") =>
        `${protocol}://localhost/${encodeURIComponent(filePath)}`,
    };
    browserWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, eventId: number) => {
        const callbackId = eventListeners.get(eventId);
        eventListeners.delete(eventId);
        if (callbackId !== undefined) unregisterCallback(callbackId);
      },
    };
    browserWindow.isTauri = true;
  }, initialState);
}

export async function getRecordedInvokes(
  page: Page,
): Promise<RecordedInvoke[]> {
  return await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __CC_SWITCH_E2E__?: { calls: RecordedInvoke[] };
    };
    return browserWindow.__CC_SWITCH_E2E__?.calls ?? [];
  });
}

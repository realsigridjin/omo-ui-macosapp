/**
 * Contract between the Electron main process, the preload script, and the renderer.
 * The preload script exposes an object satisfying OmoBridgeApi as `window.omo`.
 */
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  ThreadItem,
  TurnError,
  TurnStatus,
  TodoPhase,
  LiveTask,
} from "./protocol";
import type { AndroidStatus } from "./android";
import type { OpencodexAccounts } from "./opencodex";
import type { WorkspaceFile, WorkspaceDocument } from "./workspace";
import type { DeviceOverview } from "./device-overview";
import type { AppUpdateStatus } from "./app-update";
import type { ModelRoutingInput, ModelRoutingSettings } from "./model-routing";

/** URL of the official omo installer script. */
export const OMO_INSTALL_SCRIPT_URL = "https://get.omo.dev/install.sh";

/** The official installer command shown on onboarding and in Settings; `install()` runs the same script from a file. */
export const OMO_INSTALL_COMMAND = `curl -fsSL ${OMO_INSTALL_SCRIPT_URL} | bash` as const;

export const OMO_WINDOWS_INSTALL_SCRIPT_URL = "https://get.omo.dev/install.ps1";
export const OMO_WINDOWS_INSTALL_COMMAND = `irm ${OMO_WINDOWS_INSTALL_SCRIPT_URL} | iex` as const;

export function getOmoInstallCommand(platform: string): typeof OMO_INSTALL_COMMAND | typeof OMO_WINDOWS_INSTALL_COMMAND {
  return platform === "win32" ? OMO_WINDOWS_INSTALL_COMMAND : OMO_INSTALL_COMMAND;
}

export type BridgeState = "locating" | "not-found" | "starting" | "connected" | "exited" | "restarting" | "stopped";

/** Where the omo binary was found, in lookup order. */
export type OmoSource = "override" | "install.json" | "local-bin" | "login-path";

export interface OmoBinary {
  path: string;
  version: string;
  source: OmoSource;
}

export type OmoUpdateStatus =
  | { state: "checking" | "installing" | "current" | "disabled" }
  | { state: "updated"; from: string; to: string }
  | { state: "failed"; message: string };

export interface BridgeStatus {
  state: BridgeState;
  omo: OmoBinary | null;
  /** userAgent from the initialize response while connected. */
  userAgent: string | null;
  /** Human-readable reason for the not-found, exited, and restarting states. */
  message: string | null;
  /** Last 4 KB of the omo child's stderr after an unexpected exit. */
  stderrTail: string | null;
  exitCode: number | null;
  /** Consecutive automatic restart attempts since the last successful connection. */
  restartAttempt: number;
  installCommand: typeof OMO_INSTALL_COMMAND | typeof OMO_WINDOWS_INSTALL_COMMAND;
  /** Result of this app launch's automatic update, independent of connection failures. */
  update?: OmoUpdateStatus;
}

export interface Diagnostics {
  omo: OmoBinary | null;
  childPid: number | null;
  /** PATH value passed to the omo child. */
  childPath: string | null;
  /** True when the login-shell environment resolved; false when the fallback environment was used. */
  loginShellEnv: boolean;
  appVersion: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
}

export type ThemePreference = "system" | "light" | "dark";
export type LocalePreference = "system" | "en" | "ko";

export type ModelProfile = "daily-normal" | "daily-heavy" | "geeky-normal" | "geeky-heavy";

export interface Preferences {
  /** Automatic native omo updates on app launch; omitted in older preferences means enabled. */
  omoAutoUpdate?: boolean;
  theme: ThemePreference;
  locale: LocalePreference;
  /** Workspace directory used for the last new session. */
  lastWorkspace: string | null;
  /** Most recent workspace directories, newest first, at most 10 entries. */
  recentWorkspaces: string[];
  /** Model id chosen in the composer, or null for the omo default. */
  modelId: string | null;
  modelProfile?: ModelProfile | null;
  profileModels?: Partial<Record<ModelProfile, string>>;
}

/** One turn reconstructed from a session JSONL file. */
export interface HistoryTurn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  items: ThreadItem[];
  /** Unix milliseconds. */
  startedAt: number | null;
  /** Unix milliseconds. */
  completedAt: number | null;
}

export interface HistoricalTask {
  task_id: string;
  status: string;
  source: "history";
  mode?: string;
  task_summary?: string;
  name?: string;
  category?: string;
  agent_type?: string;
  execution_mode?: string;
  model?: string;
  final_response?: string;
  error_message?: string;
  final_response_truncated?: boolean;
  error_message_truncated?: boolean;
}

export interface HistoryResult {
  turns: HistoryTurn[];
  todo: { phases: TodoPhase[] } | null;
  tasks: HistoricalTask[];
}

/** Read-only child work from native task records and each child's active session branch. */
export interface TaskWork {
  parentSessionId: string;
  task: LiveTask;
  todo: HistoryResult["todo"];
  activity: string | null;
}

export interface InstallLogLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface InstallResult {
  ok: boolean;
  exitCode: number | null;
}

export interface ProxySettings {
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelCount: number;
}

export interface ProxyInput {
  baseUrl: string;
  apiKey?: string;
}

export type MenuCommand = "new-session" | "settings" | "toggle-sidebar";

/** Where the header's Open button can open a thread's workspace; `finder` is always available. */
export const OPEN_TARGET_IDS = ["vscode", "cursor", "terminal", "finder"] as const;
export type OpenTargetId = (typeof OPEN_TARGET_IDS)[number];

export interface OpenTarget {
  id: OpenTargetId;
}

export interface IphoneStatus {
  enabled: boolean;
  state: "searching" | "connecting" | "connected";
  devices: { id: number; name: string; serial: string; state: "connecting" | "connected"; pendingApproval: boolean }[];
}

/** Identifies the user message a branch is cut at: its text and how many earlier user messages carry the same text. */
export interface BranchPoint {
  /** The message's text inputs joined with "\n", as the conversation item holds them. */
  text: string;
  /** 0 for the first user message with this text on the active branch, 1 for the second, and so on. */
  occurrence: number;
}

/** The session file a branch wrote; `threadId` is its session id. */
export interface BranchResult {
  threadId: string;
  path: string;
}

/** Subscription providers whose stored accounts report usage windows. */
export const USAGE_PROVIDERS = ["anthropic-subscription", "chatgpt-subscription"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

/** One usage window, such as Claude's 5-hour window; `percent` is the share used, null when uncapped. */
export interface UsageWindow {
  label: string;
  percent: number | null;
  resetsAt: string | null;
  limited: boolean;
}

/**
 * Usage of one stored subscription account, read with its own token in the main process; no secret crosses IPC.
 * `state` is "expired" when the stored token is past its expiry (omo renews it the next time it uses the account).
 */
export interface AccountUsage {
  provider: UsageProvider;
  account: string;
  email: string | null;
  plan: string | null;
  windows: UsageWindow[];
  state: "ok" | "expired" | "failed";
  message: string | null;
}

export interface OmoBridgeApi {
  readModelRouting(): Promise<ModelRoutingSettings>;
  saveModelRouting(input: ModelRoutingInput): Promise<ModelRoutingSettings>;
  importExistingMcpConfigs(): Promise<{ imported: string[]; sources: number }>;
  readConfiguredMcpServers(): Promise<Array<{ name: string; enabled: boolean; type: string }>>;
  getAppUpdateStatus(): Promise<AppUpdateStatus>;
  checkAppUpdate(): Promise<AppUpdateStatus>;
  installAppUpdate(): Promise<AppUpdateStatus>;
  onAppUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void;
  getDeviceOverview(): Promise<DeviceOverview>;
  listWorkspaceFiles(cwd: string): Promise<WorkspaceFile[]>;
  readWorkspaceFile(cwd: string, relativePath: string): Promise<WorkspaceDocument>;
  getWorkspaceDiff(cwd: string, relativePath: string): Promise<string>;
  importMcpConfig(): Promise<{ imported: string[] } | null>;
  readOpencodexAccounts(): Promise<OpencodexAccounts>;
  getAndroidStatus(): Promise<AndroidStatus>;
  refreshAndroid(): Promise<AndroidStatus>;
  connectAndroid(serial: string): Promise<AndroidStatus>;
  disconnectAndroid(): Promise<AndroidStatus>;
  onAndroidStatus(listener: (status: AndroidStatus) => void): () => void;
  getProxySettings(): Promise<ProxySettings>;
  applyProxySettings(input: ProxyInput): Promise<ProxySettings>;
  /** Reads every stored subscription account's usage windows; one failing account never blanks the others. */
  readAccountUsage(): Promise<AccountUsage[]>;
  /** Opens omo in Terminal running its own sign-in command for `provider` ("/claude-account add", "/gpt-account add", else "/login"). */
  openAccountLogin(provider: string): Promise<void>;
  getIphoneStatus(): Promise<IphoneStatus>;
  onIphoneStatus(listener: (status: IphoneStatus) => void): () => void;
  getStatus(): Promise<BridgeStatus>;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
  /** Sends one app-server request; rejects with Error("<code>: <message>") on an RPC error or when not connected. */
  request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>>;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
  /** Answers a server request (approval or user input) with a JSON-RPC result carrying the same id. */
  respond(id: RequestId, result: unknown): Promise<void>;
  /** Re-locates omo and restarts the app-server child. */
  restart(): Promise<void>;
  /** Downloads and runs the official installer script in a login shell, streams output through onInstallLog, and restarts the bridge on success. */
  install(): Promise<InstallResult>;
  onInstallLog(listener: (line: InstallLogLine) => void): () => void;
  /** Parses the session JSONL at sessionPath, which must resolve inside the omo sessions directory. */
  loadHistory(sessionPath: string): Promise<HistoryResult>;
  /** Reads only tasks reachable through explicit child-session links in this workspace's native task store. */
  loadTaskWork(cwd: string, parentSessionId: string): Promise<TaskWork[]>;
  /**
   * Writes a new session beside `sessionPath` (which must resolve inside the omo sessions directory) holding that
   * session's active branch up to, but excluding, the user message at `point`; the source session is not modified.
   */
  branchSession(sessionPath: string, point: BranchPoint): Promise<BranchResult>;
  /** Native folder picker; resolves null on cancel. The OMO_UI_QA_PICK_DIR variable short-circuits the dialog. */
  pickDirectory(defaultPath?: string | null): Promise<string | null>;
  pickImages(): Promise<string[]>;
  imageFilePath(file: File): string;
  /** Writes a PNG/JPEG/GIF/WebP data URL under userData/attachments and resolves its absolute path. */
  saveImage(dataUrl: string): Promise<string>;
  getDiagnostics(): Promise<Diagnostics>;
  getPreferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  /** Installed Open targets in preference order (editors, Terminal, then Finder). */
  listOpenTargets(): Promise<OpenTarget[]>;
  /** Opens `cwd` (an absolute, existing directory) in `target`; with no target, the first installed editor, else Finder. Resolves the target used. */
  openWorkspace(cwd: string, target?: OpenTargetId | null): Promise<OpenTargetId>;
  readonly platform: string;
}

/** IPC channel names. Invoke channels use ipcRenderer.invoke; event channels use webContents.send. */
export const IPC = {
  readModelRouting: "models:read-routing",
  saveModelRouting: "models:save-routing",
  importExistingMcpConfigs: "mcp:import-existing",
  readConfiguredMcpServers: "mcp:configured",
  getAppUpdateStatus: "app-update:get-status",
  checkAppUpdate: "app-update:check",
  installAppUpdate: "app-update:install",
  appUpdateStatus: "app-update:status",
  getDeviceOverview: "devices:overview",
  listWorkspaceFiles: "workspace:list-files",
  readWorkspaceFile: "workspace:read-file",
  getWorkspaceDiff: "workspace:diff",
  importMcpConfig: "mcp:import-config",
  readOpencodexAccounts: "accounts:opencodex",
  getAndroidStatus: "android:get-status",
  refreshAndroid: "android:refresh",
  connectAndroid: "android:connect",
  disconnectAndroid: "android:disconnect",
  androidStatus: "android:status",
  getProxySettings: "proxy:get-settings",
  applyProxySettings: "proxy:apply-settings",
  getIphoneStatus: "iphone:get-status",
  iphoneStatus: "iphone:status",
  getStatus: "omo:get-status",
  status: "omo:status",
  request: "omo:request",
  notification: "omo:notification",
  serverRequest: "omo:server-request",
  respond: "omo:respond",
  restart: "omo:restart",
  install: "omo:install",
  installLog: "omo:install-log",
  loadHistory: "history:load",
  loadTaskWork: "history:task-work",
  branchSession: "history:branch",
  readAccountUsage: "accounts:usage",
  openAccountLogin: "accounts:login",
  pickDirectory: "dialog:pick-directory",
  pickImages: "dialog:pick-images",
  saveImage: "attachments:save-image",
  diagnostics: "app:diagnostics",
  getPreferences: "prefs:get",
  setPreferences: "prefs:set",
  menuCommand: "menu:command",
  copyText: "app:copy-text",
  openExternal: "app:open-external",
  revealPath: "app:reveal-path",
  listOpenTargets: "app:list-open-targets",
  openWorkspace: "app:open-workspace",
} as const;

/** Result envelope the main process returns from the `omo:request` invoke channel. */
export type RequestEnvelope<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: { code: number; message: string } };

export const ENV = {
  /** Absolute path of the omo binary; when set, no other location is tried. */
  omoBin: "OMO_UI_OMO_BIN",
  /** Directory returned by pickDirectory without opening the native dialog (tests and QA). */
  qaPickDir: "OMO_UI_QA_PICK_DIR",
  /** JSON array of image paths returned without a native dialog. */
  qaPickImages: "OMO_UI_QA_PICK_IMAGES",
  /** Overrides Electron's userData directory (tests and QA). */
  userData: "OMO_UI_USER_DATA",
  /** Renderer dev-server URL loaded instead of dist/index.html. */
  devUrl: "OMO_UI_DEV_URL",
  /** "0" skips the launch-time omo update regardless of the preference (tests and QA). */
  omoAutoUpdate: "OMO_UI_OMO_AUTO_UPDATE",
} as const;

declare global {
  interface Window {
    omo: OmoBridgeApi;
  }
}

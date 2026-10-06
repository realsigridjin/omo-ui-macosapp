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

/** URL of the official omo installer script. */
export const OMO_INSTALL_SCRIPT_URL = "https://get.omo.dev/install.sh";

/** The official installer command shown on onboarding and in Settings; `install()` runs the same script from a file. */
export const OMO_INSTALL_COMMAND = `curl -fsSL ${OMO_INSTALL_SCRIPT_URL} | bash` as const;

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
  installCommand: typeof OMO_INSTALL_COMMAND;
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

/** Accent palettes selectable in Settings → Appearance; "omo" is the built-in default. */
export type ColorTheme = "omo" | "classic" | "mint" | "ocean";
export const COLOR_THEMES: readonly ColorTheme[] = ["omo", "classic", "mint", "ocean"];

export type ModelProfile = "daily-normal" | "daily-heavy" | "geeky-normal" | "geeky-heavy";

/** When macOS notifications fire for threads other than the active one. */
export type ThreadNotificationPreference = "off" | "background" | "always";

/** How every clock time renders; "system" follows the OS clock preference. */
export type TimeFormatPreference = "system" | "12h" | "24h";

export interface Preferences {
  /** Automatic native omo updates on app launch; omitted in older preferences means enabled. */
  omoAutoUpdate?: boolean;
  theme: ThemePreference;
  locale: LocalePreference;
  /** Accent palette applied on top of the light/dark scheme. */
  colorTheme: ColorTheme;
  /** Workspace directory used for the last new session. */
  lastWorkspace: string | null;
  /** Most recent workspace directories, newest first, at most 10 entries. */
  recentWorkspaces: string[];
  /** Model id chosen in the composer, or null for the omo default. */
  modelId: string | null;
  modelProfile?: ModelProfile | null;
  /** True once the first-run wizard finished or was dismissed; older preferences without the field infer it from workspace use. */
  onboardingCompleted: boolean;
  /** When macOS notifications fire for threads other than the active one. */
  threadNotifications: ThreadNotificationPreference;
  /** Whether a focused window also shows an in-app toast for other threads' outcomes. */
  inAppNotifications: boolean;
  /** How every clock time renders; "system" follows the OS clock preference. */
  timeFormat: TimeFormatPreference;
  /** Whether inactive sidebar threads settle automatically after `autoSettleDays`. */
  autoSettle: boolean;
  /** Whole days of inactivity before an idle thread auto-settles, clamped to 1..365. */
  autoSettleDays: number;
  /** Thread ids the user settled manually; any new activity un-settles the thread again. */
  settledThreads: string[];
  /** Thread ids the user unsettled manually, blocking auto-settle until their next activity. */
  unsettledThreads: string[];
}

/** Preferences every field resets to on "Restore device defaults" (Settings → General, top right). */
export const DEFAULT_PREFERENCES: Preferences = {
  omoAutoUpdate: true,
  theme: "system",
  locale: "system",
  colorTheme: "omo",
  lastWorkspace: null,
  recentWorkspaces: [],
  modelId: null,
  onboardingCompleted: false,
  threadNotifications: "background",
  inAppNotifications: true,
  timeFormat: "system",
  autoSettle: true,
  autoSettleDays: 3,
  settledThreads: [],
  unsettledThreads: [],
};

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

/** What omo recorded about one memory write on its memory tool result (`details.writeNotice`). */
export interface MemoryWriteNotice {
  sha: string;
  subject: string;
  affected: Array<{ path: string; insertions: number; deletions: number }>;
  /** Bytes injected into every system prompt, all memory bytes, and memory files. */
  size: { systemBytes: number; totalBytes: number; fileCount: number } | null;
  entriesToday: number | null;
  previousEntryAt: string | null;
  lastConsolidationAt: string | null;
}

/**
 * A session `custom_message` entry: context omo injected or showed outside the conversation items (memory notices,
 * recalled memories, monitor and task wake-ups, model profile changes). `turnIndex` and `afterItems` place it among
 * the parsed turns: after `afterItems` items of turn `turnIndex`. `display` is omo's own flag for user-facing ones.
 */
export interface SessionNotice {
  id: string;
  customType: string;
  display: boolean;
  text: string;
  timestamp: number | null;
  turnIndex: number;
  afterItems: number;
}

export interface HistoryResult {
  turns: HistoryTurn[];
  todo: { phases: TodoPhase[] } | null;
  tasks: HistoricalTask[];
  /** Memory writes keyed by the memory tool call id. */
  memoryWrites?: Record<string, MemoryWriteNotice>;
  notices?: SessionNotice[];
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

export type MenuCommand = "new-session" | "settings" | "toggle-sidebar";

/** Where the header's Open button can open a thread's workspace; `finder` is always available. */
export const OPEN_TARGET_IDS = ["vscode", "cursor", "terminal", "finder"] as const;
export type OpenTargetId = (typeof OPEN_TARGET_IDS)[number];

/** Git facts of one directory; null when the directory is not inside a git work tree. */
export interface GitInfo {
  /** Branch name, or the short sha of a detached HEAD. */
  branch: string;
  /** Absolute path of the work-tree root from `git rev-parse --show-toplevel`. */
  root: string;
  /** Commits on HEAD missing from the upstream; null when the branch has no upstream. */
  ahead: number | null;
  /** Commits on the upstream missing from HEAD; null when the branch has no upstream. */
  behind: number | null;
}

/** Outcome of `git add -A` + commit (+ optional push); git failures reject before this resolves. */
export interface GitCommitResult {
  /** False when git reported nothing to commit. */
  committed: boolean;
  pushed: boolean;
  /** "no-upstream" when a requested push was skipped because the branch has no upstream. */
  pushSkipped: "no-upstream" | null;
  /** Short sha of the created commit, when one was created. */
  commitHash: string | null;
}

/** Permission presets the composer's picker offers; the values are omo `permissionPreset` settings keys. */
export const PERMISSION_PRESETS = ["full-access", "workspace", "ask"] as const;
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

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

/** Identifies the thread a notification or toast is about, so opening it stays one hop. */
export interface NotifyPayload {
  title: string;
  body: string;
  threadId: string;
}

/** `"[native]"` sections of `~/.omo/omo.jsonc` that map a research agent or a task category to models. */
export type ModelMappingKind = "agents" | "categories";

/** One rung of a fallback chain: a provider/model id and an optional reasoning level such as "high". */
export interface ModelRung {
  model: string;
  reasoning: string | null;
}

/** The overrides `~/.omo/omo.jsonc` holds; a name without an entry uses omo's built-in chain. */
export interface ModelMapping {
  path: string;
  agents: Record<string, ModelRung[]>;
  categories: Record<string, ModelRung[]>;
}

/** Built-in research agents and task categories omo 5.1 resolves models for. */
export const MODEL_MAPPING_NAMES: Readonly<Record<ModelMappingKind, readonly string[]>> = {
  agents: ["explore", "librarian", "plan-consultant", "plan-reviewer", "multimodal-looker", "omo-native-code-reviewer", "omo-native-gate-reviewer", "omo-native-qa-executor"],
  categories: ["quick", "unspecified-low", "unspecified-high", "deep-low", "deep-high", "ultrabrain", "architect", "visual-engineering", "artistry", "writing"],
};

export interface OmoBridgeApi {
  /** Reads the agent and category model overrides from `~/.omo/omo.jsonc`. */
  readModelMapping(): Promise<ModelMapping>;
  /** Sets one chain (`null` restores omo's built-in chain) and resolves the mapping after the write. */
  setModelChain(kind: ModelMappingKind, name: string, rungs: ModelRung[] | null): Promise<ModelMapping>;
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
  /** Shows a macOS notification for a thread outcome; a click focuses the window and opens the thread. */
  notify(payload: NotifyPayload): Promise<void>;
  /** The thread the user clicked in a macOS notification. */
  onNotifyClick(listener: (threadId: string) => void): () => void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  /** Installed Open targets in preference order (editors, Terminal, then Finder). */
  listOpenTargets(): Promise<OpenTarget[]>;
  /** Opens `cwd` (an absolute, existing directory) in `target`; with no target, the first installed editor, else Finder. Resolves the target used. */
  openWorkspace(cwd: string, target?: OpenTargetId | null): Promise<OpenTargetId>;
  /** Branch, root, and upstream ahead/behind of `cwd`; null when it is not inside a git work tree. */
  gitInfo(cwd: string): Promise<GitInfo | null>;
  /** Verbatim `git status --porcelain` lines of `cwd`; empty when the work tree is clean. */
  gitStatus(cwd: string): Promise<string[]>;
  /** Stages all changes, commits `message`, and pushes when `push` is true; a push without an upstream is skipped and reported. */
  gitCommitPush(cwd: string, message: string, push: boolean): Promise<GitCommitResult>;
  /** The workspace's omo `permissionPreset`; "full-access" when unset. */
  getPermissionPreset(cwd: string): Promise<PermissionPreset>;
  /** Merges the preset into `<cwd>/.omo/settings.json` before the next turn; see docs/permissions.md. */
  setPermissionPreset(cwd: string, preset: PermissionPreset): Promise<void>;
  readonly platform: string;
}

/** IPC channel names. Invoke channels use ipcRenderer.invoke; event channels use webContents.send. */
export const IPC = {
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
  notify: "app:notify",
  notifyClick: "app:notify-click",
  menuCommand: "menu:command",
  copyText: "app:copy-text",
  openExternal: "app:open-external",
  revealPath: "app:reveal-path",
  listOpenTargets: "app:list-open-targets",
  openWorkspace: "app:open-workspace",
  gitInfo: "git:info",
  gitStatus: "git:status",
  gitCommitPush: "git:commit-push",
  readModelMapping: "omo-config:models:read",
  setModelChain: "omo-config:models:set",
  getPermissionPreset: "workspace:preset:get",
  setPermissionPreset: "workspace:preset:set",
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
  /** Appends one JSON line per macOS thread notification to this file (tests and QA); the notification still shows. */
  qaNotifyLog: "OMO_UI_QA_NOTIFY_LOG",
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

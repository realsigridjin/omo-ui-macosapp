import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  IphoneStatus,
  BranchPoint,
  AccountUsage,
  BranchResult,
  BridgeStatus,
  Diagnostics,
  GitCommitResult,
  GitInfo,
  HistoryResult,
  PermissionPreset,
  TaskWork,
  InstallLogLine,
  InstallResult,
  IPC,
  MenuCommand,
  NotifyPayload,
  OmoBridgeApi,
  OpenTarget,
  OpenTargetId,
  Preferences,
  RequestEnvelope,
} from "../shared/ipc";
import type { ClientMethod, ClientParams, ClientResult, RequestId, RpcNotification, RpcServerRequest } from "../shared/protocol";
import { stripRemoteMethodPrefix } from "./ipc-errors";

// The sandboxed preload can require only "electron", so the channel table is restated here; `satisfies` keeps it equal to IPC.
const CHANNELS = {
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
  getPermissionPreset: "workspace:preset:get",
  setPermissionPreset: "workspace:preset:set",
} as const satisfies typeof IPC;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result: T = await ipcRenderer.invoke(channel, ...args);
    return result;
  } catch (error) {
    throw new Error(stripRemoteMethodPrefix(error instanceof Error ? error.message : String(error)));
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  getIphoneStatus: (): Promise<IphoneStatus> => invoke(CHANNELS.getIphoneStatus),
  onIphoneStatus: (listener: (status: IphoneStatus) => void) => subscribe(CHANNELS.iphoneStatus, listener),
  getStatus: (): Promise<BridgeStatus> => invoke(CHANNELS.getStatus),
  onStatus: (listener: (status: BridgeStatus) => void) => subscribe(CHANNELS.status, listener),
  async request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    const envelope: RequestEnvelope<ClientResult<M>> = await invoke(CHANNELS.request, method, params);
    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  },
  onNotification: (listener: (notification: RpcNotification) => void) => subscribe(CHANNELS.notification, listener),
  onServerRequest: (listener: (request: RpcServerRequest) => void) => subscribe(CHANNELS.serverRequest, listener),
  respond: (id: RequestId, result: unknown): Promise<void> => invoke(CHANNELS.respond, id, result),
  restart: (): Promise<void> => invoke(CHANNELS.restart),
  install: (): Promise<InstallResult> => invoke(CHANNELS.install),
  onInstallLog: (listener: (line: InstallLogLine) => void) => subscribe(CHANNELS.installLog, listener),
  loadHistory: (sessionPath: string): Promise<HistoryResult> => invoke(CHANNELS.loadHistory, sessionPath),
  loadTaskWork: (cwd: string, parentSessionId: string): Promise<TaskWork[]> => invoke(CHANNELS.loadTaskWork, cwd, parentSessionId),
  branchSession: (sessionPath: string, point: BranchPoint): Promise<BranchResult> => invoke(CHANNELS.branchSession, sessionPath, point),
  readAccountUsage: (): Promise<AccountUsage[]> => invoke(CHANNELS.readAccountUsage),
  openAccountLogin: (provider: string): Promise<void> => invoke(CHANNELS.openAccountLogin, provider),
  pickDirectory: (defaultPath?: string | null): Promise<string | null> =>
    invoke(CHANNELS.pickDirectory, defaultPath ?? null),
  pickImages: (): Promise<string[]> => invoke(CHANNELS.pickImages),
  imageFilePath: (file: File): string => webUtils.getPathForFile(file),
  saveImage: (dataUrl: string): Promise<string> => invoke(CHANNELS.saveImage, dataUrl),
  getDiagnostics: (): Promise<Diagnostics> => invoke(CHANNELS.diagnostics),
  getPreferences: (): Promise<Preferences> => invoke(CHANNELS.getPreferences),
  setPreferences: (patch: Partial<Preferences>): Promise<Preferences> => invoke(CHANNELS.setPreferences, patch),
  notify: (payload: NotifyPayload): Promise<void> => invoke(CHANNELS.notify, payload),
  onNotifyClick: (listener: (threadId: string) => void) => subscribe(CHANNELS.notifyClick, listener),
  onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe(CHANNELS.menuCommand, listener),
  copyText: (text: string): Promise<void> => invoke(CHANNELS.copyText, text),
  openExternal: (url: string): Promise<void> => invoke(CHANNELS.openExternal, url),
  revealPath: (target: string): Promise<void> => invoke(CHANNELS.revealPath, target),
  listOpenTargets: (): Promise<OpenTarget[]> => invoke(CHANNELS.listOpenTargets),
  openWorkspace: (cwd: string, target?: OpenTargetId | null): Promise<OpenTargetId> =>
    invoke(CHANNELS.openWorkspace, cwd, target ?? null),
  gitInfo: (cwd: string): Promise<GitInfo | null> => invoke(CHANNELS.gitInfo, cwd),
  gitStatus: (cwd: string): Promise<string[]> => invoke(CHANNELS.gitStatus, cwd),
  gitCommitPush: (cwd: string, message: string, push: boolean): Promise<GitCommitResult> =>
    invoke(CHANNELS.gitCommitPush, cwd, message, push),
  getPermissionPreset: (cwd: string): Promise<PermissionPreset> => invoke(CHANNELS.getPermissionPreset, cwd),
  setPermissionPreset: (cwd: string, preset: PermissionPreset): Promise<void> => invoke(CHANNELS.setPermissionPreset, cwd, preset),
  platform: process.platform,
} satisfies OmoBridgeApi;

contextBridge.exposeInMainWorld("omo", api);

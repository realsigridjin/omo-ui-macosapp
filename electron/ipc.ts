import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, clipboard, dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import { ENV, IPC } from "../shared/ipc";
import type { BranchResult, Diagnostics, HistoryResult, InstallResult, RequestEnvelope } from "../shared/ipc";
import { CLIENT_METHODS } from "../shared/protocol";
import type { ClientMethod, ClientParams, RequestId } from "../shared/protocol";
import { openLogin } from "./accounts/login";
import { readAccountUsage } from "./accounts/usage";
import { branchSession } from "./history/branch-session";
import { parseSessionJsonl } from "./history/session-jsonl";
import { loadTaskWork } from "./history/task-work";
import { RpcRequestError } from "./omo/app-server-client";
import { runInstaller } from "./omo/installer";
import { applyProxySettings, getProxySettings } from "./omo/proxy";
import { createOpenWorkspace } from "./open-workspace";
import type { OpenWorkspace } from "./open-workspace";
import type { OmoSupervisor } from "./omo/supervisor";
import type { PreferencesStore } from "./prefs";

import type { IphoneBridge } from "./iphone/bridge";
import type { AndroidBridge } from "./android/bridge";
import { discoverMcpConfigs, importMcpConfig, readConfiguredMcpServers } from "./omo/mcp-config";
import { readOpencodexAccounts } from "./accounts/opencodex";
import { listWorkspaceFiles, readWorkspaceFile, getWorkspaceDiff } from "./workspace-files";
import { getDeviceOverview } from "./device-overview";
import { AppUpdater } from "./app-update";
import { readModelRouting, saveModelRouting } from "./omo/model-routing";

export interface IpcDeps {
  android?: AndroidBridge;
  iphone?: IphoneBridge;
  supervisor: OmoSupervisor;
  prefs: PreferencesStore;
  getWindow: () => BrowserWindow | null;
  homeDir: string;
  /** Defaults to the real mdfind/open spawner and shell.openPath; tests inject fakes. */
  openWorkspace?: OpenWorkspace;
}

const execFileAsync = promisify(execFile);

const defaultOpenWorkspace = (): OpenWorkspace =>
  createOpenWorkspace({
    exec: async (file, args) => (await execFileAsync(file, [...args])).stdout,
    openPath: (target) => shell.openPath(target),
  });

const INTERNAL_ERROR = -32603;
const INVALID_REQUEST = -32600;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function isClientMethod(value: unknown): value is ClientMethod {
  return CLIENT_METHODS.some((method) => method === value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Registers every invoke handler in IPC and forwards bridge events to the window; returns a disposer. */
export function registerIpc(deps: IpcDeps): () => void {
  const { supervisor, prefs, getWindow, homeDir } = deps;
  const openWorkspace = deps.openWorkspace ?? defaultOpenWorkspace();
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  };
  const updater = new AppUpdater({
    currentVersion: app.getVersion(),
    downloadDir: path.join(app.getPath("userData"), "updates"),
    onStatus: (status) => send(IPC.appUpdateStatus, status),
    launchInstaller: async (installer) => {
      if (!app.isPackaged) throw new Error("Install app updates from the packaged Windows app.");
      const result = await shell.openPath(installer);
      if (result !== "") throw new Error("Could not launch the Windows installer.");
      app.quit();
    },
  });
  let installing: Promise<InstallResult> | null = null;
  let applyingProxy = false;
  const proxyAgentDir = (): string => supervisor.initializeResult?.codexHome ?? process.env["OMO_CODING_AGENT_DIR"] ?? path.join(homeDir, ".omo", "agent");
  /** Resolves a renderer-supplied session path, refusing anything outside the omo sessions directory. */
  const sessionFile = async (sessionPath: unknown): Promise<string> => {
    const requested = requireString(sessionPath, "sessionPath");
    if (!path.isAbsolute(requested)) throw new Error("sessionPath must be absolute");
    const codexHome = supervisor.initializeResult?.codexHome ?? path.join(homeDir, ".omo", "agent");
    const root = await realpath(path.join(codexHome, "sessions"));
    const target = await realpath(requested);
    if (!isInside(root, target)) throw new Error("sessionPath is outside the omo sessions directory");
    return target;
  };

  const handlers: Record<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> = {
    [IPC.readModelRouting]: () => readModelRouting(homeDir),
    [IPC.saveModelRouting]: async (_event, input) => {
      const result = await saveModelRouting(homeDir, input);
      await supervisor.restart();
      if (supervisor.getStatus().state !== "connected") throw new Error("Model configuration saved, but omo could not reconnect.");
      return result;
    },
    [IPC.readConfiguredMcpServers]: () => readConfiguredMcpServers(proxyAgentDir()),
    [IPC.importExistingMcpConfigs]: async () => {
      const sources = await discoverMcpConfigs(homeDir);
      const imported: string[] = [];
      for (const source of sources) imported.push(...(await importMcpConfig(proxyAgentDir(), source.path)).imported);
      if (imported.length > 0) {
        await supervisor.restart();
        if (supervisor.getStatus().state !== "connected") throw new Error("MCP configuration saved, but omo could not reconnect. Check omo diagnostics.");
      }
      return { imported, sources: sources.length };
    },
    [IPC.getAppUpdateStatus]: () => updater.getStatus(),
    [IPC.checkAppUpdate]: () => updater.check(),
    [IPC.installAppUpdate]: () => updater.install(),
    [IPC.getDeviceOverview]: () => getDeviceOverview(homeDir, app.getVersion(), supervisor.getStatus().omo?.version ?? null),
    [IPC.listWorkspaceFiles]: (_event, cwd) => listWorkspaceFiles(requireString(cwd, "cwd")),
    [IPC.readWorkspaceFile]: (_event, cwd, file) => readWorkspaceFile(requireString(cwd, "cwd"), requireString(file, "relativePath")),
    [IPC.getWorkspaceDiff]: (_event, cwd, file) => getWorkspaceDiff(requireString(cwd, "cwd"), requireString(file, "relativePath")),
    [IPC.readOpencodexAccounts]: () => readOpencodexAccounts(proxyAgentDir(), homeDir),
    [IPC.getAndroidStatus]: () => deps.android?.getStatus(),
    [IPC.refreshAndroid]: () => deps.android?.refresh(),
    [IPC.connectAndroid]: (_event, serial) => deps.android?.connect(requireString(serial, "serial")),
    [IPC.disconnectAndroid]: () => deps.android?.disconnect(),
    [IPC.importMcpConfig]: async () => {
      const options: OpenDialogOptions = { properties: ["openFile"], filters: [{ name: "MCP configuration", extensions: ["json"] }] };
      const window = getWindow();
      const selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths[0]) return null;
      const result = await importMcpConfig(proxyAgentDir(), selected.filePaths[0]);
      if (result.imported.length > 0) {
        await supervisor.restart();
        if (supervisor.getStatus().state !== "connected") throw new Error("MCP configuration saved, but omo could not reconnect. Check omo diagnostics.");
      }
      return result;
    },
    [IPC.getProxySettings]: () => getProxySettings(proxyAgentDir()),
    [IPC.applyProxySettings]: async (_event, input) => {
      if (applyingProxy) throw new Error("A proxy configuration update is already running");
      if (typeof input !== "object" || input === null || !("baseUrl" in input) || typeof input.baseUrl !== "string") throw new TypeError("baseUrl must be a string");
      if ("apiKey" in input && input.apiKey !== undefined && typeof input.apiKey !== "string") throw new TypeError("apiKey must be a string");
      applyingProxy = true;
      try {
        const result = await applyProxySettings(proxyAgentDir(), { baseUrl: input.baseUrl, ...("apiKey" in input && typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}) });
        await supervisor.restart();
        if (supervisor.getStatus().state !== "connected") throw new Error("Proxy saved, but omo could not reconnect. Check omo diagnostics.");
        return result;
      } finally {
        applyingProxy = false;
      }
    },
    [IPC.getIphoneStatus]: () => deps.iphone?.getStatus() ?? { enabled: false, state: "searching", devices: [] },
    [IPC.getStatus]: () => supervisor.getStatus(),
    [IPC.request]: async (_event, method, params): Promise<RequestEnvelope> => {
      if (!isClientMethod(method)) {
        return { ok: false, error: { code: INVALID_REQUEST, message: `method not allowed: ${String(method)}` } };
      }
      try {
        // Params come from the renderer untyped; the app-server validates them against its schema.
        const result = await supervisor.request(method, params as ClientParams<ClientMethod>);
        return { ok: true, result };
      } catch (error) {
        if (error instanceof RpcRequestError) return { ok: false, error: { code: error.code, message: error.message } };
        return { ok: false, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } };
      }
    },
    [IPC.respond]: async (_event, id, result) => {
      if (!isRequestId(id)) throw new TypeError("id must be a number or string");
      await supervisor.respond(id, result);
    },
    [IPC.restart]: () => supervisor.restart(),
    [IPC.install]: () => {
      installing ??= (async () => {
        try {
          const result = await runInstaller({ env: await supervisor.getLoginEnv(), onLine: (line) => send(IPC.installLog, line) });
          if (result.ok) await supervisor.restart();
          return result;
        } finally {
          installing = null;
        }
      })();
      return installing;
    },
    [IPC.loadHistory]: async (_event, sessionPath): Promise<HistoryResult> =>
      parseSessionJsonl(await readFile(await sessionFile(sessionPath), "utf8")),
    [IPC.loadTaskWork]: (_event, cwd, parentSessionId) => loadTaskWork(
      supervisor.initializeResult?.codexHome ?? path.join(homeDir, ".omo", "agent"),
      requireString(cwd, "cwd"), requireString(parentSessionId, "parentSessionId"),
    ),
    [IPC.readAccountUsage]: () => readAccountUsage({ agentDir: supervisor.initializeResult?.codexHome ?? path.join(homeDir, ".omo", "agent") }),
    [IPC.openAccountLogin]: async (_event, provider) => {
      if (typeof provider !== "string" || !/^[a-z0-9-]{1,64}$/.test(provider)) throw new TypeError("provider must be a provider id");
      const omo = supervisor.getStatus().omo;
      if (omo === null) throw new Error("omo was not found; install it first");
      await openLogin(omo.path, provider);
    },
    [IPC.branchSession]: async (_event, sessionPath, point): Promise<BranchResult> => {
      if (typeof point !== "object" || point === null) throw new TypeError("point must be an object");
      const { text, occurrence } = point as Record<string, unknown>;
      if (typeof text !== "string" || typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) {
        throw new TypeError("point must hold a string text and a non-negative integer occurrence");
      }
      return branchSession(await sessionFile(sessionPath), { text, occurrence });
    },
    [IPC.pickDirectory]: async (_event, defaultPath): Promise<string | null> => {
      const qaDir = process.env[ENV.qaPickDir];
      if (qaDir) return qaDir;
      const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
      if (typeof defaultPath === "string" && defaultPath !== "") options.defaultPath = defaultPath;
      const window = getWindow();
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    [IPC.pickImages]: async (): Promise<string[]> => {
      const qa = process.env[ENV.qaPickImages];
      if (qa) {
        const paths: unknown = JSON.parse(qa);
        if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) throw new Error("QA image paths must be an array of absolute paths");
        return paths as string[];
      }
      const options: OpenDialogOptions = {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      };
      const window = getWindow();
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? [] : picked.filePaths;
    },
    [IPC.saveImage]: async (_event, dataUrl): Promise<string> => {
      const match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(requireString(dataUrl, "dataUrl"));
      if (match === null) throw new Error("dataUrl must be a base64 PNG, JPEG, GIF or WebP data URL");
      const bytes = Buffer.from(match[2] ?? "", "base64");
      if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("image is larger than 20 MB");
      const dir = path.join(app.getPath("userData"), "attachments");
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${randomUUID()}.${match[1] === "jpeg" ? "jpg" : match[1]}`);
      await writeFile(target, bytes);
      return target;
    },
    [IPC.diagnostics]: (): Diagnostics => ({
      ...supervisor.diagnostics(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      userDataPath: app.getPath("userData"),
    }),
    [IPC.getPreferences]: () => prefs.get(),
    [IPC.setPreferences]: (_event, patch) => prefs.set(patch),
    [IPC.copyText]: (_event, text) => {
      clipboard.writeText(requireString(text, "text"));
    },
    [IPC.openExternal]: async (_event, url) => {
      const parsed = new URL(requireString(url, "url"));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`refusing to open ${parsed.protocol} URL`);
      await shell.openExternal(parsed.toString());
    },
    [IPC.revealPath]: (_event, target) => {
      shell.showItemInFolder(requireString(target, "path"));
    },
    [IPC.listOpenTargets]: () => openWorkspace.listTargets(),
    [IPC.openWorkspace]: async (_event, cwd, target) => {
      if (target === null || target === undefined) return openWorkspace.openDefault(cwd);
      await openWorkspace.open(cwd, target);
      return target;
    },
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  const unsubscribers = [
    ...(deps.android ? [deps.android.onStatus((status) => send(IPC.androidStatus, status))] : []),
    ...(deps.iphone ? [deps.iphone.onStatus((status) => send(IPC.iphoneStatus, status))] : []),
    supervisor.onStatus((status) => send(IPC.status, status)),
    supervisor.onNotification((notification) => send(IPC.notification, notification)),
    supervisor.onServerRequest((request) => send(IPC.serverRequest, request)),
  ];

  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

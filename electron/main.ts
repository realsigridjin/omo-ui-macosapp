import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";
import { ENV, IPC } from "../shared/ipc";
import type { MenuCommand } from "../shared/ipc";
import { IphoneBridge, loadIphoneToken } from "./iphone/bridge";
import { AndroidBridge } from "./android/bridge";
import { registerIpc } from "./ipc";
import { installApplicationMenu } from "./menu";
import { OmoSupervisor } from "./omo/supervisor";
import { PreferencesStore } from "./prefs";

const QUIT_STOP_TIMEOUT_MS = 5_000;

app.setName("OmO UI Windows");
const userDataOverride = process.env[ENV.userData];
if (userDataOverride) app.setPath("userData", userDataOverride);

const devUrl = process.env[ENV.devUrl] || null;
const indexPath = path.join(__dirname, "../dist/index.html");
let mainWindow: BrowserWindow | null = null;

function isAppUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    void error;
    return false;
  }
  if (devUrl) return parsed.origin === new URL(devUrl).origin;
  return parsed.protocol === "file:" && fileURLToPath(parsed) === indexPath;
}

function openIfWeb(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 520,
    minHeight: 600,
    title: "OmO UI Windows",
    show: false,
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: "sidebar" as const,
      visualEffectState: "active" as const,
      backgroundColor: "#00000000",
    } : {
      backgroundColor: "#171717",
      icon: app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(__dirname, "../build/icon.png"),
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openIfWeb(url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(indexPath);
  mainWindow = window;
  return window;
}

function focusWindow(): void {
  const window = mainWindow ?? createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function sendMenuCommand(command: MenuCommand): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.webContents.send(IPC.menuCommand, command);
}

function run(): void {
  const homeDir = os.homedir();
  const prefs = new PreferencesStore(app.getPath("userData"));
  const supervisor = new OmoSupervisor({
    homeDir, baseEnv: process.env, clientVersion: app.getVersion(),
    autoUpdate: { enabled: () => process.env[ENV.omoAutoUpdate] !== "0" && prefs.get().omoAutoUpdate !== false },
  });

  const iphone = new IphoneBridge(supervisor, undefined, undefined, loadIphoneToken(app.getPath("userData")));
  const android = new AndroidBridge(supervisor);

  app.on("second-instance", () => {
    if (app.isReady()) focusWindow();
  });

  void app.whenReady().then(() => {
    if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, "../build/icon.png"));
    installApplicationMenu(sendMenuCommand);
    registerIpc({ supervisor, iphone, android, prefs, getWindow: () => mainWindow, homeDir });
    createWindow();
    iphone.start();
    void supervisor.start();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  let quitPhase: "running" | "stopping" | "done" = "running";
  app.on("before-quit", (event) => {
    if (quitPhase === "done") return;
    event.preventDefault();
    if (quitPhase === "stopping") return;
    quitPhase = "stopping";
    iphone.stop();
    let timer: NodeJS.Timeout | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        console.error(`omo did not stop within ${QUIT_STOP_TIMEOUT_MS} ms; quitting anyway`);
        resolve();
      }, QUIT_STOP_TIMEOUT_MS);
    });
    const stopped = Promise.all([android.stop(), supervisor.stop()]).catch((error: unknown) => {
      console.error("failed to stop omo", error);
    });
    void Promise.race([stopped, bounded]).finally(() => {
      clearTimeout(timer);
      quitPhase = "done";
      // With no omo child, stop() settles inside Electron's native before-quit dispatch (Cmd+Q, the Dock's Quit,
      // SIGTERM); an app.quit() made there is discarded with the prevented quit, so quit again from a new task.
      setImmediate(() => app.quit());
    });
  });
}

if (app.requestSingleInstanceLock()) run();
else app.quit();

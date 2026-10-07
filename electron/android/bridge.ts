import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AndroidDevice, AndroidStatus } from "../../shared/android";
import type { ClientMethod, ClientParams, RequestId, RpcServerRequest } from "../../shared/protocol";
import { RpcRequestError } from "../omo/app-server-client";
import type { OmoSupervisor } from "../omo/supervisor";
import { phoneHtml } from "./phone";

export type AdbExec = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
export interface AndroidBridgeOptions {
  adbPath?: string;
  execFile?: AdbExec;
  /** Zero requests an ephemeral port, useful for tests. */
  port?: number;
}
const runAdb: AdbExec = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(error); else resolve({ stdout, stderr });
  });
});
function adbPath(): string {
  const sdk = process.env["ANDROID_HOME"] ?? process.env["ANDROID_SDK_ROOT"];
  const local = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const roots = [sdk, process.platform === "win32" ? path.join(local, "Android", "Sdk") : path.join(os.homedir(), process.platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk")];
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, "platform-tools", executable);
    if (existsSync(candidate)) return candidate;
  }
  return executable;
}
export function parseDevices(output: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|unauthorized|offline)(?:\s+(.*))?$/.exec(line.trim());
    if (!match) continue;
    const serial = match[1]!;
    const model = /(?:^|\s)model:(\S+)/.exec(match[3] ?? "")?.[1];
    devices.push({ serial, name: model?.replaceAll("_", " ") ?? serial, state: match[2] === "device" ? "ready" : match[2] === "unauthorized" ? "unauthorized" : "offline" });
  }
  return devices;
}
export const ANDROID_METHODS = ["model/list", "thread/list", "thread/start", "thread/resume", "thread/read", "turn/start", "turn/interrupt"] as const satisfies readonly ClientMethod[];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
type Supervisor = Pick<OmoSupervisor, "getStatus" | "onStatus" | "onNotification" | "onServerRequest" | "request" | "respond">;

/** A single explicitly selected ADB device, with an HTTP server bound only to desktop loopback. */
export class AndroidBridge {
  private status: AndroidStatus = { adbAvailable: false, state: "disabled", devices: [], selectedSerial: null, url: null, message: null };
  private readonly listeners = new Set<(status: AndroidStatus) => void>();
  private readonly streams = new Set<ServerResponse>();
  private readonly pending = new Map<RequestId, RpcServerRequest>();
  private readonly answering = new Set<RequestId>();
  private readonly disposers: (() => void)[];
  private readonly executable: string;
  private readonly exec: AdbExec;
  private readonly preferredPort: number;
  private server: Server | null = null;
  private port = 0;
  private token: string | null = null;
  private reverseSerial: string | null = null;
  private stopped = false;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(private readonly supervisor: Supervisor, options: AndroidBridgeOptions = {}) {
    this.executable = options.adbPath ?? adbPath();
    this.exec = options.execFile ?? runAdb;
    this.preferredPort = options.port ?? 47102;
    this.disposers = [
      supervisor.onStatus((status) => {
        if (status.state !== "connected") { this.pending.clear(); this.answering.clear(); }
        this.broadcast({ type: "bridgeStatus", state: status.state });
      }),
      supervisor.onNotification((notification) => {
        if (notification.method === "serverRequest/resolved" && object(notification.params)) this.pending.delete(notification.params["requestId"] as RequestId);
        this.broadcast({ type: "notification", notification });
      }),
      supervisor.onServerRequest((request) => { this.pending.set(request.id, request); this.broadcast({ type: "serverRequest", ...request }); }),
    ];
  }
  getStatus(): AndroidStatus { return { ...this.status, devices: this.status.devices.map((device) => ({ ...device })) }; }
  onStatus(listener: (status: AndroidStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<AndroidStatus>): AndroidStatus {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.getStatus());
    return this.getStatus();
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.operations.then(action);
    this.operations = operation.catch(() => undefined);
    return operation;
  }
  refresh(): Promise<AndroidStatus> { return this.enqueue(() => this.discover()); }
  private async discover(): Promise<AndroidStatus> {
    if (this.stopped) return this.getStatus();
    try {
      const { stdout } = await this.exec(this.executable, ["devices", "-l"]);
      if (this.stopped) return this.getStatus();
      const devices = parseDevices(stdout);
      if (this.status.selectedSerial && !devices.some((device) => device.serial === this.status.selectedSerial && device.state === "ready")) {
        await this.closeLink();
        return this.publish({ adbAvailable: true, devices, state: "searching", selectedSerial: null, url: null, message: "Selected Android device is no longer ready." });
      }
      return this.publish({ adbAvailable: true, devices, state: this.status.selectedSerial ? "connected" : "searching", message: null });
    } catch (error) {
      await this.closeLink();
      const missing = object(error) && error["code"] === "ENOENT";
      return this.publish({ adbAvailable: !missing, devices: [], selectedSerial: null, url: null, state: missing ? "disabled" : "error", message: missing ? "ADB was not found. Install Android platform-tools." : "Could not query ADB devices." });
    }
  }
  connect(serial: string): Promise<AndroidStatus> {
    return this.enqueue(async () => {
      if (this.stopped) return this.getStatus();
      await this.discover();
      if (!this.status.devices.some((device) => device.serial === serial && device.state === "ready")) {
        return this.publish({ state: "error", message: "Select a ready Android device. Authorize USB debugging on the phone if needed." });
      }
      await this.closeLink();
      this.publish({ selectedSerial: null, url: null, state: "searching", message: null });
      try {
        await this.listen();
        if (this.stopped) { await this.closeLink(); return this.getStatus(); }
        this.token = randomBytes(32).toString("hex");
        await this.exec(this.executable, ["-s", serial, "reverse", `tcp:${this.port}`, `tcp:${this.port}`]);
        this.reverseSerial = serial;
        if (this.stopped) { await this.closeLink(); return this.getStatus(); }
        const url = `http://127.0.0.1:${this.port}/#token=${this.token}`;
        const launched = await this.exec(this.executable, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
        if (/\bError:|Exception/.test(launched.stdout + launched.stderr)) throw new Error("Browser launch failed");
        if (this.stopped) { await this.closeLink(); return this.getStatus(); }
        return this.publish({ state: "connected", selectedSerial: serial, url, message: null });
      } catch {
        await this.closeLink();
        // execFile errors include their command line, which contains the bearer token.
        return this.publish({ state: "error", selectedSerial: null, url: null, message: "Could not connect Android browser. Check ADB reverse support and the phone browser." });
      }
    });
  }
  disconnect(): Promise<AndroidStatus> { return this.enqueue(async () => {
    const cleanup = await this.closeLink();
    return this.publish({ selectedSerial: null, url: null, state: this.stopped || !this.status.adbAvailable ? "disabled" : cleanup ? "searching" : "error", message: cleanup ? null : "Could not remove ADB reverse mapping." });
  }); }
  stop(): Promise<void> {
    this.stopped = true;
    for (const dispose of this.disposers) dispose();
    this.pending.clear();
    return this.enqueue(async () => { await this.closeLink(); this.publish({ state: "disabled", selectedSerial: null, url: null, message: null }); });
  }
  private async listen(): Promise<void> {
    const server = createServer((request, response) => { void this.receive(request, response).catch(() => { if (!response.headersSent) this.json(response, 500, { error: { code: -32603, message: "Request failed" } }); else response.end(); }); });
    this.server = server;
    const bind = (port: number): Promise<void> => new Promise((resolve, reject) => {
      const error = (cause: Error): void => { server.off("listening", ready); reject(cause); };
      const ready = (): void => { server.off("error", error); resolve(); };
      server.once("error", error); server.once("listening", ready); server.listen(port, "127.0.0.1");
    });
    try { await bind(this.preferredPort); }
    catch (error) { if (object(error) && error["code"] === "EADDRINUSE" && this.preferredPort !== 0) await bind(0); else throw error; }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP port");
    this.port = address.port;
  }
  private async closeLink(): Promise<boolean> {
    this.token = null;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    let removed = true;
    if (this.reverseSerial) {
      try { await this.exec(this.executable, ["-s", this.reverseSerial, "reverse", "--remove", `tcp:${this.port}`]); }
      catch { removed = false; }
      this.reverseSerial = null;
    }
    this.port = 0;
    return removed;
  }
  private json(response: ServerResponse, code: number, value: unknown): void {
    response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(JSON.stringify(value));
  }
  private broadcast(frame: unknown): void { for (const stream of this.streams) this.event(stream, frame); }
  private event(response: ServerResponse, frame: unknown): void { response.write(`data: ${JSON.stringify(frame)}\n\n`); }
  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${this.port}`;
    if (request.headers.host !== `127.0.0.1:${this.port}` || (request.headers.origin && request.headers.origin !== origin)) { this.json(response, 403, { error: "Forbidden origin" }); return; }
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      const nonce = randomBytes(16).toString("hex");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` });
      response.end(phoneHtml(nonce)); return;
    }
    const supplied = request.method === "GET" && url.pathname === "/events" ? url.searchParams.get("token") : request.headers.authorization?.replace(/^Bearer /, "");
    if (!this.token || !supplied || Buffer.byteLength(supplied) !== Buffer.byteLength(this.token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))) { this.json(response, 401, { error: "Unauthorized" }); return; }
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
      this.streams.add(response);
      response.once("close", () => this.streams.delete(response));
      this.event(response, { type: "bridgeStatus", state: this.supervisor.getStatus().state });
      for (const pending of this.pending.values()) this.event(response, { type: "serverRequest", ...pending });
      return;
    }
    if (request.method !== "POST" || (url.pathname !== "/rpc" && url.pathname !== "/answer")) { this.json(response, 404, { error: "Not found" }); return; }
    if (!request.headers["content-type"]?.startsWith("application/json")) { this.json(response, 415, { error: "Expected JSON" }); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { this.json(response, 413, { error: "Request too large" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    let frame: unknown;
    try { frame = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { this.json(response, 400, { error: { code: -32602, message: "Invalid JSON" } }); return; }
    if (!object(frame)) { this.json(response, 400, { error: { code: -32602, message: "Expected an object" } }); return; }
    try {
      if (url.pathname === "/answer") {
        const id = frame["id"];
        if ((typeof id !== "number" && typeof id !== "string") || !object(frame["result"])) { this.json(response, 400, { error: { code: -32602, message: "Invalid answer" } }); return; }
        if (!this.pending.has(id) || this.answering.has(id)) { this.json(response, 409, { error: "Request is no longer pending" }); return; }
        this.answering.add(id);
        try { await this.supervisor.respond(id, frame["result"]); this.pending.delete(id); this.broadcast({ type: "notification", notification: { method: "serverRequest/resolved", params: { requestId: id } } }); }
        finally { this.answering.delete(id); }
        this.json(response, 200, { result: {} }); return;
      }
      const method = frame["method"];
      if (!ANDROID_METHODS.some((allowed) => allowed === method)) { this.json(response, 403, { error: { code: -32601, message: "Method not allowed" } }); return; }
      if (!object(frame["params"])) { this.json(response, 400, { error: { code: -32602, message: "params must be an object" } }); return; }
      const allowed = method as (typeof ANDROID_METHODS)[number];
      const result = await this.supervisor.request(allowed, frame["params"] as ClientParams<typeof allowed>);
      this.json(response, 200, { result });
    } catch (error) { this.json(response, 502, { error: { code: error instanceof RpcRequestError ? error.code : -32603, message: error instanceof Error ? error.message : "Request failed" } }); }
  }
}

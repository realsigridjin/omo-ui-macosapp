import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type net from "node:net";
import type { IphoneStatus } from "../../shared/ipc";
import type { ClientMethod, ClientParams, RequestId, RpcServerRequest } from "../../shared/protocol";
import { RpcRequestError } from "../omo/app-server-client";
import type { OmoSupervisor } from "../omo/supervisor";
import { Usbmux, type UsbDevice } from "./usbmux";

const MAX_FRAME = 8 * 1024 * 1024;
/** Loads the installation's bearer token, creating it with owner-only permissions once. */
export function loadIphoneToken(userData: string): string {
  const file = path.join(userData, "iphone-token.json");
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(userData, { recursive: true });
    const token = randomBytes(32).toString("hex");
    writeFileSync(file, JSON.stringify({ token }) + "\n", { mode: 0o600, flag: "wx" });
    return token;
  }
  if (typeof value !== "object" || value === null || !("token" in value) || typeof value.token !== "string" || !/^[0-9a-f]{64}$/.test(value.token)) throw new Error("Invalid iPhone bridge token");
  chmodSync(file, 0o600);
  return value.token;
}
export const IPHONE_METHODS = ["thread/list", "thread/start", "thread/resume", "thread/read", "thread/goal/get", "thread/name/set", "thread/delete", "thread/archive", "turn/start", "turn/steer", "turn/interrupt", "model/list", "skills/list"] as const satisfies readonly ClientMethod[];
export function allowedMethod(method: unknown): method is (typeof IPHONE_METHODS)[number] { return IPHONE_METHODS.some((m) => m === method); }
export function encodeFrame(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame)); if (body.length > MAX_FRAME) throw new Error("Frame too large");
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
}
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer, receive: (frame: unknown) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(); if (length > MAX_FRAME) throw new Error("Frame too large");
      if (this.buffer.length < length + 4) return;
      const frame: unknown = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8")); this.buffer = this.buffer.subarray(length + 4); receive(frame);
    }
  }
}
const serverRequestFrame = (request: RpcServerRequest): unknown => ({ type: "serverRequest", id: request.id, method: request.method, params: request.params ?? {} });
interface DeviceLink { device: UsbDevice; socket?: net.Socket; retry?: NodeJS.Timeout; heartbeat?: NodeJS.Timeout; silence?: NodeJS.Timeout }
export class IphoneBridge {
  private readonly devices = new Map<number, DeviceLink>();
  private readonly listeners = new Set<(status: IphoneStatus) => void>();
  private disposers: (() => void)[] = [];
  private listenRetry?: NodeJS.Timeout;
  private stopped = true;
  /** omo server requests not yet answered, replayed to a phone that connects while they wait. */
  private readonly pending = new Map<RequestId, RpcServerRequest>();
  constructor(private readonly supervisor: Pick<OmoSupervisor, "getStatus" | "onStatus" | "onNotification" | "onServerRequest" | "request" | "respond">, private readonly mux = new Usbmux(), private readonly enabled = process.platform === "darwin" && process.env["OMO_UI_IPHONE_BRIDGE"] !== "0", private readonly token = randomBytes(32).toString("hex")) {}
  getStatus(): IphoneStatus { const devices = [...this.devices.values()].map((link) => ({ ...link.device, state: link.socket ? "connected" as const : "connecting" as const, pendingApproval: !!link.socket && this.pending.size > 0 })); return { enabled: this.enabled, state: devices.some((d) => d.state === "connected") ? "connected" : devices.length ? "connecting" : "searching", devices }; }
  onStatus(listener: (status: IphoneStatus) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(): void { for (const listener of this.listeners) listener(this.getStatus()); }
  start(): void {
    if (!this.stopped || !this.enabled) return; this.stopped = false;
    this.disposers = [
      this.supervisor.onStatus((status) => { if (status.state !== "connected") this.pending.clear(); this.broadcast({ type: "bridgeStatus", state: status.state }); this.publish(); }),
      this.supervisor.onNotification((notification) => { if (notification.method === "serverRequest/resolved") this.pending.delete((notification.params as { requestId: RequestId }).requestId); this.broadcast({ type: "notification", notification }); this.publish(); }),
      this.supervisor.onServerRequest((request) => { this.pending.set(request.id, request); this.broadcast(serverRequestFrame(request)); this.publish(); }),
    ];
    this.listen();
  }
  private listen(): void {
    this.mux.listen((device) => { if (this.devices.has(device.id)) return; const link = { device }; this.devices.set(device.id, link); this.publish(); void this.connect(link); }, (id) => this.detach(id), () => {
      for (const id of this.devices.keys()) this.detach(id);
      if (!this.stopped) this.listenRetry = setTimeout(() => this.listen(), 2_000);
    });
  }
  private async connect(link: DeviceLink): Promise<void> {
    try {
      const socket = await this.mux.connect(link.device.id, 47101);
      if (this.stopped || this.devices.get(link.device.id) !== link) { socket.destroy(); return; }
      link.socket = socket; const decoder = new FrameDecoder();
      const resetSilence = (): void => { clearTimeout(link.silence); link.silence = setTimeout(() => socket.destroy(), 30_000); };
      resetSilence();
      socket.on("error", () => { /* Close retries while attached. */ });
      socket.once("close", () => { clearInterval(link.heartbeat); clearTimeout(link.silence); delete link.socket; this.retry(link); this.publish(); });
      socket.on("data", (chunk) => { resetSilence(); try { decoder.push(chunk, (frame) => { void this.receive(socket, frame); }); } catch (error) { socket.destroy(error as Error); } });
      this.send(socket, { type: "hello", version: 1, macName: os.hostname(), token: this.token, bridge: { state: this.supervisor.getStatus().state } });
      this.send(socket, { type: "bridgeStatus", state: this.supervisor.getStatus().state });
      for (const request of this.pending.values()) this.send(socket, serverRequestFrame(request));
      link.heartbeat = setInterval(() => this.send(socket, { type: "ping", t: Date.now() }), 10_000);
      this.publish(); socket.resume();
    } catch (error) { if (!this.stopped && this.devices.get(link.device.id) === link) { console.debug(`iPhone ${link.device.id}: ${error instanceof Error ? error.message : String(error)}`); this.retry(link); } }
  }
  private retry(link: DeviceLink): void { if (!this.stopped && this.devices.get(link.device.id) === link) link.retry = setTimeout(() => { void this.connect(link); }, 2_000); }
  private send(socket: net.Socket, frame: unknown): void {
    if (socket.destroyed) return;
    try { socket.write(encodeFrame(frame)); } catch (error) { socket.destroy(error as Error); }
  }
  private broadcast(frame: unknown): void { for (const link of this.devices.values()) if (link.socket) this.send(link.socket, frame); }
  private async receive(socket: net.Socket, value: unknown): Promise<void> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) { socket.destroy(); return; }
    const frame = value as Record<string, unknown>;
    if (frame["type"] === "ping") { this.send(socket, { type: "pong", t: frame["t"] }); return; }
    if (frame["type"] === "pong") return;
    if (frame["type"] === "trusted") {
      this.send(socket, { type: "bridgeStatus", state: this.supervisor.getStatus().state });
      for (const request of this.pending.values()) this.send(socket, serverRequestFrame(request));
      return;
    }
    if (frame["type"] === "serverAnswer") { await this.answer(frame); return; }
    // Unknown types are ignored so either side can add frames without breaking the other.
    if (frame["type"] !== "rpc") return;
    if (typeof frame["id"] !== "number" || !Number.isFinite(frame["id"])) { socket.destroy(); return; }
    const id = frame["id"]; const method = frame["method"];
    if (!allowedMethod(method)) { this.send(socket, { type: "rpcError", id, error: { code: -32601, message: `method not allowed: ${String(method)}` } }); return; }
    const params = frame["params"];
    if (typeof params !== "object" || params === null || Array.isArray(params)) { this.send(socket, { type: "rpcError", id, error: { code: -32602, message: "params must be an object" } }); return; }
    try { const result = await this.supervisor.request(method, params as ClientParams<typeof method>); this.send(socket, { type: "rpcResult", id, result }); }
    catch (error) { this.send(socket, { type: "rpcError", id, error: { code: error instanceof RpcRequestError ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }); }
  }
  private async answer(frame: Record<string, unknown>): Promise<void> {
    const id = frame["id"]; const result = frame["result"];
    if ((typeof id !== "number" && typeof id !== "string") || !this.pending.has(id)) { console.debug(`iPhone answer ignored: no pending server request ${String(id)}`); return; }
    if (typeof result !== "object" || result === null || Array.isArray(result)) { console.debug(`iPhone answer ignored: result for ${String(id)} is not an object`); return; }
    this.pending.delete(id);
    this.publish();
    try { await this.supervisor.respond(id, result); }
    catch (error) { console.debug(`iPhone answer ${String(id)} not delivered: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private detach(id: number): void { const link = this.devices.get(id); if (!link) return; this.devices.delete(id); clearTimeout(link.retry); clearInterval(link.heartbeat); clearTimeout(link.silence); link.socket?.destroy(); this.publish(); }
  stop(): void { this.stopped = true; clearTimeout(this.listenRetry); for (const dispose of this.disposers) dispose(); this.disposers = []; for (const id of this.devices.keys()) this.detach(id); this.mux.stop(); }
}

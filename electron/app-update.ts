import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import type { AppUpdateStatus } from "../shared/app-update";

export type { AppUpdateStatus } from "../shared/app-update";

export interface AppUpdaterOptions {
  currentVersion: string;
  downloadDir: string;
  onStatus?: (status: AppUpdateStatus) => void;
  launchInstaller: (path: string) => Promise<void>;
  platform?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

const RELEASES_URL = "https://api.github.com/repos/JunesuChoi/omo-ui-windows/releases?per_page=100";
const DOWNLOAD_PREFIX = "/JunesuChoi/omo-ui-windows/releases/download/";
const CDN_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);
const METADATA_LIMIT = 2 * 1024 * 1024;
const CHECKSUM_LIMIT = 256 * 1024;
const INSTALLER_LIMIT = 512 * 1024 * 1024;
const REQUEST_TIMEOUT = 20_000;
const DOWNLOAD_TIMEOUT = 10 * 60_000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version: string): { core: bigint[]; pre: string[] } {
  const match = VERSION.exec(version);
  const pre = match?.[4]?.split(".") ?? [];
  if (!match || pre.some((part) => /^0\d+$/.test(part))) throw new Error(`Invalid app version: ${version}`);
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

interface Asset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

interface Release {
  tag_name: string;
  draft: boolean;
  assets: Asset[];
}

function assetUrl(asset: Asset, tag: string): string {
  const url = new URL(asset.browser_download_url);
  const expected = `${DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || url.pathname !== expected) {
    throw new Error("Installer assets must use this repository's HTTPS GitHub release URLs");
  }
  return url.href;
}

/** Public-release updater. Only an explicit install() downloads and launches an installer. */
export class AppUpdater {
  private status: AppUpdateStatus;
  private selected: { release: Release; asset: Asset } | null = null;
  private active: Promise<AppUpdateStatus> | null = null;
  private operation: "check" | "install" | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AppUpdaterOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.status = {
      state: (options.platform ?? process.platform) === "win32" ? "idle" : "unsupported",
      currentVersion: options.currentVersion, latestVersion: null, progress: null, message: null,
    };
  }

  getStatus(): AppUpdateStatus { return { ...this.status }; }

  private publish(state: AppUpdateStatus["state"], values: Partial<AppUpdateStatus> = {}): AppUpdateStatus {
    this.status = { ...this.status, state, progress: null, message: null, ...values };
    this.options.onStatus?.(this.getStatus());
    return this.getStatus();
  }

  check(): Promise<AppUpdateStatus> {
    if (this.active) return this.active;
    if (this.status.state === "unsupported" || this.status.state === "installing") return Promise.resolve(this.getStatus());
    return this.run("check", () => this.checkRelease());
  }

  install(): Promise<AppUpdateStatus> {
    if (this.active) {
      if (this.operation === "install") return this.active;
      return this.active.then(() => this.install());
    }
    if (this.status.state === "unsupported" || this.status.state === "installing") return Promise.resolve(this.getStatus());
    return this.run("install", () => this.installRelease());
  }

  private run(operation: "check" | "install", work: () => Promise<AppUpdateStatus>): Promise<AppUpdateStatus> {
    this.operation = operation;
    // Defer work until the guard is set, including synchronous status callbacks.
    this.active = Promise.resolve().then(work).catch((error: unknown) => this.publish("failed", {
      message: error instanceof Error ? error.message : String(error),
    })).finally(() => { this.active = null; this.operation = null; });
    return this.active;
  }

  private async request<T>(url: string, limit: number, timeout: number, consume: (response: Response, signal: AbortSignal) => Promise<T>, asset = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("App update request timed out")), timeout);
    try {
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        response = await this.fetchImpl(url, {
          signal: controller.signal, redirect: asset ? "manual" : "error",
          headers: { Accept: asset ? "application/octet-stream" : "application/vnd.github+json" },
        });
        if (!asset || ![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects >= 5) throw new Error("Invalid GitHub download redirect");
        const next = new URL(location, url);
        if (next.protocol !== "https:" || !CDN_HOSTS.has(next.hostname) || next.port || next.username || next.password) throw new Error("Unsafe GitHub download redirect");
        url = next.href;
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error("App update response exceeded its size limit");
      return await consume(response, controller.signal);
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response, signal: AbortSignal, limit: number, chunk: (bytes: Uint8Array) => Promise<void>): Promise<number> {
    if (!response.body) throw new Error("App update response has no body");
    const reader = response.body.getReader();
    const abort = (): void => { void reader.cancel(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    let total = 0;
    try {
      signal.throwIfAborted();
      for (;;) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > limit) throw new Error("App update response exceeded its size limit");
        await chunk(item.value);
      }
      const length = response.headers.get("content-length");
      // fetch decodes gzip/br bodies, so Content-Length counts encoded bytes; compare only identity bodies.
      const encoding = response.headers.get("content-encoding");
      const identity = encoding === null || encoding.trim().toLowerCase() === "identity";
      if (identity && length !== null && total !== Number(length)) throw new Error("Incomplete app update download");
      return total;
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel();
      reader.releaseLock();
    }
  }

  private async text(response: Response, signal: AbortSignal, limit: number): Promise<string> {
    const chunks: Uint8Array[] = [];
    await this.readBody(response, signal, limit, async (bytes) => { chunks.push(bytes); });
    return Buffer.concat(chunks).toString("utf8");
  }

  private async checkRelease(): Promise<AppUpdateStatus> {
    this.selected = null;
    this.publish("checking", { latestVersion: null });
    parseVersion(this.options.currentVersion);
    const releases: unknown = await this.request(this.options.apiUrl ?? RELEASES_URL, METADATA_LIMIT, REQUEST_TIMEOUT, async (response, signal) => {
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`GitHub releases request failed (${response.status})`);
      return JSON.parse(await this.text(response, signal, METADATA_LIMIT)) as unknown;
    });
    if (!Array.isArray(releases)) throw new Error("Invalid GitHub releases response");
    let latest: Release | undefined;
    let version = "";
    for (const value of releases) {
      if (!value || typeof value !== "object" || typeof value.draft !== "boolean" || typeof value.tag_name !== "string") throw new Error("Invalid GitHub release");
      if (value.draft) continue;
      const candidate = value.tag_name.replace(/^v/, "");
      parseVersion(candidate);
      if (!latest || compareVersions(candidate, version) > 0) { latest = value as Release; version = candidate; }
    }
    if (!latest) return this.publish("unpublished");
    if (compareVersions(version, this.options.currentVersion) <= 0) return this.publish("current", { latestVersion: version });
    if (!Array.isArray(latest.assets)) throw new Error("Invalid GitHub release assets");
    // GitHub replaces spaces in uploaded asset names with dots.
    const names = [`OmO UI Windows Setup ${version}.exe`, `OmO.UI.Windows.Setup.${version}.exe`];
    const name = names[1];
    const assets = latest.assets.filter((asset) => names.includes(asset?.name));
    const asset = assets[0];
    if (assets.length !== 1 || !asset) throw new Error(`Release has no unique Windows installer: ${name}`);
    assetUrl(asset, latest.tag_name);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > INSTALLER_LIMIT) throw new Error("Invalid Windows installer size");
    if (asset.digest != null && !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) throw new Error("Invalid installer SHA-256 digest");
    if (asset.digest == null && !latest.assets.some((item) => item?.name === "SHA256SUMS")) throw new Error("Release has no installer SHA-256 digest or SHA256SUMS");
    this.selected = { release: latest, asset };
    return this.publish("available", { latestVersion: version });
  }

  private async installRelease(): Promise<AppUpdateStatus> {
    if (!this.selected) await this.checkRelease();
    const selected = this.selected;
    if (!selected) return this.getStatus();
    const { release, asset } = selected;
    this.publish("downloading", { progress: 0 });
    let digest = asset.digest?.slice("sha256:".length).toLowerCase();
    if (!digest) {
      const sums = release.assets.filter((item) => item?.name === "SHA256SUMS");
      if (sums.length !== 1 || !sums[0]) throw new Error("Release has no unique SHA256SUMS asset");
      const text = await this.request(assetUrl(sums[0], release.tag_name), CHECKSUM_LIMIT, REQUEST_TIMEOUT, async (response, signal) => {
        if (!response.ok) throw new Error(`SHA256SUMS download failed (${response.status})`);
        return this.text(response, signal, CHECKSUM_LIMIT);
      }, true);
      const matches = text.split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line)).filter((match) => match?.[2] === asset.name);
      if (matches.length !== 1 || !matches[0]?.[1]) throw new Error("SHA256SUMS has no unique installer digest");
      digest = matches[0][1].toLowerCase();
    }
    await mkdir(this.options.downloadDir, { recursive: true });
    const destination = path.join(this.options.downloadDir, asset.name);
    const temporary = path.join(this.options.downloadDir, `${asset.name}.${randomUUID()}.part`);
    const file = await open(temporary, "wx");
    const hash = createHash("sha256");
    let received = 0;
    try {
      try {
        await this.request(assetUrl(asset, release.tag_name), INSTALLER_LIMIT, DOWNLOAD_TIMEOUT, async (response, signal) => {
          if (!response.ok) throw new Error(`Windows installer download failed (${response.status})`);
          await this.readBody(response, signal, asset.size, async (bytes) => {
            let offset = 0;
            while (offset < bytes.byteLength) {
              const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
              if (!bytesWritten) throw new Error("Unable to write Windows installer");
              offset += bytesWritten;
            }
            hash.update(bytes);
            received += bytes.byteLength;
            this.publish("downloading", { progress: Math.floor(received / asset.size * 100) });
          });
        }, true);
        if (received !== asset.size) throw new Error("Incomplete Windows installer download");
        if (hash.digest("hex") !== digest) throw new Error("Windows installer SHA-256 mismatch");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
    } catch (error) {
      // Keep failed partial downloads for inspection; they are never executable update candidates.
      throw error;
    }
    this.publish("ready", { progress: 100 });
    this.publish("installing", { progress: 100 });
    await this.options.launchInstaller(destination);
    return this.getStatus();
  }
}

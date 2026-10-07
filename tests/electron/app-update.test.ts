import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdater } from "../../electron/app-update";
import type { AppUpdateStatus, AppUpdaterOptions } from "../../electron/app-update";

const currentVersion = "0.1.4-win.2";
const version = "0.1.4-win.10";
const bytes = Buffer.from("local Windows installer fixture");
const digest = createHash("sha256").update(bytes).digest("hex");
const apiUrl = "https://api.github.com/repos/JunesuChoi/omo-ui-windows/releases?per_page=100";
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function release(value = version, overrides: Record<string, unknown> = {}) {
  const tag = `v${value}`;
  const name = `OmO UI Windows Setup ${value}.exe`;
  return {
    tag_name: tag, draft: false, prerelease: true,
    assets: [{ name, size: bytes.length, digest: `sha256:${digest}`, browser_download_url: assetUrl(tag, name) }],
    ...overrides,
  };
}

function assetUrl(tag: string, name: string): string {
  return `https://github.com/JunesuChoi/omo-ui-windows/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function setup(options: Partial<AppUpdaterOptions> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omo-app-update-"));
  dirs.push(dir);
  const statuses: AppUpdateStatus[] = [];
  const launch = vi.fn(async (_installer: string) => undefined);
  const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === apiUrl ? json([release()]) : new Response(bytes));
  const updater = new AppUpdater({
    currentVersion, downloadDir: dir, platform: "win32", fetch: fetcher,
    launchInstaller: launch, onStatus: (status) => statuses.push(status), ...options,
  });
  return { updater, dir, statuses, launch, fetcher };
}

describe("AppUpdater release checks", () => {
  it("accepts a decoded gzip release feed whose Content-Length counts compressed bytes", async () => {
    const body = JSON.stringify([release()]);
    const feed = () => new Response(body, { headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(Math.floor(body.length / 4)) } });
    const { updater } = await setup({ fetch: vi.fn(async (url) => String(url) === apiUrl ? feed() : new Response(bytes)) });
    expect(await updater.check()).toMatchObject({ state: "available", latestVersion: version });
  });

  it("installs the GitHub-renamed dotted installer asset", async () => {
    const tag = `v${version}`;
    const dotted = `OmO.UI.Windows.Setup.${version}.exe`;
    const feed = release(version, { assets: [{ name: dotted, size: bytes.length, digest: `sha256:${digest}`, browser_download_url: assetUrl(tag, dotted) }] });
    const { updater, launch } = await setup({ fetch: vi.fn(async (url) => String(url) === apiUrl ? json([feed]) : new Response(bytes)) });
    expect((await updater.install()).state).toBe("installing");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("starts idle and returns independent status snapshots without an automatic check", async () => {
    const { updater, fetcher } = await setup();
    expect(updater.getStatus()).toEqual({ state: "idle", currentVersion, latestVersion: null, progress: null, message: null });
    updater.getStatus().state = "failed";
    expect(updater.getStatus().state).toBe("idle");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes unsupported platforms without network or installer execution", async () => {
    const { updater, fetcher, launch } = await setup({ platform: "darwin" });
    expect((await updater.check()).state).toBe("unsupported");
    expect((await updater.install()).state).toBe("unsupported");
    expect(fetcher).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([json([]), json([], 404), json([release(version, { draft: true })])])("reports unpublished without launching for an empty, missing, or draft-only release feed", async (response) => {
    const { updater, launch } = await setup({ fetch: vi.fn(async () => response.clone()) });
    expect((await updater.check()).state).toBe("unpublished");
    expect((await updater.install()).state).toBe("unpublished");
    expect(launch).not.toHaveBeenCalled();
  });

  it("includes prereleases, excludes drafts, and compares win.N numerically independent of API order", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json([
      release("0.1.4-win.9"), release("9.0.0", { draft: true }), release(version), release("0.1.4-win.3"),
    ]));
    const { updater, launch } = await setup({ fetch: fetcher });
    expect(await updater.check()).toMatchObject({ state: "available", latestVersion: version });
    expect(launch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(apiUrl, expect.objectContaining({ redirect: "error", headers: { Accept: "application/vnd.github+json" } }));
  });

  it.each([
    ["0.1.4-win.1", "current"], [currentVersion, "current"], ["0.1.4-win.2+build.10", "current"],
    ["0.1.4-win.10", "available"], ["0.1.4", "available"], ["0.1.10-win.1", "available"],
  ])("handles SemVer %s", async (target, state) => {
    const { updater } = await setup({ fetch: async () => json([release(target)]) });
    expect(await updater.check()).toMatchObject({ state, latestVersion: target });
  });

  it.each([
    [json({}, 200)], [json([], 403)], [json([], 500)], [json([release("0.1.4-win.01")])],
    [json([release("bad")])], [new Response("not json")],
    [json([release(version, { assets: [] })])],
    [json([release(version, { assets: [{ ...release().assets[0], digest: undefined }] })])],
    [json([release(version, { assets: [{ ...release().assets[0], digest: "md5:invalid" }] })])],
    [json([release(version, { assets: [{ ...release().assets[0], size: 512 * 1024 * 1024 + 1 }] })])],
  ])("rejects invalid release metadata without an installer launch", async (response) => {
    const { updater, launch } = await setup({ fetch: async () => response });
    expect((await updater.check()).state).toBe("failed");
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    "http://github.com/JunesuChoi/omo-ui-windows/releases/download/v0.1.4-win.10/installer.exe",
    "https://github.com/other/repo/releases/download/v0.1.4-win.10/installer.exe",
    "https://evil.example/installer.exe",
    assetUrl(`v${version}`, `OmO UI Windows Setup ${version}.exe`) + "?token=secret",
  ])("rejects untrusted initial download URL %s", async (url) => {
    const metadata = release(version, { assets: [{ ...release().assets[0], browser_download_url: url }] });
    const { updater, launch } = await setup({ fetch: async () => json([metadata]) });
    expect((await updater.check()).state).toBe("failed");
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    new Response("[]", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }),
    new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } })),
  ])("bounds metadata by headers and actual streamed bytes", async (response) => {
    const { updater } = await setup({ fetch: async () => response });
    expect(await updater.check()).toMatchObject({ state: "failed", message: expect.stringContaining("size limit") });
  });

  it("permits another check after a failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(json([release()]));
    const { updater } = await setup({ fetch: fetcher });
    expect((await updater.check()).state).toBe("failed");
    expect((await updater.check()).state).toBe("available");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("times out an aborted network check at the exact request deadline", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    const fetcher: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      started();
    });
    const { updater } = await setup({ fetch: fetcher });
    const checking = updater.check();
    await requested;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await checking).toMatchObject({ state: "failed", message: expect.stringContaining("timed out") });
  });
});

describe("AppUpdater verified installation", () => {
  it("uses a real local HTTP release feed and streamed installer with a permitted GitHub CDN redirect", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/releases") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify([release()]));
      } else if (request.url?.startsWith("/JunesuChoi/")) {
        response.writeHead(302, { Location: "https://release-assets.githubusercontent.com/installer" });
        response.end();
      } else if (request.url === "/installer") {
        response.writeHead(200, { "Content-Length": bytes.length });
        response.write(bytes.subarray(0, 7));
        response.end(bytes.subarray(7));
      } else { response.writeHead(404); response.end(); }
    });
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      return fetch(origin + url.pathname, init);
    };
    try {
      const { updater, launch, dir, statuses } = await setup({ apiUrl: origin + "/releases", fetch: fetcher });
      expect((await updater.install()).state).toBe("installing");
      const installer = path.join(dir, release().assets[0]!.name);
      expect(launch).toHaveBeenCalledExactlyOnceWith(installer);
      expect(await readFile(installer)).toEqual(bytes);
      expect(await readdir(dir)).toEqual([release().assets[0]!.name]);
      expect(statuses.map((status) => status.state)).toEqual(expect.arrayContaining(["checking", "available", "downloading", "ready", "installing"]));
      expect(requests).toHaveLength(3);
      await updater.install();
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports deterministic chunk progress and only exposes the final file after verification", async () => {
    const fetcher: typeof fetch = async (url) => {
      if (String(url) === apiUrl) return json([release()]);
      let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) { controller.close(); return; }
          const end = Math.min(offset + 3, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }), { headers: { "Content-Length": String(bytes.length) } });
    };
    const { updater, statuses, dir } = await setup({ fetch: fetcher });
    expect((await updater.install()).state).toBe("installing");
    const progress = statuses.filter((status) => status.state === "downloading").map((status) => status.progress!);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(100);
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.every((value, i) => value >= 0 && value <= 100 && (i === 0 || value >= progress[i - 1]!))).toBe(true);
    expect((await readdir(dir)).some((name) => name.endsWith(".part"))).toBe(false);
  });

  it("uses an attached SHA256SUMS when GitHub asset digest is absent", async () => {
    const metadata = release();
    const assets = [
      { ...metadata.assets[0], digest: null },
      { name: "SHA256SUMS", size: 100, browser_download_url: assetUrl(metadata.tag_name, "SHA256SUMS") },
    ];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === apiUrl) return json([{ ...metadata, assets }]);
      if (String(url).endsWith("/SHA256SUMS")) return new Response(`${"0".repeat(64)}  other.exe\n${digest.toUpperCase()} *${metadata.assets[0]!.name}\n`);
      return new Response(bytes);
    });
    const { updater, launch } = await setup({ fetch: fetcher });
    expect((await updater.install()).state).toBe("installing");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["wrong.exe", "duplicate", "malformed"])("never downloads an installer for unusable SHA256SUMS (%s)", async (mode) => {
    const metadata = release();
    const installer = { ...metadata.assets[0], digest: null };
    const sums = { name: "SHA256SUMS", size: 100, browser_download_url: assetUrl(metadata.tag_name, "SHA256SUMS") };
    const line = `${digest}  ${installer.name}`;
    const text = mode === "wrong.exe" ? `${digest}  wrong.exe` : mode === "duplicate" ? `${line}\n${line}` : "malformed";
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === apiUrl ? json([{ ...metadata, assets: [installer, sums] }]) : new Response(text));
    const { updater, launch } = await setup({ fetch: fetcher });
    expect((await updater.install()).state).toBe("failed");
    expect(launch).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["mismatch", () => new Response(Buffer.alloc(bytes.length, 1))],
    ["truncated", () => new Response(bytes.subarray(0, 5))],
    ["oversized", () => new Response(Buffer.alloc(bytes.length + 1))],
    ["bad length", () => new Response(bytes, { headers: { "Content-Length": String(bytes.length + 1) } })],
    ["large header", () => new Response(bytes, { headers: { "Content-Length": String(512 * 1024 * 1024 + 1) } })],
    ["HTTP error", () => new Response("missing", { status: 404 })],
    ["stream error", () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket lost")); } }))],
  ] as const)("does not launch or leave executable files after %s", async (_mode, response) => {
    const { updater, launch, dir } = await setup({ fetch: async (url) => String(url) === apiUrl ? json([release()]) : response() });
    expect((await updater.install()).state).toBe("failed");
    expect(launch).not.toHaveBeenCalled();
    expect((await readdir(dir)).every((name) => name.endsWith(".part"))).toBe(true);
  });

  it.each(["http://release-assets.githubusercontent.com/file", "https://evil.example/file", "https://github.com:444/file"])("rejects unsafe redirects to %s", async (location) => {
    const { updater, launch, dir } = await setup({ fetch: async (url) => String(url) === apiUrl ? json([release()]) : new Response(null, { status: 302, headers: { Location: location } }) });
    expect((await updater.install()).state).toBe("failed");
    expect(launch).not.toHaveBeenCalled();
    expect((await readdir(dir)).every((name) => name.endsWith(".part"))).toBe(true);
  });

  it("bounds redirect loops", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === apiUrl ? json([release()]) : new Response(null, { status: 302, headers: { Location: String(url) } }));
    const { updater, launch } = await setup({ fetch: fetcher });
    expect((await updater.install()).state).toBe("failed");
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(launch).not.toHaveBeenCalled();
  });

  it("deduplicates checks and queues concurrent installs behind a check, launching once", async () => {
    let respond!: (response: Response) => void;
    const feed = new Promise<Response>((resolve) => { respond = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url) === apiUrl ? feed : new Response(bytes));
    const { updater, launch } = await setup({ fetch: fetcher });
    const first = updater.check();
    expect(updater.check()).toBe(first);
    const installA = updater.install();
    const installB = updater.install();
    respond(json([release()]));
    expect((await first).state).toBe("available");
    expect((await installA).state).toBe("installing");
    expect((await installB).state).toBe("installing");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("turns launch failures into retryable failed status", async () => {
    const launch = vi.fn<(installer: string) => Promise<void>>().mockRejectedValueOnce(new Error("development install disabled")).mockResolvedValueOnce(undefined);
    const { updater } = await setup({ launchInstaller: launch });
    expect(await updater.install()).toMatchObject({ state: "failed", message: "development install disabled" });
    expect((await updater.check()).state).toBe("available");
    expect((await updater.install()).state).toBe("installing");
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("times out a stalled stream, closes its writer, and does not launch", async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => { started = resolve; });
    const fetcher: typeof fetch = async (url) => String(url) === apiUrl ? json([release()]) : new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 1)); started(); },
    }));
    const { updater, launch, dir } = await setup({ fetch: fetcher });
    const installing = updater.install();
    await downloading;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await installing).toMatchObject({ state: "failed", message: expect.stringContaining("timed out") });
    expect(launch).not.toHaveBeenCalled();
    expect((await readdir(dir)).every((name) => name.endsWith(".part"))).toBe(true);
  });
});

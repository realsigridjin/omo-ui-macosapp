import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loginCommand, loginScript, openLogin } from "../../electron/accounts/login";
import { readAccountUsage, usageSlots, type UsageFetch } from "../../electron/accounts/usage";

const NOW = Date.parse("2026-10-06T00:00:00.000Z");
const LATER = NOW + 3_600_000;

describe("usageSlots", () => {
  it("lists pooled accounts, falls back to the flat entry, and treats omo's SDK sentinel as no token", () => {
    const slots = usageSlots({
      "anthropic-subscription": {
        access: "claude-sdk-oauth-managed",
        accounts: [{ name: "work", access: "a1", expires: LATER }, { name: "sdk", access: "claude-sdk-oauth-managed" }],
      },
      "chatgpt-subscription": { access: "g1", accountId: "acct", expires: LATER },
      deepseek: { key: "ignored" },
    });
    expect(slots).toEqual([
      { provider: "anthropic-subscription", account: "work", token: "a1", expires: LATER, accountId: null },
      { provider: "anthropic-subscription", account: "sdk", token: null, expires: null, accountId: null },
      { provider: "chatgpt-subscription", account: "default", token: "g1", expires: LATER, accountId: "acct" },
    ]);
  });
});

describe("readAccountUsage", () => {
  let dir = "";
  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  async function withAuth(auth: unknown): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "omo-ui-accounts-"));
    await writeFile(path.join(dir, "auth.json"), JSON.stringify(auth));
    return dir;
  }

  const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });

  it("reads Claude and ChatGPT windows with each account's own token and isolates failures", async () => {
    const agentDir = await withAuth({
      "anthropic-subscription": { accounts: [
        { name: "work", access: "a1", expires: LATER },
        { name: "old", access: "a2", expires: NOW - 1 },
        { name: "broken", access: "a3", expires: LATER },
      ] },
      "chatgpt-subscription": { accounts: [{ name: "plus", access: "g1", accountId: "acct", expires: LATER }] },
    });
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch: UsageFetch = (url, init) => {
      seen.push({ url, headers: init.headers });
      if (init.headers["authorization"] === "Bearer a3") return respond(500, {});
      if (url.includes("anthropic")) {
        return respond(200, {
          five_hour: { utilization: 42, resets_at: "2026-10-06T03:00:00Z" },
          seven_day: { utilization: 0, resets_at: null },
          seven_day_opus: { utilization: 100, resets_at: "2026-10-09T00:00:00Z", locked_reason: "limit" },
          extra_usage: { is_enabled: false },
        });
      }
      return respond(200, {
        email: "me@example.com", plan_type: "plus",
        rate_limit: { limit_reached: false, primary_window: { used_percent: 12, reset_at: 1_791_300_000, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 30, reset_at: 1_791_800_000, limit_window_seconds: 604_800 } },
      });
    };
    const rows = await readAccountUsage({ agentDir, fetch, now: () => NOW });
    expect(rows.map((row) => [row.account, row.state])).toEqual([["work", "ok"], ["old", "expired"], ["broken", "failed"], ["plus", "ok"]]);
    expect(rows[0]?.windows).toEqual([
      { label: "5h", percent: 42, resetsAt: "2026-10-06T03:00:00Z", limited: false },
      { label: "weekly opus", percent: 100, resetsAt: "2026-10-09T00:00:00Z", limited: true },
    ]);
    expect(rows[2]?.message).toBe("HTTP 500");
    expect(rows[3]).toMatchObject({ email: "me@example.com", plan: "plus" });
    expect(rows[3]?.windows.map((window) => [window.label, window.percent])).toEqual([["5h", 12], ["weekly", 30]]);
    expect(seen.map((call) => call.headers["authorization"])).toEqual(["Bearer a1", "Bearer a3", "Bearer g1"]);
    expect(seen[2]?.headers["chatgpt-account-id"]).toBe("acct");
  });

  it("reads a rejected token as expired and a missing store as no accounts", async () => {
    const agentDir = await withAuth({ "chatgpt-subscription": { access: "g1", expires: LATER } });
    const rows = await readAccountUsage({ agentDir, fetch: () => respond(401, {}), now: () => NOW });
    expect(rows.map((row) => row.state)).toEqual(["expired"]);
    await expect(readAccountUsage({ agentDir: path.join(agentDir, "missing") })).resolves.toEqual([]);
  });
});

describe("login", () => {
  it("runs omo's own sign-in command for each provider", () => {
    expect(loginCommand("anthropic-subscription")).toBe("/claude-account add");
    expect(loginCommand("chatgpt-subscription")).toBe("/gpt-account add");
    expect(loginCommand("kimi-coding")).toBe("/login");
  });

  it("quotes the omo path for the shell and the AppleScript string", async () => {
    const script = loginScript(`/Users/a "b"/it's/omo`, "anthropic-subscription");
    expect(script).toContain(`do script "cd ~ && '/Users/a \\"b\\"/it'\\\\''s/omo' '/claude-account add'"`);
    const calls: Array<[string, string[]]> = [];
    await openLogin("/bin/omo", "kimi-coding", async (file: string, args: string[]) => {
      calls.push([file, args]);
      return { stdout: "", stderr: "" };
    }, "darwin");
    expect(calls).toEqual([["/usr/bin/osascript", ["-e", loginScript("/bin/omo", "kimi-coding")]]]);
  });

  it("opens an interactive Windows console with an encoded command and a literal executable path", async () => {
    const calls: Array<[string, string[]]> = [];
    await openLogin("C:\\Users\\it's $me & more\\omo.exe", "chatgpt-subscription", async (file, args) => {
      calls.push([file, args]);
    }, "win32");
    expect(calls[0]?.[0]).toBe("powershell.exe");
    expect(calls[0]?.[1].slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const launcher = Buffer.from(calls[0]?.[1].at(-1) ?? "", "base64").toString("utf16le");
    expect(launcher).toContain("Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe')");
    expect(launcher).toContain("-NoExit -EncodedCommand");
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)'$/.exec(launcher)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Set-Location -LiteralPath $HOME; & 'C:\\Users\\it''s $me & more\\omo.exe' '/gpt-account add'");
  });
});

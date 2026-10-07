import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** omo's own interactive sign-in command for a provider; other providers use the general `/login` picker. */
export function loginCommand(provider: string): string {
  if (provider === "anthropic-subscription") return "/claude-account add";
  if (provider === "chatgpt-subscription") return "/gpt-account add";
  return "/login";
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const appleScriptString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The AppleScript that opens a Terminal window running `omoPath` with the sign-in command as its first input. */
export function loginScript(omoPath: string, provider: string): string {
  const command = `cd ~ && ${shellQuote(omoPath)} ${shellQuote(loginCommand(provider))}`;
  return `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`;
}

/** Runs a program with arguments and resolves when it exits successfully. */
export type RunFile = (file: string, args: string[]) => Promise<unknown>;

/** Opens omo in Terminal for an interactive sign-in; omo stores the account itself. */
export async function openLogin(omoPath: string, provider: string, run: RunFile = execFileAsync, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const command = `Set-Location -LiteralPath $HOME; & ${quote(omoPath)} ${quote(loginCommand(provider))}`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    // Start-Process creates an interactive console; only fixed flags and base64 cross its argument-string boundary.
    const launcher = `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo -NoProfile -NoExit -EncodedCommand ${encoded}'`;
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")]);
  } else {
    await run("/usr/bin/osascript", ["-e", loginScript(omoPath, provider)]);
  }
}

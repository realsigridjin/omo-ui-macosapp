import { describe, expect, it } from "vitest";
import { createGit } from "../../electron/git-info";

interface Call {
  file: string;
  args: readonly string[];
}

function harness(respond: (args: readonly string[]) => string, options: { directories?: readonly string[] } = {}) {
  const directories = options.directories ?? ["/repo/app"];
  const calls: Call[] = [];
  const git = createGit({
    exec: async (file, args) => {
      calls.push({ file, args });
      return respond(args);
    },
    statPath: async (target) => {
      if (!directories.includes(target)) throw new Error(`ENOENT: ${target}`);
      return { isDirectory: () => true };
    },
  });
  return { git, calls };
}

const gitRun = (responses: Record<string, string | Error>): ((args: readonly string[]) => string) => {
  return (args) => {
    const key = args.filter((part) => part !== "-C" && part !== "/repo/app").join(" ");
    const value = responses[key];
    if (value === undefined) throw new Error(`unexpected git invocation: ${key}`);
    if (value instanceof Error) throw value;
    return value;
  };
};

describe("createGit", () => {
  it("resolves null outside a git work tree", async () => {
    const { git } = harness(gitRun({ "rev-parse --show-toplevel": new Error("fatal: not a git repository") }));
    await expect(git.info("/repo/app")).resolves.toBeNull();
  });

  it("reads branch, root, and upstream ahead/behind", async () => {
    const { git } = harness(
      gitRun({
        "rev-parse --show-toplevel": "/repo/app\n",
        "branch --show-current": "feature/branch\n",
        "rev-list --left-right --count @{upstream}...HEAD": "2\t5\n",
      }),
    );
    await expect(git.info("/repo/app")).resolves.toEqual({ branch: "feature/branch", root: "/repo/app", ahead: 5, behind: 2 });
  });

  it("reports the short sha for a detached HEAD", async () => {
    const { git } = harness(
      gitRun({
        "rev-parse --show-toplevel": "/repo/app\n",
        "branch --show-current": "\n",
        "rev-parse --short HEAD": "9f8e7d6\n",
      }),
    );
    await expect(git.info("/repo/app")).resolves.toEqual({ branch: "9f8e7d6", root: "/repo/app", ahead: null, behind: null });
  });

  it("leaves ahead/behind null without an upstream", async () => {
    const { git } = harness(
      gitRun({
        "rev-parse --show-toplevel": "/repo/app\n",
        "branch --show-current": "main\n",
        "rev-list --left-right --count @{upstream}...HEAD": new Error("fatal: no upstream configured"),
      }),
    );
    await expect(git.info("/repo/app")).resolves.toEqual({ branch: "main", root: "/repo/app", ahead: null, behind: null });
  });

  it("rejects relative or missing directories", async () => {
    const { git } = harness(() => "");
    await expect(git.info("repo/app")).rejects.toThrow("absolute");
    await expect(git.info("/repo/missing")).rejects.toThrow("does not exist");
  });

  it("lists porcelain status lines", async () => {
    const { git } = harness(gitRun({ "status --porcelain": " M src/a.ts\n?? notes.txt\n" }));
    await expect(git.status("/repo/app")).resolves.toEqual([" M src/a.ts", "?? notes.txt"]);
  });

  it("stages, commits, and pushes in order", async () => {
    const { git, calls } = harness(
      gitRun({
        "add -A": "",
        "commit -m write notes": "[main abc1234] write notes\n",
        "rev-parse --short HEAD": "abc1234\n",
        push: "",
      }),
    );
    await expect(git.commitAndPush("/repo/app", "write notes", true)).resolves.toEqual({
      committed: true,
      pushed: true,
      pushSkipped: null,
      commitHash: "abc1234",
    });
    expect(calls.map((call) => call.args.filter((part) => part !== "-C" && part !== "/repo/app").join(" "))).toEqual([
      "add -A",
      "commit -m write notes",
      "rev-parse --short HEAD",
      "push",
    ]);
  });

  it("reports nothing to commit instead of failing", async () => {
    const { git } = harness(
      gitRun({
        "add -A": "",
        "commit -m empty": new Error("nothing to commit, working tree clean"),
      }),
    );
    await expect(git.commitAndPush("/repo/app", "empty", false)).resolves.toEqual({
      committed: false,
      pushed: false,
      pushSkipped: null,
      commitHash: null,
    });
  });

  it("skips and reports a push without an upstream", async () => {
    const { git } = harness(
      gitRun({
        "add -A": "",
        "commit -m local only": "[main def5678] local only\n",
        "rev-parse --short HEAD": "def5678\n",
        push: new Error("fatal: The current branch main has no upstream branch"),
      }),
    );
    await expect(git.commitAndPush("/repo/app", "local only", true)).resolves.toEqual({
      committed: true,
      pushed: false,
      pushSkipped: "no-upstream",
      commitHash: "def5678",
    });
  });

  it("rejects with git's error for other push failures", async () => {
    const { git } = harness(
      gitRun({
        "add -A": "",
        "commit -m bad push": "[main abc1234] bad push\n",
        "rev-parse --short HEAD": "abc1234\n",
        push: new Error("fatal: Authentication failed"),
      }),
    );
    await expect(git.commitAndPush("/repo/app", "bad push", true)).rejects.toThrow("Authentication failed");
  });

  it("rejects an empty commit message", async () => {
    const { git } = harness(() => "");
    await expect(git.commitAndPush("/repo/app", "  ", false)).rejects.toThrow("non-empty");
  });
});

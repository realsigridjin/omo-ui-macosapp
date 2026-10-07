import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTaskWork, taskStore } from "../../electron/history/task-work";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "dag-work-"));
  dirs.push(dir);
  const agent = path.join(dir, "agent");
  const cwd = path.join(dir, "project");
  await mkdir(cwd);
  const store = await taskStore(agent, cwd);
  await mkdir(path.join(store, "tasks"), { recursive: true });
  return { dir, agent, cwd, store };
}
function record(id: string, parent: string, child: string) {
  return { task_id: id, parent_session_id: parent, child_session_id: child, status: "running", depth: 1, execution_mode: "in-process",
    residency_state: "resident", model: "provider/model", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z",
    spawn_spec: { prompt: "Private prompt must not cross IPC" } };
}
async function save(store: string, value: ReturnType<typeof record>) {
  await writeFile(path.join(store, "tasks", `${value.task_id}.json`), JSON.stringify(value));
}
describe("read-only native child work", () => {
  it("reads host-session children from their native task sessions directory", async () => {
    const { agent, cwd, store } = await fixture();
    const directory = path.join(store, "children", "st_host", "sessions", "st_host");
    await mkdir(directory, { recursive: true });
    const sessionPath = path.join(directory, "host.jsonl");
    await writeFile(sessionPath, [
      { type: "session", id: "s1" },
      { type: "custom", id: "todo", parentId: null, customType: "senpi.todo-state",
        data: { schema: "v2", phases: [{ name: "Host work", tasks: [] }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await writeFile(path.join(store, "tasks", "host.json"), JSON.stringify({
      ...record("st_host", "root", "s1"), host_session: { session_path: sessionPath },
    }));
    expect((await loadTaskWork(agent, cwd, "root"))[0]?.todo?.phases[0]?.name).toBe("Host work");
  });
  it("projects native todo and tail from the active branch and traverses explicit child sessions", async () => {
    const { agent, cwd, store } = await fixture();
    await save(store, record("st_parent", "root", "s1"));
    await save(store, record("st_child", "s1", "s2"));
    await save(store, record("st_foreign", "foreign-root", "s3"));
    const directory = path.join(store, "children", "st_parent", "sessions", "st_parent");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "now_s1.jsonl"), [
      { type: "session", id: "s1" },
      { type: "custom", customType: "senpi.todo-state", id: "old", parentId: null,
        data: { schema: "v2", phases: [{ name: "Old branch", tasks: [] }] } },
      { type: "custom", customType: "senpi.todo-state", id: "current", parentId: null,
        data: { schema: "v2", phases: [{ name: "Verify", tasks: [{ content: "Run tests", status: "in_progress" }] }] } },
      { type: "message", id: "tail", parentId: "current", message: { role: "assistant", content: [{ type: "text", text: "Testing\nnow" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const result = await loadTaskWork(agent, cwd, "root");
    expect(result.map((work) => work.task.task_id)).toEqual(["st_parent", "st_child"]);
    expect(result[0]?.todo?.phases[0]?.name).toBe("Verify");
    expect(result[0]?.activity).toBe("Testing now");
    expect(result[0]?.task).not.toHaveProperty("spawn_spec");
  });
  it("ignores incomplete and malformed records without inventing todos", async () => {
    const { agent, cwd, store } = await fixture();
    await save(store, record("st_parent", "root", "s1"));
    await writeFile(path.join(store, "tasks", "partial.json"), '{"task_id":');
    await writeFile(path.join(store, "tasks", "bad.json"), '{"parent_session_id":"root","task_id":99}');
    const result = await loadTaskWork(agent, cwd, "root");
    expect(result).toHaveLength(1);
    expect(result[0]?.todo).toBeNull();
    expect(result[0]?.activity).toBeNull();
  });
  it("does not traverse symlinked task records and rejects escaping host session paths", async () => {
    const { dir, agent, cwd, store } = await fixture();
    const outside = path.join(dir, "outside.json");
    await writeFile(outside, JSON.stringify(record("st_external", "root", "s1")));
    if (process.platform === "win32") {
      await symlink(dir, path.join(store, "tasks", "external.json"), "junction");
    } else {
      await symlink(outside, path.join(store, "tasks", "external.json"));
    }
    expect(await loadTaskWork(agent, cwd, "root")).toEqual([]);
    await mkdir(path.join(agent, "sessions"), { recursive: true });
    await writeFile(path.join(store, "tasks", "host.json"), JSON.stringify({
      ...record("st_host", "root", "s1"), host_session: { session_path: outside },
    }));
    await expect(loadTaskWork(agent, cwd, "root")).rejects.toThrow("outside its native store");
  });
  it("prefers existing legacy stores and rejects unsafe session input", async () => {
    const { agent, cwd } = await fixture();
    const legacy = path.join(cwd, ".omo", "senpi-task");
    await mkdir(legacy, { recursive: true });
    expect(await taskStore(agent, cwd)).toBe(await realpath(legacy));
    expect(await loadTaskWork(agent, cwd, "root")).toEqual([]);
    await expect(loadTaskWork(agent, cwd, "../escape")).rejects.toThrow("Invalid child work");
  });
});

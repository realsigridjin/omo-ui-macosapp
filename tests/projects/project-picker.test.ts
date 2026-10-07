import { describe, expect, it } from "vitest";
import type { ThreadSummary, WorkspaceGroup } from "../../src/state";
import { projectPicker } from "../../src/ui/projects/picker-store";
import { initialProject, listProjects } from "../../src/ui/projects/project-list";

function group(cwd: string, threadCount: number): WorkspaceGroup {
  const threads = Array.from({ length: threadCount }, (_, index): ThreadSummary => ({
    id: `${cwd}#${index}`,
    cwd,
    name: null,
    preview: "",
    updatedAt: 0,
    status: { type: "idle" },
    path: null,
    source: null,
  }));
  return { cwd, label: cwd, threads };
}

describe("listProjects", () => {
  it("lists workspaces with threads in sidebar order, then recent folders without threads", () => {
    const projects = listProjects([group("/w/server", 3), group("/w/client", 1)], ["/w/docs", "/w/client", "/w/tools"]);
    expect(projects).toEqual([
      { cwd: "/w/server", threadCount: 3 },
      { cwd: "/w/client", threadCount: 1 },
      { cwd: "/w/docs", threadCount: 0 },
      { cwd: "/w/tools", threadCount: 0 },
    ]);
  });

  it("lists a Windows folder once, under its thread spelling, however the sources spell it", () => {
    const groups = [group("P:\\coding\\omo-ui", 2), group("p:/coding/omo-ui", 1)];
    expect(listProjects(groups, ["P:\\Coding\\omo-ui\\", "P:\\coding\\other"])).toEqual([
      { cwd: "P:\\coding\\omo-ui", threadCount: 3 },
      { cwd: "P:\\coding\\other", threadCount: 0 },
    ]);
  });

  it("keeps POSIX folders that differ only in case apart", () => {
    const projects = listProjects([group("/w/App", 1)], ["/w/app", "/w/App/"]);
    expect(projects.map((project) => project.cwd)).toEqual(["/w/App", "/w/app"]);
  });
});

describe("initialProject", () => {
  const projects = listProjects([group("/w/server", 1)], ["/w/docs"]);

  it("selects the last workspace when it is listed", () => {
    expect(initialProject(projects, "/w/docs/")?.cwd).toBe("/w/docs");
  });

  it("falls back to the first project, or null for an empty list", () => {
    expect(initialProject(projects, "/w/gone")?.cwd).toBe("/w/server");
    expect(initialProject(projects, null)?.cwd).toBe("/w/server");
    expect(initialProject([], "/w/docs")).toBeNull();
  });
});

describe("projectPicker", () => {
  it("joins a second request to the open one and resolves it with the started thread", async () => {
    const openStates: boolean[] = [];
    const unsubscribe = projectPicker.subscribe(() => openStates.push(projectPicker.isOpen()));
    const first = projectPicker.request();
    expect(projectPicker.request()).toBe(first);
    projectPicker.settle("thread-1");
    unsubscribe();
    await expect(first).resolves.toBe("thread-1");
    expect(openStates).toEqual([true, false]);
  });

  it("dismisses a pending request when the last host unmounts", async () => {
    expect(projectPicker.hasHost()).toBe(false);
    const unmountFirst = projectPicker.registerHost();
    const unmountSecond = projectPicker.registerHost();
    const request = projectPicker.request();
    unmountFirst();
    expect(projectPicker.isOpen()).toBe(true);
    unmountSecond();
    expect(projectPicker.hasHost()).toBe(false);
    await expect(request).resolves.toBeNull();
  });
});

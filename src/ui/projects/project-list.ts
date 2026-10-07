import type { WorkspaceGroup } from "../../state";

/** One row of the project picker: a directory a new thread can start in. */
export interface ProjectEntry {
  /** Directory handed to `actions.newThread`. */
  cwd: string;
  /** Main threads the sidebar lists for this directory; 0 for a folder known only from the recent workspaces. */
  threadCount: number;
}

/**
 * Identity of a directory across the two sources that spell it, omo's thread cwd and the folder picker's path:
 * trailing separators are dropped, and a Windows path (drive letter or UNC) also ignores case and separator style.
 */
function projectKey(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  return /^[A-Za-z]:[/\\]|^\\\\/.test(cwd) ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
}

/**
 * The directories a new thread can start in: every workspace with listed threads, in sidebar order, then the recent
 * workspaces that have none, newest first. A directory both sources know is listed once, under its thread spelling.
 */
export function listProjects(groups: readonly WorkspaceGroup[], recentWorkspaces: readonly string[]): ProjectEntry[] {
  const projects = new Map<string, ProjectEntry>();
  for (const group of groups) {
    const key = projectKey(group.cwd);
    const known = projects.get(key);
    if (known === undefined) projects.set(key, { cwd: group.cwd, threadCount: group.threads.length });
    else known.threadCount += group.threads.length;
  }
  for (const cwd of recentWorkspaces) {
    const key = projectKey(cwd);
    if (!projects.has(key)) projects.set(key, { cwd, threadCount: 0 });
  }
  return [...projects.values()];
}

/** The project selected when the picker opens: the last workspace when it is listed, else the first project. */
export function initialProject(projects: readonly ProjectEntry[], lastWorkspace: string | null): ProjectEntry | null {
  const lastKey = lastWorkspace === null ? null : projectKey(lastWorkspace);
  return projects.find((project) => projectKey(project.cwd) === lastKey) ?? projects[0] ?? null;
}

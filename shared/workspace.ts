/** Workspace-relative paths, with Git porcelain status (empty for unchanged files). */
export interface WorkspaceFile {
  path: string;
  status: string;
}

export interface WorkspaceDocument {
  path: string;
  text: string;
  language: string;
}

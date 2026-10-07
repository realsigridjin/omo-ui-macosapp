export interface AppUpdateStatus {
  state: "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "failed" | "unpublished" | "unsupported";
  currentVersion: string;
  latestVersion: string | null;
  progress: number | null;
  message: string | null;
}

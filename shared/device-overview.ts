export interface DeviceOverview {
  hostname: string;
  platform: string;
  appVersion: string;
  omoVersion: string | null;
  memory: {
    path: string | null;
    branch: string | null;
    lastCommitAt: string | null;
    changedFiles: number;
    remoteConfigured: boolean;
    state: "available" | "unavailable";
  };
}

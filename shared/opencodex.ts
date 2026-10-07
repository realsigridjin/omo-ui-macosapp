export interface OpencodexAccount {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  active: boolean;
  paused: boolean;
  needsReauth: boolean;
}

export interface OpencodexAccounts {
  baseUrl: string;
  accounts: OpencodexAccount[];
  error: string | null;
}

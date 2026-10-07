export interface AndroidDevice {
  serial: string;
  name: string;
  state: "ready" | "unauthorized" | "offline";
}

export interface AndroidStatus {
  adbAvailable: boolean;
  state: "disabled" | "searching" | "connected" | "error";
  devices: AndroidDevice[];
  selectedSerial: string | null;
  /** Phone-local URL carrying a bearer token in its fragment. Never log this value. */
  url: string | null;
  message: string | null;
}

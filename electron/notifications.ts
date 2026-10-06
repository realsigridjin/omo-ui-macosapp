import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Notification } from "electron";
import type { BrowserWindow } from "electron";
import { ENV } from "../shared/ipc";
import type { NotifyPayload } from "../shared/ipc";

export interface ThreadNotificationDeps {
  getWindow(): BrowserWindow | null;
  /** Called when the user clicks the notification; the implementation focuses the window and opens the thread. */
  onActivate(threadId: string): void;
}

/**
 * Shows one macOS notification for a thread outcome. While OMO_UI_QA_NOTIFY_LOG names a file, every shown
 * notification is also appended there as a JSON line so e2e can observe what the user would have seen.
 * Clicking focuses the window and reports `threadId` through `onActivate`.
 */
export function showThreadNotification(payload: NotifyPayload, deps: ThreadNotificationDeps): void {
  const log = process.env[ENV.qaNotifyLog];
  if (typeof log === "string" && log !== "") {
    mkdirSync(path.dirname(log), { recursive: true });
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8");
  }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: payload.title, body: payload.body });
  notification.on("click", () => {
    const window = deps.getWindow();
    if (window !== null && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    deps.onActivate(payload.threadId);
  });
  notification.show();
}

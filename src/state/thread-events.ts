import type { ThreadNotificationPreference } from "../../shared/ipc";
import type { RequestId, RpcNotification, RpcServerRequest } from "../../shared/protocol";
import { parseNotification, parseServerRequest } from "./wire";

/** The thread outcomes that can surface as a macOS notification or an in-app toast. */
export type ThreadEventKind = "completed" | "failed" | "approval" | "question";

/** One reportable thread outcome; `eventId` identifies its turn or server request for notice deduplication. */
export interface ThreadEvent {
  kind: ThreadEventKind;
  eventId: string;
  threadId: string;
  /** Provider error text of a failed turn; null for every other kind. */
  errorMessage: string | null;
}

/** The turn outcome a notification reports, or null for interrupted turns (a user action, not an outcome). */
export function eventFromNotification(notification: RpcNotification): ThreadEvent | null {
  const parsed = parseNotification(notification);
  if (parsed?.method !== "turn/completed") return null;
  const { threadId, turn } = parsed.params;
  if (turn.status === "completed") return { kind: "completed", eventId: turn.id, threadId, errorMessage: null };
  if (turn.status === "failed") {
    return { kind: "failed", eventId: turn.id, threadId, errorMessage: turn.error?.message ?? null };
  }
  return null;
}

/** The pending approval or question a server request asks for, or null for unsupported requests. */
export function eventFromServerRequest(request: RpcServerRequest): ThreadEvent | null {
  const pending = parseServerRequest(request, 0);
  if (pending === null) return null;
  const event =
    pending.kind === "commandApproval" || pending.kind === "fileChangeApproval"
      ? { kind: "approval" as const, errorMessage: null }
      : { kind: "question" as const, errorMessage: null };
  return { ...event, eventId: String(request.id as RequestId), threadId: pending.threadId };
}

export interface NotificationOptions {
  threadNotifications: ThreadNotificationPreference;
  inAppNotifications: boolean;
  windowFocused: boolean;
  activeThreadId: string | null;
}

export interface NotificationDecision {
  system: boolean;
  toast: boolean;
}

/**
 * Where one thread outcome surfaces. The active thread never notifies: it is already in front of the user.
 * "background" shows a macOS notification only while the window is unfocused; "always" also while it is focused.
 * The in-app toast shows only while the window has focus and the thread is not the active one.
 */
export function decideNotification(event: ThreadEvent, options: NotificationOptions): NotificationDecision {
  if (event.threadId === options.activeThreadId) return { system: false, toast: false };
  const system =
    options.threadNotifications === "always" ||
    (options.threadNotifications === "background" && !options.windowFocused);
  return { system, toast: options.inAppNotifications && options.windowFocused };
}

import { useEffect } from "react";
import type { ThreadEvent } from "../../state/thread-events";
import { decideNotification, eventFromNotification, eventFromServerRequest } from "../../state/thread-events";
import { threadTitle } from "../conversation/format";
import { useActions } from "../app-context";
import { useAppStore } from "../../state/store";
import { useT } from "../../i18n";
import { uiState } from "../ui-state";

/**
 * Reports thread outcomes to the user: a macOS notification through `app:notify` per the threadNotifications
 * preference, and an in-app toast notice for a focused window per inAppNotifications. Clicking the macOS
 * notification opens its thread.
 */
export function ThreadNotifications() {
  const store = useAppStore();
  const actions = useActions();
  const t = useT();

  useEffect(() => {
    const report = (event: ThreadEvent): void => {
      // Read at event time: the preference can change in Settings while this listener stays subscribed.
      const preferences = uiState.get().preferences;
      const state = store.getState();
      const decision = decideNotification(event, {
        threadNotifications: preferences?.threadNotifications ?? "background",
        inAppNotifications: preferences?.inAppNotifications ?? true,
        windowFocused: document.hasFocus(),
        activeThreadId: state.activeThreadId,
      });
      if (!decision.system && !decision.toast) return;
      const thread = state.threads[event.threadId];
      if (thread === undefined) return;
      const title = threadTitle(thread, t("shell.newSession"));
      const body =
        event.kind === "failed" && event.errorMessage !== null
          ? t("notify.failed", { message: event.errorMessage })
          : t(`notify.${event.kind}`);
      if (decision.system) {
        window.omo.notify({ title, body, threadId: event.threadId }).catch((error: unknown) => {
          console.warn("Could not show a thread notification", error);
        });
      }
      if (decision.toast) {
        store.dispatch({
          type: "notice/pushed",
          notice: {
            id: `thread-event:${event.kind}:${event.eventId}`,
            level: event.kind === "failed" ? "error" : "info",
            message: `${title} · ${body}`,
            threadId: event.threadId,
            action: "open-thread",
          },
        });
      }
    };
    const unsubscribers = [
      window.omo.onNotification((notification) => {
        const event = eventFromNotification(notification);
        if (event !== null) report(event);
      }),
      window.omo.onServerRequest((request) => {
        const event = eventFromServerRequest(request);
        if (event !== null) report(event);
      }),
      window.omo.onNotifyClick((threadId) => {
        void actions.openThread(threadId);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, actions, t]);

  return null;
}

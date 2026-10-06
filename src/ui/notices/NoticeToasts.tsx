import { Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { selectToastNotice } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import css from "./NoticeToasts.module.css";

const ERROR_HOLD_MS = 6000;
const INFO_HOLD_MS = 3000;
const ACTION_HOLD_MS = 8000;

/**
 * Shows store notices one at a time, oldest first, as DSH toasts; each notice is dismissed when its toast fades out.
 * Side chat notices render inside the side chat panel instead, and a notice with an `open-thread` action keeps its
 * toast long enough to press Open.
 */
export function NoticeToasts() {
  const notice = useAppSelector(selectToastNotice);
  const actions = useActions();
  const t = useT();
  if (notice === null) return null;
  const text = notice.code === undefined ? notice.message : t(`notice.${notice.code}`);
  const openThread = notice.action === "open-thread" && notice.threadId !== null ? notice.threadId : null;
  const holdMs = openThread !== null ? ACTION_HOLD_MS : notice.level === "error" ? ERROR_HOLD_MS : INFO_HOLD_MS;
  return (
    <>
      <Toast
        key={notice.id}
        text={text}
        holdMs={holdMs}
        actions={
          openThread === null
            ? undefined
            : [
                {
                  label: t("notice.action.open"),
                  onClick: () => {
                    void actions.openThread(openThread);
                    actions.dismissNotice(notice.id);
                  },
                },
              ]
        }
        onDone={() => actions.dismissNotice(notice.id)}
      />
      <span className={css.liveRegion} role="status" aria-live="polite" data-testid={TESTID.noticeToast} data-level={notice.level}>
        {text}
      </span>
    </>
  );
}

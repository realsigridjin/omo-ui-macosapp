import { memo, useEffect, useState } from "react";
import {
  IconAgentPresetOutlineRegular,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  IconDislikeFillRegular,
  IconDislikeOutlineRegular,
  IconLikeFillRegular,
  IconLikeOutlineRegular,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { LiveTask } from "../../../shared/protocol";
import { useLocale, useT, type MessageKey } from "../../i18n";
import { formatClockHourMinute } from "../time-format";
import { useUiState } from "../ui-state";
import { TESTID } from "../testids";
import { knownTaskStatus, taskDot, taskElapsedMs, taskTitle, type TaskStatus } from "./activity-model";
import { formatDuration } from "./format";
import css from "./WorkLog.module.css";

const TASK_LABELS: Record<TaskStatus, MessageKey> = {
  pending: "activity.task.pending",
  running: "activity.task.running",
  completed: "activity.task.completed",
  error: "activity.task.error",
  cancelled: "activity.task.cancelled",
  interrupted: "activity.task.interrupted",
  lost: "activity.task.lost",
};

const COPIED_FEEDBACK_MS = 1500;

function useTickingNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The child task roster of one turn's Work Log; the right-aligned control expands the per-task rows. */
export const SubagentRow = memo(function SubagentRow({ tasks }: { tasks: readonly LiveTask[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const working = tasks.filter((task) => task.status === "running").length;
  const now = useTickingNow(working > 0);
  return (
    <div className={css.subagentRow} data-testid={TESTID.subagentRow}>
      <div className={css.subagentKicker}>
        <IconAgentPresetOutlineRegular size={14} className={css.subagentIcon} />
        <span>{t(tasks.length === 1 ? "conversation.workLog.kickedOffOne" : "conversation.workLog.kickedOffMany", { count: tasks.length })}</span>
        <button
          type="button"
          className={css.subagentToggle}
          data-testid={TESTID.subagentToggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {working > 0 && <span className={css.subagentWorking}>{t("conversation.workLog.workingCount", { count: working })}</span>}
          <IconChevronDownOutlineRegular size={12} className={css.subagentChevron} data-open={open || undefined} />
        </button>
      </div>
      {open && (
        <ul className={css.subagentList}>
          {tasks.map((task) => {
            const status = knownTaskStatus(task.status);
            const elapsed = taskElapsedMs(task, now);
            return (
              <li key={task.task_id} className={css.subagentTask} data-testid={TESTID.subagentTask} data-status={task.status}>
                <StateDot state={taskDot(task.status, true)} size={8} />
                <span className={css.subagentName}>{taskTitle(task)}</span>
                <span className={css.subagentStatus}>{status === null ? task.status : t(TASK_LABELS[status])}</span>
                <span className={css.subagentElapsed}>{elapsed !== null && Number.isFinite(elapsed) ? formatDuration(elapsed, t) : "—"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

/** Copy, ratings and the answer's clock time under a finished answer; ratings stay in this window only. */
export const AnswerFooter = memo(function AnswerFooter({ text, atMs }: { text: string; atMs: number }) {
  const t = useT();
  const locale = useLocale();
  const timeFormat = useUiState().preferences?.timeFormat ?? "system";
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (): void => {
    if (copied) return;
    window.omo.copyText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div className={css.answerFooter} data-testid={TESTID.answerFooter}>
      <button type="button" className={css.footerButton} data-testid={TESTID.answerCopy} onClick={copy}
        aria-label={t(copied ? "conversation.code.copied" : "conversation.code.copy")}>
        {copied ? <IconCheckOutlineRegular size={13} /> : <IconCopyOutlineRegular size={13} />}
      </button>
      <button type="button" className={css.footerButton} data-testid={TESTID.answerThumbUp} onClick={() => setRating(rating === "up" ? null : "up")}
        aria-pressed={rating === "up"} aria-label={t("conversation.workLog.thumbsUp")}>
        {rating === "up" ? <IconLikeFillRegular size={13} /> : <IconLikeOutlineRegular size={13} />}
      </button>
      <button type="button" className={css.footerButton} data-testid={TESTID.answerThumbDown} onClick={() => setRating(rating === "down" ? null : "down")}
        aria-pressed={rating === "down"} aria-label={t("conversation.workLog.thumbsDown")}>
        {rating === "down" ? <IconDislikeFillRegular size={13} /> : <IconDislikeOutlineRegular size={13} />}
      </button>
      <span className={css.answerTime}>{formatClockHourMinute(atMs, timeFormat, locale)}</span>
    </div>
  );
});

import { memo, useState } from "react";
import type { MemoryWriteNotice, SessionNotice } from "../../../shared/ipc";
import { useLocale, useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { TESTID } from "../testids";
import css from "./SessionNotices.module.css";

const KIB = 1024;
const SUMMARY_LIMIT = 160;

/** Labels for the custom message types omo writes; any other type shows its raw name. */
const NOTICE_LABELS: Record<string, MessageKey> = {
  "omo-ulw-loop:skill-pointer": "conversation.notice.skillPointer",
  "omo-mass-ulw:skill-pointer": "conversation.notice.skillPointer",
  "omo-ulw-plan:skill-pointer": "conversation.notice.skillPointer",
  "omo-memory:notice": "conversation.notice.memory",
  "omo-kibitzer:recall": "conversation.notice.recall",
  "senpi-monitor:notification": "conversation.notice.monitor",
  "senpi-terminal:notification": "conversation.notice.terminal",
  "senpi-terminal:restore-digest": "conversation.notice.restore",
  "senpi-codemode:notification": "conversation.notice.eval",
  "omo-senpi:wake": "conversation.notice.task",
  "senpi-task.usage": "conversation.notice.taskUsage",
  "goal-continuation": "conversation.notice.goal",
  "omo-ultrawork:directive": "conversation.notice.ultrawork",
  "omo-model-profile:applied": "conversation.notice.profile",
  "environment-context": "conversation.notice.environment",
  "compaction.post-compact-restoration": "conversation.notice.restored",
  "senpi.todo-first-turn": "conversation.notice.todo",
};

function kib(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / KIB))}K`;
}

function relative(iso: string | null, locale: string, now: number): string | null {
  if (iso === null) return null;
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(seconds);
  if (abs < 3_600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3_600), "hour");
  return format.format(Math.round(seconds / 86_400), "day");
}

function ordinal(value: number, locale: string): string {
  if (!locale.startsWith("en")) return String(value);
  const rule = new Intl.PluralRules("en", { type: "ordinal" }).select(value);
  const suffix = rule === "one" ? "st" : rule === "two" ? "nd" : rule === "few" ? "rd" : "th";
  return `${value}${suffix}`;
}

/** The card omo's terminal shows after a memory write: what changed, how big memory is, and how recent it is. */
export const MemoryWriteCard = memo(function MemoryWriteCard({ write }: { write: MemoryWriteNotice }) {
  const t = useT();
  const locale = useLocale();
  const now = Date.now();
  const lines = write.affected.reduce((sum, file) => sum + file.insertions, 0);
  const paths = write.affected.map((file) => file.path).join(", ");
  const previous = relative(write.previousEntryAt, locale, now);
  const consolidated = relative(write.lastConsolidationAt, locale, now);
  return (
    <div className={css.memory} data-testid={TESTID.memoryWrite} data-flow="notice">
      <div className={css.memoryTitle}>
        <span className={css.dot} aria-hidden />
        <span>{t("conversation.memory.remembered")}</span>
        {write.entriesToday !== null && (
          <span>· {t("conversation.memory.entriesToday", { nth: ordinal(write.entriesToday, locale), count: write.entriesToday })}</span>
        )}
      </div>
      {paths !== "" && (
        <div className={css.memoryLine}>{t("conversation.memory.added", { lines, path: paths })}</div>
      )}
      {write.subject !== "" && <div className={css.memoryLine} title={write.sha}>{write.subject}</div>}
      {write.size !== null && (
        <div className={css.memoryLine}>
          {t("conversation.memory.size", {
            system: kib(write.size.systemBytes),
            total: kib(write.size.totalBytes),
            files: write.size.fileCount,
          })}
        </div>
      )}
      {(previous !== null || consolidated !== null) && (
        <div className={css.memoryTimeline}>
          {[
            previous === null ? null : t("conversation.memory.lastEntry", { time: previous }),
            consolidated === null ? null : t("conversation.memory.lastConsolidation", { time: consolidated }),
          ].filter((part) => part !== null).join(" · ")}
        </div>
      )}
    </div>
  );
});

/** The message without one enclosing wrapper tag such as <system-reminder>…</system-reminder>. */
export function noticeBody(text: string): string {
  const trimmed = text.trim();
  const wrapped = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/.exec(trimmed);
  return (wrapped?.[2] ?? trimmed).trim();
}

/** One of omo's special messages as a single line that expands to its full text. */
export const NoticeRow = memo(function NoticeRow({ notice }: { notice: SessionNotice }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const key = NOTICE_LABELS[notice.customType];
  const body = noticeBody(notice.text);
  const first = body.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const summary = first.length > SUMMARY_LIMIT ? `${first.slice(0, SUMMARY_LIMIT)}…` : first;
  return (
    <div className={css.notice} data-testid={TESTID.sessionNotice} data-type={notice.customType} data-display={notice.display || undefined} data-flow="notice">
      <button type="button" className={css.noticeHead} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className={css.chevron} data-open={open || undefined} aria-hidden>›</span>
        <span className={css.noticeLabel}>{key === undefined ? notice.customType : t(key)}</span>
        <span className={css.noticeSummary}>{summary}</span>
      </button>
      {open && <pre className={css.noticeBody}>{body}</pre>}
    </div>
  );
});

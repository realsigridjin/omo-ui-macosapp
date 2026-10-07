import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import type { MemoryWriteNotice, SessionNotice } from "../../../shared/ipc";
import {
  IconChevronRightOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconPlanOutlineRegular,
  MarkdownText,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { TurnError, UserMessageItem } from "../../../shared/protocol";
import { useT } from "../../i18n";
import type { ConversationItem, ConversationTurn } from "../../state";
import { TESTID } from "../testids";
import { AssistantMessage } from "./AssistantMessage";
import { MemoryWriteCard, NoticeRow } from "./SessionNotices";
import { EditMessageButton, EditMessageForm, RegenerateButton, userRowClass, type BranchAt } from "./BranchControls";
import type { ActivityTask } from "./activity-model";
import { elapsedMs, formatDuration } from "./format";
import { useConversationLabels } from "./labels";
import { ReasoningRow } from "./ReasoningRow";
import { RenderBoundary } from "./RenderBoundary";
import { ToolCard } from "./ToolCard";
import { AnswerFooter, SubagentRow } from "./WorkLog";
import { lastAgentMessageIndex, tasksInTurn, turnFold } from "./work-log";
import { UserBubble, userMessageParts } from "./UserBubble";
import css from "./TurnView.module.css";
import workCss from "./WorkLog.module.css";

const NO_NOTICES: readonly SessionNotice[] = [];
const NO_WRITES: Readonly<Record<string, MemoryWriteNotice>> = {};
const NO_TASKS: readonly ActivityTask[] = [];

function assertNever(value: never): never {
  throw new Error(`Unhandled conversation item: ${JSON.stringify(value)}`);
}

/** Who may branch from a turn's messages: the thread, and whether no turn of it is running. */
export interface BranchContext {
  threadId: string;
  idle: boolean;
}

/** A BranchContext narrowed to one turn; item ids are only unique within their turn. */
type TurnBranch = BranchContext & BranchAt;

function UserMessageView({ item, branch }: { item: UserMessageItem; branch: TurnBranch | null }) {
  const { text, images } = useMemo(() => userMessageParts(item.content), [item.content]);
  const [editing, setEditing] = useState(false);
  if (text === "" && images.length === 0) return null;
  if (branch === null) return <UserBubble text={text} images={images} />;
  if (editing) return <EditMessageForm at={branch} item={item} onClose={() => setEditing(false)} />;
  return (
    <div className={userRowClass}>
      <UserBubble text={text} images={images} />
      <EditMessageButton disabled={!branch.idle} onEdit={() => setEditing(true)} />
    </div>
  );
}

function PlanBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useT();
  const labels = useConversationLabels();
  return (
    <div className={css.plan} data-flow="plan">
      <div className={css.planHeader}>
        <IconPlanOutlineRegular size={14} />
        <span>{t("conversation.plan")}</span>
      </div>
      <MarkdownText text={text} streaming={streaming} labels={labels.markdown} variant="compact" />
    </div>
  );
}

function CompactionDivider() {
  const t = useT();
  return (
    <div className={css.compaction} data-flow="compaction">
      <IconContextInjectionOutlineRegular size={14} />
      <span>{t("conversation.compacted")}</span>
    </div>
  );
}

function renderItem(entry: ConversationItem, cwd: string | null, branch: TurnBranch | null): ReactNode {
  const { item } = entry;
  switch (item.type) {
    case "userMessage":
      return <UserMessageView item={item} branch={branch} />;
    case "agentMessage":
      return <AssistantMessage id={item.id} text={item.text} streaming={entry.streaming} />;
    case "reasoning":
      return (
        <ReasoningRow
          item={item}
          streaming={entry.streaming}
          durationMs={elapsedMs(entry.startedAtMs, entry.completedAtMs)}
        />
      );
    case "plan":
      return <PlanBlock text={item.text} streaming={entry.streaming} />;
    case "contextCompaction":
      return <CompactionDivider />;
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
      return <ToolCard entry={entry} item={item} cwd={cwd} />;
    default:
      return assertNever(item);
  }
}

const ItemView = memo(function ItemView({ entry, cwd, branch }: { entry: ConversationItem; cwd: string | null; branch: TurnBranch | null }) {
  return (
    <RenderBoundary label={`a ${entry.item.type} item`} resetKey={entry}>
      {renderItem(entry, cwd, branch)}
    </RenderBoundary>
  );
});

function TurnErrorRow({ error, retrying }: { error: TurnError | null; retrying: boolean }) {
  const t = useT();
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const details = typeof error?.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  return (
    <div className={css.errorRow} data-testid={TESTID.turnError} role="status" data-retrying={retrying || undefined} data-flow="error">
      <StateDot state={retrying ? "warning" : "error"} className={css.errorDot} />
      <div className={css.errorCopy}>
        <span className={css.errorTitle}>
          {t(retrying ? "conversation.turn.retrying" : "conversation.turn.error")}
        </span>
        <span className={css.errorMessage}>{message === "" ? t("conversation.turn.errorUnknown") : message}</span>
        {details !== "" && <span className={css.errorDetails}>{details}</span>}
      </div>
    </div>
  );
}

/**
 * One turn in item order; memoized on the turn object, and each item on its ConversationItem, so a delta re-renders
 * only its item. With `branch`, user messages can be edited, and the `last` turn offers to regenerate its answer.
 * A completed turn's intermediate steps collapse into its Work Log fold; a running turn keeps every step expanded.
 */
export const TurnView = memo(function TurnView({
  turn,
  cwd,
  branch = null,
  last = false,
  notices = NO_NOTICES,
  memoryWrites = NO_WRITES,
  tasks = NO_TASKS,
}: {
  turn: ConversationTurn;
  cwd: string | null;
  branch?: BranchContext | null;
  last?: boolean;
  /** omo's special messages recorded in this turn, placed after `afterItems` items. */
  notices?: readonly SessionNotice[];
  memoryWrites?: Readonly<Record<string, MemoryWriteNotice>>;
  /** The thread's task roster; the turn shows the tasks omo spawned while it ran. */
  tasks?: readonly ActivityTask[];
}) {
  const t = useT();
  const failed = turn.error !== null || turn.status === "failed";
  const prompt = turn.items.find((entry) => entry.item.type === "userMessage")?.item;
  const turnBranch = useMemo<TurnBranch | null>(() => (branch === null ? null : { ...branch, turnId: turn.id }), [branch, turn.id]);
  const fold = useMemo(() => turnFold(turn), [turn]);
  const subagents = useMemo(() => tasksInTurn(tasks, turn), [tasks, turn]);
  const lastAgent = useMemo(() => lastAgentMessageIndex(turn.items), [turn.items]);
  const anchor = useMemo(() => turn.items.findIndex((entry) => entry.item.type === "userMessage") + 1, [turn.items]);
  const showWorkLog = anchor > 0 && (fold !== null || subagents.length > 0);
  const showFooter = turn.status !== "inProgress" && lastAgent >= 0;
  const [foldOpen, setFoldOpen] = useState(false);

  const renderEntries = (from: number, to: number): ReactNode =>
    turn.items.slice(from, to).map((entry, offset) => {
      const index = from + offset;
      const { item } = entry;
      const write = item.type === "dynamicToolCall" && item.tool === "memory" ? memoryWrites[item.id] : undefined;
      return (
        <Fragment key={item.id}>
          {notices.filter((notice) => notice.afterItems === index).map((notice) => <NoticeRow key={notice.id} notice={notice} />)}
          <ItemView entry={entry} cwd={cwd} branch={turnBranch} />
          {write !== undefined && <MemoryWriteCard write={write} />}
          {index === lastAgent && showFooter && item.type === "agentMessage" && (
            <AnswerFooter text={item.text} atMs={turn.completedAtMs ?? entry.completedAtMs ?? Date.now()} />
          )}
        </Fragment>
      );
    });

  return (
    <div className={css.turn} data-testid={TESTID.turn} data-turn-id={turn.id} data-status={turn.status}>
      {renderEntries(0, fold?.start ?? anchor)}
      {showWorkLog && (
        <div className={workCss.workLog} data-testid={TESTID.workLog}>
          <span className={workCss.workLogLabel}>{t("conversation.workLog.label")}</span>
          {subagents.length > 0 && <SubagentRow tasks={subagents} />}
          {fold !== null && (
            <div className={workCss.foldRow} data-testid={TESTID.workedFold}>
              <button
                type="button"
                className={workCss.foldToggle}
                data-testid={TESTID.workedFoldToggle}
                aria-expanded={foldOpen}
                onClick={() => setFoldOpen((open) => !open)}
              >
                <span>
                  {fold.durationMs !== null
                    ? t("conversation.workLog.workedFor", { duration: formatDuration(fold.durationMs, t) })
                    : t("conversation.workLog.workedForPlain")}
                </span>
                <IconChevronRightOutlineRegular size={12} className={workCss.foldChevron} />
              </button>
            </div>
          )}
          {fold !== null && foldOpen && <div className={workCss.foldSteps}>{renderEntries(fold.start, fold.end)}</div>}
        </div>
      )}
      {renderEntries(fold?.end ?? anchor, turn.items.length)}
      {notices.filter((notice) => notice.afterItems >= turn.items.length).map((notice) => <NoticeRow key={notice.id} notice={notice} />)}
      {failed && <TurnErrorRow error={turn.error} retrying={turn.status === "inProgress"} />}
      {turn.status === "interrupted" && <span className={css.stopped}>{t("conversation.turn.stopped")}</span>}
      {turnBranch !== null && last && turn.status !== "inProgress" && prompt?.type === "userMessage" && (
        <RegenerateButton at={turnBranch} item={prompt} disabled={!turnBranch.idle} />
      )}
    </div>
  );
});

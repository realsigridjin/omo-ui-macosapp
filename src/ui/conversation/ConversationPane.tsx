import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionNotice } from "../../../shared/ipc";
import clsx from "clsx";
import {
  Button,
  IconChevronDownOutlineRegular,
  IconClockOutlineRegular,
  MarkdownDelegateProvider,
  StateDot,
  TextShimmer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { resolveWorkspacePath } from "@deepseek-ai/dsh-util-workspace-path";
import type { ThreadItem } from "../../../shared/protocol";
import { useT } from "../../i18n";
import type { Conversation, ConversationTurn, PendingRequest } from "../../state";
import { selectActiveConversation, selectIsTurnActive, selectPendingRequestsForThread, selectTasks } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { SideToggle } from "../btw/SideToggle";
import { TESTID } from "../testids";
import { ActivityPanel, ActivityToggle } from "./ActivityPanel";
import { ApprovalCard } from "./ApprovalCard";
import { ConversationHeader } from "./ConversationHeader";
import { EmptyHero } from "./EmptyHero";
import { QuestionCard } from "./QuestionCard";
import { RenderBoundary } from "./RenderBoundary";
import { TurnView, type BranchContext } from "./TurnView";
import { userMessageParts, UserBubble } from "./UserBubble";
import { useStickToBottom } from "./use-stick-to-bottom";
import { durationParts, QUIET_AFTER_MS, workingStatus } from "./working-status";
import { waitingPhase, type WaitingPhase } from "./work-log";
import css from "./ConversationPane.module.css";

const NO_TURNS: readonly ConversationTurn[] = [];

function requestKey(request: PendingRequest): string {
  return `${request.kind}:${String(request.id)}`;
}

function relatedItem(conversation: Conversation | null, turnId: string, itemId: string): ThreadItem | null {
  const turn = conversation?.turns.find((candidate) => candidate.id === turnId);
  return turn?.items.find((entry) => entry.item.id === itemId)?.item ?? null;
}

function HistorySkeleton() {
  const t = useT();
  return (
    <div className={css.skeleton} role="status" aria-label={t("conversation.history.loading")}>
      <span className={clsx(css.skeletonBlock, css.skeletonBubble)} />
      <span className={clsx(css.skeletonBlock, css.skeletonLine)} />
      <span className={clsx(css.skeletonBlock, css.skeletonLine)} />
      <span className={clsx(css.skeletonBlock, css.skeletonLine)} />
    </div>
  );
}

function HistoryError({ threadId, message }: { threadId: string; message: string | null }) {
  const t = useT();
  const actions = useActions();
  return (
    <div className={css.historyError} data-testid={TESTID.historyError} role="alert">
      <StateDot state="error" className={css.historyErrorDot} />
      <div className={css.historyErrorCopy}>
        <span className={css.historyErrorTitle}>{t("conversation.history.error")}</span>
        {message !== null && message !== "" && <span className={css.historyErrorMessage}>{message}</span>}
      </div>
      <Button variant="outline" size="sm" onClick={() => void actions.openThread(threadId)}>
        {t("conversation.history.retry")}
      </Button>
    </div>
  );
}

/**
 * The status line under the newest bubble: a muted waiting line while omo has not produced work yet (with a
 * ticking seconds counter), otherwise the working line with elapsed and idle detail.
 */
function WorkingIndicator({
  turn,
  phase,
  sinceMs,
}: {
  turn: ConversationTurn | null;
  phase: WaitingPhase | null;
  sinceMs: number | null;
}) {
  const t = useT();
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const status = turn === null ? null : workingStatus(turn, nowMs);
  const format = (ms: number): string => {
    const { minutes, seconds } = durationParts(ms);
    return minutes > 0 ? t("conversation.duration.minutes", { minutes, seconds }) : t("conversation.duration.seconds", { seconds });
  };
  return (
    <div className={css.working} data-testid={TESTID.workingIndicator} data-queued={status?.queuedMessage || undefined} role="status">
      {phase === null ? (
        <>
          <StateDot state="ongoing" size={12} />
          <TextShimmer active>{t("conversation.working")}</TextShimmer>
          {status !== null && (
            <span className={css.workingDetail} data-testid={TESTID.workingDetail}>
              {format(status.elapsedMs)}
              {status.idleMs >= QUIET_AFTER_MS && ` · ${t("conversation.working.lastActivity", { time: format(status.idleMs) })}`}
              {status.queuedMessage && ` · ${t("conversation.working.queued")}`}
            </span>
          )}
        </>
      ) : (
        <span className={css.waiting} data-testid={TESTID.waitingStatus}>
          <IconClockOutlineRegular size={13} className={css.waitingIcon} />
          <span className={css.waitingLabel}>
            {t(phase === "startingSession" ? "conversation.workLog.waitingStart" : "conversation.workLog.waitingModel")}
          </span>
          <span className={css.workingDetail} data-testid={TESTID.workingDetail}>
            {format(Math.max(0, nowMs - (sinceMs ?? nowMs)))}
            {status?.queuedMessage && ` · ${t("conversation.working.queued")}`}
          </span>
        </span>
      )}
    </div>
  );
}

function PendingRequestCard({
  request,
  conversation,
  cwd,
}: {
  request: PendingRequest;
  conversation: Conversation | null;
  cwd: string | null;
}) {
  if (request.kind === "userInput") return <QuestionCard request={request} />;
  return (
    <ApprovalCard
      request={request}
      related={relatedItem(conversation, request.params.turnId, request.params.itemId)}
      cwd={cwd}
    />
  );
}

function Transcript({ threadId, cwd, turnActive }: { threadId: string; cwd: string | null; turnActive: boolean }) {
  const t = useT();
  const hasPath = useAppSelector((state) => (state.threads[threadId]?.path ?? null) !== null);
  const conversation = useAppSelector(selectActiveConversation);
  const pending = useAppSelector((state) => selectPendingRequestsForThread(state, threadId));
  const scroll = useStickToBottom();
  const turns = conversation?.turns ?? NO_TURNS;
  const annotations = conversation?.annotations;
  const noticesByTurn = useMemo(() => {
    const byTurn = new Map<number, SessionNotice[]>();
    for (const notice of annotations?.notices ?? []) byTurn.set(notice.turnIndex, [...(byTurn.get(notice.turnIndex) ?? []), notice]);
    return byTurn;
  }, [annotations?.notices]);
  const activeTurnId = conversation?.activeTurnId ?? null;
  const activeTurn = useMemo(
    () => (activeTurnId === null ? null : (turns.find((turn) => turn.id === activeTurnId) ?? null)),
    [turns, activeTurnId],
  );
  const tasks = useAppSelector((state) => selectTasks(state, threadId));
  const streaming = activeTurn?.items.some((entry) => entry.streaming) ?? false;
  const pendingUserMessages = conversation?.pendingUserMessages ?? [];
  const waiting = waitingPhase(turnActive ? activeTurn : null, !turnActive && pendingUserMessages.length > 0);
  const waitingSinceMs = waiting === null ? null : activeTurn?.startedAtMs ?? pendingUserMessages.at(-1)?.sentAtMs ?? null;
  const showWorking = turnActive && !streaming && pending.length === 0;
  const showStatusLine = pending.length === 0 && (showWorking || waiting !== null);
  const historyState = conversation?.historyState ?? "idle";
  const branchIdle = !turnActive && pendingUserMessages.length === 0;
  const branch = useMemo<BranchContext | null>(() => (hasPath ? { threadId, idle: branchIdle } : null), [hasPath, threadId, branchIdle]);
  const empty =
    (historyState === "idle" || historyState === "loaded") &&
    turns.length === 0 &&
    pending.length === 0 &&
    !turnActive &&
    pendingUserMessages.length === 0;
  const openExternalLink = useCallback((href: string) => void window.omo.openExternal(href), []);
  const openFile = useCallback(
    (path: string) => void window.omo.revealPath(resolveWorkspacePath(cwd ?? undefined, path)),
    [cwd],
  );
  const { jumpToLatest } = scroll;
  const seenRequests = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const keys = new Set(pending.map(requestKey));
    const arrived = [...keys].some((key) => !seenRequests.current.has(key));
    seenRequests.current = keys;
    if (arrived) jumpToLatest();
  }, [pending, jumpToLatest]);

  return (
    <div className={css.body}>
      {empty && <EmptyHero />}
      <div ref={scroll.scrollRef} className={clsx(css.scroll, empty && css.scrollHidden)} role="region" aria-label={t("conversation.region")}>
        <div ref={scroll.contentRef} className={css.column}>
          {historyState === "loading" && <HistorySkeleton />}
          {historyState === "error" && <HistoryError threadId={threadId} message={conversation?.historyError ?? null} />}
          <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={openFile}>
            {turns.map((turn, index) => (
              <TurnView key={turn.id} turn={turn} cwd={cwd} branch={branch} last={index === turns.length - 1}
                notices={noticesByTurn.get(index)} memoryWrites={annotations?.memoryWrites} tasks={tasks} />
            ))}
          </MarkdownDelegateProvider>
          {pendingUserMessages.map((message) => (
            <UserBubble key={message.clientId} text={message.text} images={userMessageParts(message.images ?? []).images} sending />
          ))}
          {showStatusLine && <WorkingIndicator turn={activeTurn} phase={waiting} sinceMs={waitingSinceMs} />}
          {pending.map((request) => (
            <RenderBoundary key={requestKey(request)} label={`a ${request.kind} request`} resetKey={request}>
              <PendingRequestCard request={request} conversation={conversation} cwd={cwd} />
            </RenderBoundary>
          ))}
        </div>
      </div>
      {scroll.showJump && (
        <button type="button" className={css.jump} onClick={scroll.jumpToLatest}>
          <IconChevronDownOutlineRegular size={14} />
          <span>{t("conversation.jumpToLatest")}</span>
        </button>
      )}
    </div>
  );
}

/** The main conversation column: header strip, then the empty hero or the active thread's transcript. */
export function ConversationPane() {
  const threadId = useAppSelector((state) => state.activeThreadId);
  const thread = useAppSelector((state) =>
    state.activeThreadId === null ? null : (state.threads[state.activeThreadId] ?? null),
  );
  const turnActive = useAppSelector(selectIsTurnActive);
  const activityId = useId();
  const [activityOpen, setActivityOpen] = useState<ReadonlySet<string>>(() => new Set());
  const showActivity = threadId !== null && activityOpen.has(threadId);
  const toggleActivity = useCallback(() => {
    if (threadId === null) return;
    setActivityOpen((current) => {
      const next = new Set(current);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  }, [threadId]);
  const activity = useMemo(
    () =>
      threadId === null ? null : (
        <ActivityToggle threadId={threadId} open={showActivity} controlsId={activityId} onToggle={toggleActivity} />
      ),
    [threadId, showActivity, activityId, toggleActivity],
  );
  const panels = useMemo(() => (threadId === null ? null : <SideToggle />), [threadId]);
  return (
    <section className={css.root} data-testid={TESTID.conversation}>
      <ConversationHeader active={threadId !== null} thread={thread} running={turnActive} activity={activity} panels={panels} />
      {threadId !== null && showActivity && <ActivityPanel threadId={threadId} id={activityId} />}
      {threadId === null ? (
        <EmptyHero />
      ) : (
        <Transcript key={threadId} threadId={threadId} cwd={thread?.cwd ?? null} turnActive={turnActive} />
      )}
    </section>
  );
}

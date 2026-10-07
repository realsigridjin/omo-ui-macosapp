import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  MarkdownDelegateProvider,
  MarkdownText,
  Menu,
  StateDot,
  TextShimmer,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import { resolveWorkspacePath } from "@deepseek-ai/dsh-util-workspace-path";
import type { ThreadItem, UserMessageItem } from "../../../shared/protocol";
import { useT } from "../../i18n";
import { selectPanelNotices, selectPendingRequestsForThread, selectSidesOf, sideDraftKey } from "../../state";
import type { Conversation, ConversationItem, ConversationTurn, SideChat } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { ApprovalCard } from "../conversation/ApprovalCard";
import { AssistantMessage } from "../conversation/AssistantMessage";
import { elapsedMs, threadTitle, workspaceName } from "../conversation/format";
import { useConversationLabels } from "../conversation/labels";
import { QuestionCard } from "../conversation/QuestionCard";
import { ReasoningRow } from "../conversation/ReasoningRow";
import { RenderBoundary } from "../conversation/RenderBoundary";
import { ToolCard } from "../conversation/ToolCard";
import { useStickToBottom } from "../conversation/use-stick-to-bottom";
import { TESTID } from "../testids";
import { sideDisplayText } from "./background";
import { BubbleIcon, CloseIcon, PlusIcon, SendIcon, SparkIcon, StopIcon } from "./icons";
import { useAskSide } from "./use-ask-side";
import css from "./SidePanel.module.css";

/** Requested width of the docked panel; AppFrame clamps it and overlays the panel when the window is too narrow. */
export const SIDE_PANEL_WIDTH = 380;

const NEW_SIDE_ID = "new-side";
const NO_TURNS: readonly ConversationTurn[] = [];
const QUICK_ASKS = ["btw.chip.summarize", "btw.chip.changed", "btw.chip.error"] as const;
const INPUT_MAX_HEIGHT = 120;

function assertNever(value: never): never {
  throw new Error(`Unhandled side chat item: ${JSON.stringify(value)}`);
}

function userText(item: UserMessageItem): string {
  return item.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function relatedItem(conversation: Conversation | null, turnId: string, itemId: string): ThreadItem | null {
  const turn = conversation?.turns.find((candidate) => candidate.id === turnId);
  return turn?.items.find((entry) => entry.item.id === itemId)?.item ?? null;
}

const keepFocus = (event: MouseEvent<HTMLButtonElement>): void => {
  event.preventDefault();
};

function QuestionBubble({ text, sending = false }: { text: string; sending?: boolean }) {
  return (
    <div className={css.question} data-testid={TESTID.sideQuestion} data-sending={sending || undefined}>
      {text}
    </div>
  );
}

function SideErrorRow({ title, message, onDismiss }: { title: string; message: string; onDismiss?: () => void }) {
  const t = useT();
  return (
    <div className={css.error} data-testid={TESTID.sideError} role="alert">
      <StateDot state="error" className={css.errorDot} />
      <div className={css.errorCopy}>
        <span className={css.errorTitle}>{title}</span>
        <span className={css.errorMessage}>{message}</span>
      </div>
      {onDismiss !== undefined && (
        <button type="button" className={css.errorDismiss} aria-label={t("btw.dismiss")} onClick={onDismiss}>
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  );
}

function SideItem({ side, entry, cwd }: { side: SideChat; entry: ConversationItem; cwd: string | null }) {
  const labels = useConversationLabels();
  const { item } = entry;
  switch (item.type) {
    case "userMessage": {
      const text = sideDisplayText(side, userText(item)).trim();
      return text === "" ? null : <QuestionBubble text={text} />;
    }
    case "agentMessage":
      return <AssistantMessage id={item.id} text={item.text} streaming={entry.streaming} />;
    case "reasoning":
      return <ReasoningRow item={item} streaming={entry.streaming} durationMs={elapsedMs(entry.startedAtMs, entry.completedAtMs)} />;
    case "plan":
      return <MarkdownText text={item.text} streaming={entry.streaming} labels={labels.markdown} variant="compact" />;
    case "contextCompaction":
      return null;
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

const SideTurn = memo(function SideTurn({ side, turn, cwd }: { side: SideChat; turn: ConversationTurn; cwd: string | null }) {
  const t = useT();
  const failed = turn.error !== null || turn.status === "failed";
  const message = typeof turn.error?.message === "string" ? turn.error.message.trim() : "";
  return (
    <div className={css.turn} data-testid={TESTID.sideTurn} data-turn-id={turn.id} data-status={turn.status}>
      {turn.items.map((entry) => (
        <RenderBoundary key={entry.item.id} label={`a ${entry.item.type} item`} resetKey={entry}>
          <SideItem side={side} entry={entry} cwd={cwd} />
        </RenderBoundary>
      ))}
      {failed && (
        <SideErrorRow
          title={t(turn.status === "inProgress" ? "conversation.turn.retrying" : "btw.error.title")}
          message={message === "" ? t("conversation.turn.errorUnknown") : message}
        />
      )}
      {turn.status === "interrupted" && <span className={css.stopped}>{t("conversation.turn.stopped")}</span>}
    </div>
  );
});

function SideTranscript({ side, cwd }: { side: SideChat; cwd: string | null }) {
  const t = useT();
  const conversation = useAppSelector((state) => state.conversations[side.id] ?? null);
  const pending = useAppSelector((state) => selectPendingRequestsForThread(state, side.id));
  const scroll = useStickToBottom();
  const turns = conversation?.turns ?? NO_TURNS;
  const activeTurnId = conversation?.activeTurnId ?? null;
  const activeTurn = activeTurnId === null ? null : (turns.find((turn) => turn.id === activeTurnId) ?? null);
  const streaming = activeTurn?.items.some((entry) => entry.streaming) ?? false;
  const working = activeTurn !== null && !streaming && pending.length === 0;
  const openExternalLink = useCallback((href: string) => void window.omo.openExternal(href), []);
  const openFile = useCallback(
    (path: string) => void window.omo.revealPath(resolveWorkspacePath(cwd ?? undefined, path)),
    [cwd],
  );
  return (
    <div ref={scroll.scrollRef} className={clsx(css.scroll, "scrollable")} role="region" aria-label={t("btw.transcript")}>
      <div ref={scroll.contentRef} className={css.transcript} data-testid={TESTID.sideTranscript} data-side-id={side.id}>
        {conversation?.historyState === "loading" && (
          <div className={css.status} role="status">
            <TextShimmer active>{t("btw.loading")}</TextShimmer>
          </div>
        )}
        <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={openFile}>
          {turns.map((turn) => (
            <SideTurn key={turn.id} side={side} turn={turn} cwd={cwd} />
          ))}
        </MarkdownDelegateProvider>
        {conversation?.pendingUserMessages.map((message) => (
          <QuestionBubble key={message.clientId} text={sideDisplayText(side, message.text)} sending />
        ))}
        {working && (
          <div className={css.status} role="status">
            <StateDot state="ongoing" size={10} />
            <TextShimmer active>{t("btw.working")}</TextShimmer>
          </div>
        )}
        {pending.map((request) => (
          <RenderBoundary key={`${request.kind}:${String(request.id)}`} label={`a ${request.kind} request`} resetKey={request}>
            {request.kind === "userInput" ? (
              <QuestionCard request={request} />
            ) : (
              <ApprovalCard request={request} related={relatedItem(conversation, request.params.turnId, request.params.itemId)} cwd={cwd} />
            )}
          </RenderBoundary>
        ))}
      </div>
    </div>
  );
}

function NewSideIntro({ disabled, onAsk }: { disabled: boolean; onAsk: (question: string) => void }) {
  const t = useT();
  return (
    <div className={css.intro} data-testid={TESTID.sideIntro}>
      <span className={css.introMark} aria-hidden>
        <SparkIcon size={18} />
      </span>
      <p className={css.introText}>{t("btw.intro")}</p>
      <div className={css.chips}>
        {QUICK_ASKS.map((key) => (
          <button key={key} type="button" className={css.chip} data-testid={TESTID.sideChip} disabled={disabled} onClick={() => onAsk(t(key))}>
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ContextChip({ attached, title, workspace, onChange }: { attached: boolean; title: string; workspace: string; onChange: (attached: boolean) => void }) {
  const t = useT();
  if (!attached) {
    return (
      <button type="button" className={clsx(css.context, css.contextOff)} data-testid={TESTID.sideContext} data-attached="false" onClick={() => onChange(true)}>
        <PlusIcon size={12} />
        <span>{t("btw.context.attach")}</span>
      </button>
    );
  }
  return (
    <span className={css.context} data-testid={TESTID.sideContext} data-attached="true" title={t("btw.context.hint")}>
      <BubbleIcon size={13} />
      <span className={css.contextTitle}>{title}</span>
      <span className={css.contextHost}>{workspace}</span>
      <button type="button" className={css.contextRemove} aria-label={t("btw.context.remove")} onClick={() => onChange(false)}>
        <CloseIcon size={10} />
      </button>
    </span>
  );
}

function SidePicker({ sides, selected, onSelect }: { sides: readonly SideChat[]; selected: SideChat | null; onSelect: (sideId: string | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const position = selected === null ? -1 : sides.indexOf(selected);
  const items: MenuEntry[] = [
    ...(sides.length === 0 ? [] : [{ type: "label" as const, id: "label", text: t("btw.picker.label") }]),
    ...sides.map((side, index) => ({
      id: side.id,
      label: (
        <span className={css.pickerRow}>
          <span className={css.pickerIndex}>{t("btw.side.label", { n: index + 1 })}</span>
          <span className={css.pickerQuestion}>{side.question}</span>
        </span>
      ),
    })),
    ...(sides.length === 0 ? [] : [{ type: "separator" as const, id: "separator" }]),
    { id: NEW_SIDE_ID, label: t("btw.picker.new"), icon: <PlusIcon size={12} /> },
  ];
  return (
    <Menu
      open={open}
      portal
      align="start"
      className={css.pickerMenu}
      items={items}
      selectedId={selected?.id ?? NEW_SIDE_ID}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        setOpen(false);
        onSelect(id === NEW_SIDE_ID ? null : id);
      }}
      anchor={
        <button
          type="button"
          className={css.picker}
          data-testid={TESTID.sidePicker}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={css.pickerLabel}>{position < 0 ? t("btw.picker.new") : t("btw.side.label", { n: position + 1 })}</span>
          {selected !== null && <span className={css.pickerSummary}>{selected.question}</span>}
          <IconChevronDownOutlineRegular size={12} />
        </button>
      }
    />
  );
}

interface SideComposerProps {
  parentId: string | null;
  side: SideChat | null;
  connected: boolean;
  running: boolean;
  contextChip: ReactNode;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onEscape: () => void;
}

function SideComposer({ parentId, side, connected, running, contextChip, onSubmit, onStop, onEscape }: SideComposerProps) {
  const t = useT();
  const actions = useActions();
  const draftKey = parentId === null ? null : sideDraftKey(parentId, side?.id ?? null);
  const draft = useAppSelector((state) => (draftKey === null ? "" : (state.btw.drafts[draftKey] ?? "")));
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const disabled = !connected || parentId === null;
  const blank = draft.trim() === "";

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus({ preventScroll: true });
  }, [disabled, draftKey]);

  const submit = (): void => {
    if (disabled || blank || draftKey === null) return;
    actions.setSideDraft(draftKey, "");
    onSubmit(draft.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape" && draft === "") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  const placeholder =
    parentId === null
      ? t("btw.placeholder.noThread")
      : running
        ? t("btw.placeholder.running")
        : side === null
          ? t("btw.placeholder.new")
          : t("btw.placeholder.followUp");

  return (
    <div className={css.composer} data-testid={TESTID.sideComposer}>
      {contextChip}
      <div className={clsx(css.field, disabled && css.fieldDisabled)}>
        <textarea
          ref={inputRef}
          className={css.input}
          data-testid={TESTID.sideInput}
          aria-label={t("btw.inputLabel")}
          placeholder={placeholder}
          rows={1}
          value={draft}
          disabled={disabled}
          onChange={(event) => {
            if (draftKey !== null) actions.setSideDraft(draftKey, event.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={onKeyDown}
        />
        {running && (
          <Tooltip label={t("btw.stop")} side="top" delayMs={500}>
            <button type="button" className={clsx(css.send, css.stop)} data-testid={TESTID.sideStop} aria-label={t("btw.stop")} onMouseDown={keepFocus} onClick={onStop}>
              <StopIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("btw.send")} side="top" delayMs={500} disabled={disabled || blank}>
          <button
            type="button"
            className={css.send}
            data-testid={TESTID.sideSend}
            aria-label={t("btw.send")}
            disabled={disabled || blank}
            onMouseDown={keepFocus}
            onClick={submit}
          >
            <SendIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/**
 * The /btw side chat panel, laid out after the Aside browser's Ask Aside panel: an inset card beside the conversation
 * with a side picker, the attached-context chip, the side transcript and its own composer. It shows the active main
 * thread's side chats only; without an explicit selection the newest side chat is shown.
 */
export function SidePanel({ placement }: { placement: "docked" | "overlay" }) {
  const t = useT();
  const actions = useActions();
  const askSide = useAskSide();
  const parentId = useAppSelector((state) => state.activeThreadId);
  const parent = useAppSelector((state) => (state.activeThreadId === null ? null : (state.threads[state.activeThreadId] ?? null)));
  const connected = useAppSelector((state) => state.bridge?.state === "connected");
  const sides = useAppSelector((state) => selectSidesOf(state, state.activeThreadId));
  const recorded = useAppSelector((state) => (state.activeThreadId === null ? null : state.btw.selected[state.activeThreadId]));
  const attached = useAppSelector((state) => state.activeThreadId === null || state.btw.detached[state.activeThreadId] !== true);
  const selected = recorded === undefined ? (sides.at(-1) ?? null) : (sides.find((side) => side.id === recorded) ?? null);
  const selectedId = selected?.id ?? null;
  const running = useAppSelector((state) => selectedId !== null && (state.conversations[selectedId]?.activeTurnId ?? null) !== null);
  const notices = useAppSelector((state) => selectPanelNotices(state, state.activeThreadId, selectedId));
  const fallbackTitle = t("conversation.header.newSession");
  const close = useCallback(() => actions.setSidePanel(false), [actions]);

  useEffect(() => {
    if (parentId !== null && selectedId !== null) void actions.selectSide(parentId, selectedId);
  }, [actions, parentId, selectedId]);

  const ask = (question: string): void => {
    if (selected === null) void askSide(question);
    else void actions.sendToSide(selected.id, question);
  };

  return (
    <aside className={css.panel} data-testid={TESTID.sidePanel} data-placement={placement} aria-label={t("btw.title")}>
      <header className={css.header} data-window-drag>
        <span className={css.badge}>
          <SparkIcon size={12} />
          {t("btw.badge")}
        </span>
        {parentId !== null && (
          <SidePicker sides={sides} selected={selected} onSelect={(sideId) => void actions.selectSide(parentId, sideId)} />
        )}
        <span className={css.headerSpacer} />
        <kbd className={css.kbd} aria-hidden>
          {window.omo.platform === "darwin" ? "⌘E" : "Ctrl+E"}
        </kbd>
        <Tooltip label={t("btw.close")} side="bottom" delayMs={500}>
          <button type="button" className={css.iconButton} data-testid={TESTID.sideClose} aria-label={t("btw.close")} onClick={close}>
            <CloseIcon />
          </button>
        </Tooltip>
      </header>
      {parent === null ? (
        <div className={css.intro} data-testid={TESTID.sideIntro}>
          <p className={css.introText}>{t("btw.noThread")}</p>
        </div>
      ) : selected === null ? (
        <NewSideIntro disabled={!connected} onAsk={(question) => void askSide(question)} />
      ) : (
        <SideTranscript key={selected.id} side={selected} cwd={parent.cwd} />
      )}
      {notices.length > 0 && (
        <div className={css.notices}>
          {notices.map((notice) => (
            <SideErrorRow key={notice.id} title={t("btw.error.title")} message={notice.message} onDismiss={() => actions.dismissNotice(notice.id)} />
          ))}
        </div>
      )}
      <SideComposer
        parentId={parent === null ? null : parent.id}
        side={selected}
        connected={connected}
        running={running}
        contextChip={
          parent !== null && selected === null ? (
            <ContextChip
              attached={attached}
              title={threadTitle(parent, fallbackTitle)}
              workspace={workspaceName(parent.cwd)}
              onChange={(value) => actions.setSideContext(parent.id, value)}
            />
          ) : null
        }
        onSubmit={ask}
        onStop={() => {
          if (selected !== null) void actions.interruptSide(selected.id);
        }}
        onEscape={close}
      />
    </aside>
  );
}

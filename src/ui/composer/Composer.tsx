import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, SyntheticEvent } from "react";
import clsx from "clsx";
import { IconFolderOpenOutlineRegular, IconPaperclipOutlineRegular, IconCloseOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { ArrowUpGlyph } from "../glyphs";
import { parseBtwCommand, selectIsTurnActive, selectSkillCatalog, selectActiveCwd } from "../../state";
import type { SkillCatalog } from "../../state";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { useAskSide } from "../btw/use-ask-side";
import { ConversationDock } from "../conversation/ConversationDock";
import { TESTID } from "../testids";
import { updatePreferences, useUiState } from "../ui-state";
import { CheckoutBar } from "./CheckoutBar";
import { ModelPicker } from "./ModelPicker";
import { PermissionPicker } from "./PermissionPicker";
import { ReasoningPicker } from "./ReasoningPicker";
import { SkillMenu } from "./SkillMenu";
import type { SkillMenuStatus } from "./SkillMenu";
import { acceptCommand, matchCommands, menuOptions } from "./commands";
import type { MenuOption } from "./commands";
import { detectMagicKeyword, segmentDraft } from "./magic-keyword";
import { acceptSkill, detectSkillTrigger, pruneSelected, rankSkills, serializeSkillDraft } from "./skill-draft";
import type { SkillDraft } from "./skill-draft";
import { capImages, IMAGE_LIMIT, isImageFile, readImage, type ImageInput } from "./attachments";
import { userMessageParts } from "../conversation/UserBubble";
import css from "./Composer.module.css";

const NO_THREAD_DRAFT = "";
const EMPTY_DRAFT: SkillDraft = { text: "", selected: [] };
const NO_OPTIONS: readonly MenuOption[] = [];

function menuStatus(hasThread: boolean, loaded: boolean, catalog: SkillCatalog | null): SkillMenuStatus {
  if (!hasThread) return { kind: "startSession" };
  if (!loaded || catalog === null) return { kind: "resumeSession" };
  if (catalog.status === "error") return { kind: "error", message: catalog.errors.map((error) => error.message).join("; ") };
  return catalog.status === "ready" ? { kind: "ready" } : { kind: "loading" };
}

function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  );
}

/**
 * The message capsule at the bottom of the main pane. Drafts are kept per thread for the
 * lifetime of the component; without an active thread, sending first starts a thread in the
 * chosen workspace (the native picker opens when none is known). A "/" token at the caret opens
 * the skill menu; picked skills are sent as the leading `/skill:` run.
 */
export function Composer() {
  const t = useT();
  const actions = useActions();
  const askSide = useAskSide();
  const activeThreadId = useAppSelector((state) => state.activeThreadId);
  const turnActive = useAppSelector(selectIsTurnActive);
  const connected = useAppSelector((state) => state.bridge?.state === "connected");
  const lastWorkspace = useUiState().preferences?.lastWorkspace ?? null;
  const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
  const workspace = pickedWorkspace ?? lastWorkspace;

  const activeCwd = useAppSelector(selectActiveCwd);
  const cwdLoaded = useAppSelector((state) => activeCwd !== null && state.loadedSkillCwds[activeCwd] === true);
  const catalog = useAppSelector((state) => (activeCwd === null ? null : selectSkillCatalog(state, activeCwd)));

  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const text = draft.text;
  const [images, setImages] = useState<ImageInput[]>([]);
  const [imageNotice, setImageNotice] = useState("");
  const [dropping, setDropping] = useState(false);
  const imageDrafts = useRef(new Map<string, ImageInput[]>());
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const addImages = (added: ImageInput[]): void => {
    setImages((current) => {
      if (current.length + added.length > IMAGE_LIMIT) setImageNotice(t("composer.images.limit"));
      return capImages(current, added);
    });
  };
  const addFiles = async (files: File[]): Promise<void> => {
    if (!connected || busy) return;
    setImageNotice("");
    const accepted = files.filter((file) => isImageFile(file.name, file.type));
    if (accepted.length !== files.length) setImageNotice(t("composer.images.rejected"));
    try { addImages(await Promise.all(accepted.slice(0, IMAGE_LIMIT + 1).map(readImage))); }
    catch (error) { setImageNotice(t("composer.images.error", { message: String(error) })); }
  };
  const pickImages = async (): Promise<void> => {
    setImageNotice("");
    try {
      const paths = await window.omo.pickImages();
      const accepted = paths.filter((path) => isImageFile(path));
      if (accepted.length !== paths.length) setImageNotice(t("composer.images.rejected"));
      addImages(accepted.map((path) => ({ type: "localImage", path })));
    } catch (error) { setImageNotice(t("composer.images.error", { message: String(error) })); }
  };
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const [limitReached, setLimitReached] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const drafts = useRef(new Map<string, SkillDraft>());
  const draftThread = useRef(activeThreadId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseId = useId();
  const listboxId = `${baseId}-skills`;
  const optionId = useCallback((index: number): string => `${baseId}-skill-${index}`, [baseId]);

  useLayoutEffect(() => {
    if (draftThread.current === activeThreadId) return;
    imageDrafts.current.set(draftThread.current ?? NO_THREAD_DRAFT, imagesRef.current);
    setImages(imageDrafts.current.get(activeThreadId ?? NO_THREAD_DRAFT) ?? []);
    setImageNotice("");
    drafts.current.set(draftThread.current ?? NO_THREAD_DRAFT, draftRef.current);
    draftThread.current = activeThreadId;
    const next = drafts.current.get(activeThreadId ?? NO_THREAD_DRAFT) ?? EMPTY_DRAFT;
    setDraft(next);
    setCaret(next.text.length);
    setDismissedStart(null);
    setLimitReached(false);
  }, [activeThreadId]);

  useLayoutEffect(() => {
    const target = pendingCaret.current;
    const el = inputRef.current;
    if (target === null || el === null) return;
    pendingCaret.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(target, target);
  }, [draft]);

  const trigger = connected && !composing ? detectSkillTrigger(text, caret) : null;
  const menuOpen = trigger !== null && trigger.start !== dismissedStart;
  const triggerKey = trigger === null ? "" : `${trigger.start}:${trigger.query}`;
  const status = menuStatus(activeThreadId !== null, cwdLoaded, catalog);
  const query = trigger?.query ?? "";
  const catalogSkills = catalog?.skills;
  const rows = useMemo(
    () => (menuOpen && cwdLoaded && catalogSkills !== undefined ? rankSkills(catalogSkills, query) : []),
    [menuOpen, cwdLoaded, catalogSkills, query],
  );
  const options = useMemo(
    () => (menuOpen ? menuOptions(matchCommands(query), rows, query) : NO_OPTIONS),
    [menuOpen, rows, query],
  );
  const activeIndex =
    options.length === 0 ? -1 : highlight.key === triggerKey ? Math.min(highlight.index, options.length - 1) : 0;
  const triggerStart = useRef<number | null>(null);
  triggerStart.current = trigger?.start ?? null;

  const catalogStatus = catalog?.status;
  useEffect(() => {
    if (menuOpen && cwdLoaded && activeCwd !== null) void actions.ensureSkills(activeCwd);
  }, [actions, menuOpen, cwdLoaded, activeCwd, catalogStatus]);

  const keepDismissal = (nextText: string, selection: number): void => {
    setDismissedStart((dismissed) =>
      dismissed !== null && detectSkillTrigger(nextText, selection)?.start === dismissed ? dismissed : null,
    );
  };

  const edit = (nextText: string, selection: number): void => {
    setDraft((current) => ({ text: nextText, selected: pruneSelected(nextText, current.selected) }));
    setCaret(selection);
    setLimitReached(false);
    keepDismissal(nextText, selection);
  };

  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const selection = event.currentTarget.selectionStart;
    setCaret(selection);
    keepDismissal(event.currentTarget.value, selection);
  };

  const dismissMenu = useCallback((): void => {
    setDismissedStart(triggerStart.current);
    setLimitReached(false);
  }, []);

  const pickOption = (index: number): void => {
    const option = options[index];
    if (option === undefined || trigger === null) return;
    if (option.kind === "command") {
      const accepted = acceptCommand(draft.text, trigger, option.command.name);
      pendingCaret.current = accepted.caret;
      setDraft({ text: accepted.text, selected: pruneSelected(accepted.text, draft.selected) });
      setCaret(accepted.caret);
      setLimitReached(false);
      return;
    }
    const result = acceptSkill(draft, trigger, option.skill.name);
    if (!result.ok) {
      setLimitReached(true);
      return;
    }
    pendingCaret.current = result.caret;
    setDraft(result.draft);
    setCaret(result.caret);
    setLimitReached(false);
  };

  const fit = useCallback((): void => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "0px";
    const max = parseFloat(getComputedStyle(el).maxHeight);
    el.style.height = `${Number.isFinite(max) ? Math.min(el.scrollHeight, max) : el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [fit, text]);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [fit]);

  const blank = text.trim() === "";
  const canSend = connected && (!blank || images.length > 0) && !busy;
  const keyword = detectMagicKeyword(text);
  const segments = useMemo(() => segmentDraft(text), [text]);
  const syncMirrorScroll = (): void => {
    const mirror = mirrorRef.current;
    const el = inputRef.current;
    if (mirror !== null && el !== null) mirror.scrollTop = el.scrollTop;
  };
  useLayoutEffect(syncMirrorScroll, [text]);

  const pickWorkspace = async (): Promise<string | null> => {
    const dir = await window.omo.pickDirectory(workspace);
    if (dir === null) return null;
    setPickedWorkspace(dir);
    void updatePreferences({ lastWorkspace: dir });
    return dir;
  };

  const routeSideCommand = (question: string): void => {
    actions.setSidePanel(true);
    if (activeThreadId === null) return;
    setDraft(EMPTY_DRAFT);
    setDismissedStart(null);
    if (question !== "") void askSide(question);
  };

  const submit = async (): Promise<void> => {
    const message = text.trim();
    if (!canSend) return;
    const command = parseBtwCommand(message);
    if (command !== null && images.length === 0) {
      routeSideCommand(command.question);
      return;
    }
    const selected = draft.selected;
    const transport = serializeSkillDraft({ text: message, selected });
    setBusy(true);
    try {
      if (activeThreadId === null) {
        const cwd = workspace ?? (await pickWorkspace());
        if (cwd === null) return;
        const threadId = await actions.newThread(cwd);
        if (threadId === null) return;
        drafts.current.delete(NO_THREAD_DRAFT);
      }
      setDraft(EMPTY_DRAFT);
      setImages([]);
      imageDrafts.current.delete(NO_THREAD_DRAFT);
      setDismissedStart(null);
      const sent = await actions.sendMessage(transport, images);
      if (!sent) {
        setImages((current) => capImages(images, current));
        setDraft((current) => (current.text === "" ? { text: message, selected: pruneSelected(message, selected) } : current));
        setCaret(message.length);
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (options.length === 0) return;
        const offset = event.key === "ArrowDown" ? 1 : -1;
        setHighlight({ key: triggerKey, index: (activeIndex + offset + options.length) % options.length });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissMenu();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeIndex >= 0) {
        event.preventDefault();
        pickOption(activeIndex);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  const keepFocus = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };

  const placeholder = !connected
    ? t("composer.placeholder.disconnected")
    : activeThreadId === null
      ? workspace === null
        ? t("composer.placeholder.heroNoWorkspace")
        : t("composer.placeholder.hero", { workspace: basename(workspace) })
      : turnActive
        ? t("composer.placeholder.running")
        : t("composer.placeholder.idle");
  // A /btw or /side draft goes to the side panel, so it never steers the running turn.
  const steers = turnActive && parseBtwCommand(text) === null;
  const sendLabel = steers ? t("composer.steer") : t("composer.send");

  return (
    <div className={css.root}>
      <ConversationDock />
      <div
        className={clsx(css.card, !connected && css.cardDisabled, keyword !== null && css.cardMagic, dropping && css.cardDrop)}
        data-testid={TESTID.composer}
        data-composer-card=""
        data-keyword={keyword?.keyword}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDropping(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false); }}
        onDrop={(event) => { event.preventDefault(); setDropping(false); void addFiles(Array.from(event.dataTransfer.files)); }}
      >
        {menuOpen && (
          <SkillMenu
            listboxId={listboxId}
            optionId={optionId}
            status={status}
            options={options}
            diagnostics={status.kind === "ready" ? (catalog?.errors ?? []) : []}
            catalogEmpty={catalogSkills === undefined || catalogSkills.length === 0}
            activeIndex={activeIndex}
            limitReached={limitReached}
            onPick={pickOption}
            onHover={(index) => setHighlight({ key: triggerKey, index })}
            onRetry={() => {
              if (activeCwd !== null) void actions.loadSkills(activeCwd, { force: true });
            }}
            onDismiss={dismissMenu}
          />
        )}
        {dropping && <div className={css.imageNotice} role="status">{t("composer.images.drop")}</div>}
        {images.length > 0 && <div className={css.images}>
          {userMessageParts(images).images.map((image, index) => <div key={image.key} className={css.thumbnail} data-testid={TESTID.attachmentThumbnail}>
            <img src={image.src} alt={t("composer.images.preview", { number: index + 1 })} />
            <button type="button" className={css.removeImage} data-testid={TESTID.attachmentRemove} aria-label={t("composer.images.remove", { number: index + 1 })} onClick={() => setImages((current) => current.filter((_, position) => position !== index))}><IconCloseOutlineRegular size={14} /></button>
          </div>)}
        </div>}
        {imageNotice !== "" && <div className={css.imageNotice} data-testid={TESTID.attachmentNotice} role="status">{imageNotice}</div>}
        <div className={css.scroll}>
          <div ref={mirrorRef} className={css.mirror} aria-hidden>
            {segments.map((segment, index) =>
              segment.kind === "keyword" ? (
                <span key={index} className={css.keyword} data-testid={TESTID.keywordHighlight}>
                  {segment.text}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
            {"\u200b"}
          </div>
          <textarea
            ref={inputRef}
            className={css.input}
            data-testid={TESTID.composerInput}
            aria-label={t("composer.inputLabel")}
            role="combobox"
            aria-multiline
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-activedescendant={menuOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder={placeholder}
            rows={1}
            value={text}
            disabled={!connected}
            onChange={(event) => edit(event.target.value, event.target.selectionStart)}
            onSelect={onSelect}
            onCompositionStart={() => {
              composingRef.current = true;
              setComposing(true);
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setComposing(false);
              setCaret(event.currentTarget.selectionStart);
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length > 0) { event.preventDefault(); void addFiles(files); }
            }}
            onKeyDown={onKeyDown}
            onScroll={syncMirrorScroll}
          />
        </div>
        {keyword !== null && (
          <div className={css.keywordHint} data-testid={TESTID.keywordHint} role="status">
            <span className={css.keywordHintName}>{keyword.text}</span>
            {t("composer.keyword.hint")}
          </div>
        )}
        <div className={css.row}>
          <div className={css.tools}>
            <button type="button" className={css.chip} data-testid={TESTID.attachmentPick} aria-label={t("composer.images.attach")} disabled={!connected || busy || images.length >= IMAGE_LIMIT} onClick={() => void pickImages()}><IconPaperclipOutlineRegular size={16} /></button>
            {connected && <PermissionPicker disabled={!connected} />}
            {activeThreadId === null && (
              <button
                type="button"
                className={css.chip}
                data-testid={TESTID.workspaceChip}
                aria-label={workspace === null ? t("composer.workspace.choose") : t("composer.workspace.label", { path: workspace })}
                title={workspace ?? undefined}
                disabled={!connected}
                onClick={() => void pickWorkspace()}
              >
                <IconFolderOpenOutlineRegular className={css.chipIcon} size={14} />
                <span className={css.chipLabel}>{workspace === null ? t("composer.workspace.choose") : basename(workspace)}</span>
              </button>
            )}
          </div>
          <div className={css.trailing}>
            {steers && !blank && (
              <span className={css.hint} data-testid={TESTID.steeringHint}>
                {t("composer.steering")}
              </span>
            )}
            <ModelPicker disabled={!connected} />
            <ReasoningPicker disabled={!connected} />
            {turnActive && (
              <Tooltip label={t("composer.stop")} side="top" delayMs={500}>
                <button
                  type="button"
                  className={clsx(css.primary, css.stop)}
                  data-testid={TESTID.composerStop}
                  aria-label={t("composer.stop")}
                  onMouseDown={keepFocus}
                  onClick={() => void actions.interrupt()}
                >
                  <StopIcon />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sendLabel} side="top" delayMs={500} disabled={!canSend}>
              <button
                type="button"
                className={css.primary}
                data-testid={TESTID.composerSend}
                aria-label={sendLabel}
                disabled={!canSend}
                onMouseDown={keepFocus}
                onClick={() => void submit()}
              >
                <ArrowUpGlyph size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <CheckoutBar />
    </div>
  );
}

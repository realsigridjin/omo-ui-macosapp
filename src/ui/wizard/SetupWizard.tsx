import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCloseOutlineRegular,
  focusWithoutRing,
  useModalLayer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { Model } from "../../../shared/protocol";
import type { Preferences } from "../../../shared/ipc";
import { selectThreadsByWorkspace } from "../../state";
import { useT } from "../../i18n";
import type { MessageKey } from "../../i18n";
import { StoreContext, useActions, useAppSelector } from "../app-context";
import { resolveEffort } from "../composer/model-groups";
import { BrandMark } from "../glyphs";
import { formatThreadTime } from "../sidebar/thread-time";
import { WorkspaceBadge } from "../sidebar/WorkspaceBadge";
import { TESTID } from "../testids";
import { updatePreferences, uiState } from "../ui-state";
import css from "./SetupWizard.module.css";

const STEPS = ["welcome", "model", "project", "ready"] as const;
type Step = (typeof STEPS)[number];

const STEP_KEY: Record<Step, MessageKey> = {
  welcome: "wizard.step.welcome",
  model: "wizard.step.model",
  project: "wizard.step.project",
  ready: "wizard.step.ready",
};

const TITLE_KEY: Record<Step, MessageKey> = {
  welcome: "wizard.welcome.title",
  model: "wizard.model.title",
  project: "wizard.project.title",
  ready: "wizard.ready.title",
};

const INTRO_KEY: Record<Step, MessageKey> = {
  welcome: "wizard.welcome.body",
  model: "wizard.model.body",
  project: "wizard.project.body",
  ready: "wizard.ready.telemetry",
};

const TIME_TICK_MS = 30_000;

interface ProjectRow {
  cwd: string;
  label: string;
  count: number;
  lastActivity: number | null;
}

function folderBasename(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(cut + 1) || cwd;
}

export function SetupWizard() {
  const t = useT();
  const actions = useActions();
  const store = useContext(StoreContext);
  const bridge = useAppSelector((state) => state.bridge);
  const catalog = useAppSelector((state) => state.models);
  const models = useMemo(() => catalog.filter((model) => !model.hidden), [catalog]);
  const threadsLoaded = useAppSelector((state) => state.threadsLoaded);
  const groups = useAppSelector(selectThreadsByWorkspace);
  const modelId = useAppSelector((state) => state.composer.modelId);
  const profile = useAppSelector((state) => state.composer.profile ?? null);
  const [step, setStep] = useState<Step>("welcome");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  const [groupOpen, setGroupOpen] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const stepIndex = STEPS.indexOf(step);
  const selectedModel = models.find((model) => model.id === modelId) ?? null;
  const projects = useMemo(() => {
    const rows = new Map<string, ProjectRow>();
    for (const group of groups) {
      rows.set(group.cwd, {
        cwd: group.cwd,
        label: group.label,
        count: group.threads.length,
        lastActivity: group.threads.reduce((max, thread) => Math.max(max, thread.updatedAt), 0),
      });
    }
    for (const cwd of added) {
      if (!rows.has(cwd)) rows.set(cwd, { cwd, label: folderBasename(cwd), count: 0, lastActivity: null });
    }
    return [...rows.values()];
  }, [groups, added]);
  const selectedNames = projects.filter((project) => selected.has(project.cwd)).map((project) => project.label);

  const focusPrimary = (): void => {
    if (primary.current !== null) focusWithoutRing(primary.current);
  };

  useEffect(() => {
    focusPrimary();
  }, [step]);

  const finish = (rememberProjects: boolean): void => {
    uiState.setOnboardingOpen(false);
    const patch: Partial<Preferences> = { onboardingCompleted: true };
    if (rememberProjects && selected.size > 0) {
      const chosen = [...selected];
      const existing = uiState.get().preferences?.recentWorkspaces ?? [];
      patch.lastWorkspace = chosen[0] ?? null;
      patch.recentWorkspaces = [...chosen, ...existing.filter((path) => !selected.has(path))].slice(0, 10);
    }
    void updatePreferences(patch);
  };

  const close = (): void => finish(false);

  const next = (): void => {
    setStep(STEPS[stepIndex + 1] ?? "ready");
  };

  const pickModel = (model: Model): void => {
    void actions.selectModel(model.id, resolveEffort(model, null), profile ?? undefined);
    focusPrimary();
  };

  const toggleProject = (cwd: string, on: boolean): void => {
    setSelected((current) => {
      const set = new Set(current);
      if (on) set.add(cwd);
      else set.delete(cwd);
      return set;
    });
    focusPrimary();
  };

  const selectAll = (): void => {
    setSelected(new Set(projects.map((project) => project.cwd)));
    focusPrimary();
  };

  const selectNone = (): void => {
    setSelected(new Set());
    focusPrimary();
  };

  const addProject = async (): Promise<void> => {
    const cwd = await window.omo.pickDirectory(null);
    if (cwd === null) return;
    setAdded((current) => new Set(current).add(cwd));
    setSelected((current) => new Set(current).add(cwd));
    setGroupOpen(true);
    focusPrimary();
  };

  const noProject = (): void => {
    setSelected(new Set());
    setStep("ready");
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button, input, textarea, select, a[href]") !== null) return;
    event.preventDefault();
    if (step === "ready") finish(true);
    else next();
  };

  useModalLayer(panel, true, close);

  const primaryLabel = step === "ready" ? t("wizard.start") : t("wizard.continue");
  const onPrimary = step === "ready" ? () => finish(true) : next;

  return createPortal(
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={close} />
      <div
        ref={panel}
        tabIndex={-1}
        className={css.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={TESTID.wizard}
        onKeyDown={onPanelKeyDown}
      >
        <header className={css.header}>
          <span className={css.brand}>
            <BrandMark size={20} className={css.brandMark} />
            <span className={css.brandName}>{t("app.brand")}</span>
          </span>
          <button
            type="button"
            className={css.close}
            aria-label={t("common.close")}
            data-testid={TESTID.wizardClose}
            onClick={close}
          >
            <IconCloseOutlineRegular size={14} />
          </button>
        </header>
        <ol className={css.stepper} aria-label={t("wizard.aria.steps")}>
          {STEPS.map((id, index) => {
            const state = index < stepIndex ? "done" : index === stepIndex ? "current" : "todo";
            return (
              <li key={id} className={css.stepItem}>
                <button
                  type="button"
                  className={clsx(css.step, css[state])}
                  data-testid={TESTID.wizardStep}
                  data-step={id}
                  data-state={state}
                  aria-current={state === "current" ? "step" : undefined}
                  disabled={state !== "done"}
                  onClick={state === "done" ? () => setStep(id) : undefined}
                >
                  <span className={css.stepBadge} aria-hidden="true">
                    {state === "done" ? <IconCheckOutlineRegular size={11} /> : index + 1}
                  </span>
                  <span className={css.stepLabel}>{t(STEP_KEY[id])}</span>
                </button>
                {index < STEPS.length - 1 && <span className={css.stepConnector} aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
        <div className={css.body}>
          <h2 className={css.title} id={titleId}>
            {t(TITLE_KEY[step])}
          </h2>
          {step === "welcome" ? (
            <>
              <p className={css.intro}>{t("wizard.welcome.body")}</p>
              <p className={css.version}>
                {bridge?.omo?.version === undefined
                  ? t("wizard.welcome.versionPending")
                  : t("wizard.welcome.version", { version: bridge.omo.version })}
              </p>
            </>
          ) : step === "model" ? (
            models.length === 0 ? (
              <p className={css.hint}>{t("wizard.model.loading")}</p>
            ) : (
              <div className={css.modelList} role="radiogroup" aria-label={t("wizard.model.title")}>
                {models.map((model) => {
                  const checked = model.id === modelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      className={clsx(css.modelRow, checked && css.modelRowActive)}
                      data-testid={TESTID.wizardModelOption}
                      data-model-id={model.id}
                      title={model.id}
                      onClick={() => pickModel(model)}
                    >
                      <span className={css.modelCopy}>
                        <span className={css.modelName}>{model.displayName}</span>
                        {model.description !== "" && <span className={css.modelDescription}>{model.description}</span>}
                      </span>
                      {checked && <IconCheckOutlineRegular size={16} className={css.modelCheck} />}
                    </button>
                  );
                })}
              </div>
            )
          ) : step === "project" ? (
            <>
              <p className={css.intro}>{t("wizard.project.body")}</p>
              {projects.length === 0 ? (
                <p className={css.hint}>{threadsLoaded ? t("wizard.project.empty") : t("wizard.project.loading")}</p>
              ) : (
                <>
                  <div className={css.selectBar}>
                    <span className={css.selectedCount} data-testid={TESTID.wizardSelectedCount}>
                      {t("wizard.project.selectedCount", { selected: selected.size, total: projects.length })}
                    </span>
                    <button
                      type="button"
                      className={css.linkButton}
                      data-testid={TESTID.wizardSelectAll}
                      disabled={selected.size === projects.length}
                      onClick={selectAll}
                    >
                      {t("wizard.project.selectAll")}
                    </button>
                    <button
                      type="button"
                      className={css.linkButton}
                      data-testid={TESTID.wizardSelectNone}
                      disabled={selected.size === 0}
                      onClick={selectNone}
                    >
                      {t("wizard.project.selectNone")}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={css.groupToggle}
                    data-testid={TESTID.wizardProjectGroup}
                    aria-expanded={groupOpen}
                    onClick={() => setGroupOpen((open) => !open)}
                  >
                    <IconChevronDownOutlineRegular
                      size={12}
                      className={clsx(css.chevron, !groupOpen && css.chevronClosed)}
                    />
                    {t("wizard.project.group", { count: projects.length })}
                  </button>
                  {groupOpen && (
                    <ul className={css.projectList}>
                      {projects.map((project) => (
                        <li key={project.cwd}>
                          <label
                            className={css.projectRow}
                            data-testid={TESTID.wizardProjectRow}
                            data-cwd={project.cwd}
                            title={project.cwd}
                          >
                            <input
                              type="checkbox"
                              className={css.projectCheck}
                              data-testid={TESTID.wizardProjectCheckbox}
                              checked={selected.has(project.cwd)}
                              onChange={(event) => toggleProject(project.cwd, event.target.checked)}
                            />
                            <WorkspaceBadge cwd={project.cwd} size="sm" />
                            <span className={css.projectName}>{project.label}</span>
                            <span className={css.projectMeta}>
                              <span>{t("wizard.project.threadCount", { count: project.count })}</span>
                              {project.lastActivity !== null && project.lastActivity > 0 && (
                                <span>{formatThreadTime(project.lastActivity, nowMs, t)}</span>
                              )}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <dl className={css.summary}>
                <dt>{t("wizard.ready.model")}</dt>
                <dd className={css.summaryValue}>{selectedModel?.displayName ?? t("composer.model.none")}</dd>
                <dt>{t("wizard.ready.projects")}</dt>
                <dd className={css.summaryValue}>
                  {selectedNames.length === 0 ? t("wizard.ready.noProjects") : selectedNames.join(" · ")}
                </dd>
              </dl>
              <p className={css.telemetry}>{t("wizard.ready.telemetry")}</p>
            </>
          )}
        </div>
        <footer className={css.footer}>
          {step === "project" && (
            <>
              <Button variant="outline" data-testid={TESTID.wizardNoProject} onClick={noProject}>
                {t("wizard.project.noProject")}
              </Button>
              <Button variant="outline" data-testid={TESTID.wizardNewProject} onClick={() => void addProject()}>
                {t("shell.newProject")}
              </Button>
            </>
          )}
          <Button
            ref={primary}
            variant="primary"
            data-testid={step === "ready" ? TESTID.wizardStart : TESTID.wizardContinue}
            data-modal-autofocus=""
            onClick={onPrimary}
          >
            {primaryLabel}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

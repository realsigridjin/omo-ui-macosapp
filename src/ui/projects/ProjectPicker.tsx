import { useId, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import { Button, IconCheckOutlineRegular, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { pathPartsOf } from "@deepseek-ai/dsh-util-workspace-path";
import { useLocale, useT } from "../../i18n";
import { workspaceName } from "../conversation/format";
import { PlusCircleGlyph } from "../glyphs";
import { WorkspaceBadge } from "../sidebar/WorkspaceBadge";
import { initialProject } from "./project-list";
import type { ProjectEntry } from "./project-list";
import { PROJECT_TESTID } from "./testids";
import css from "./ProjectPicker.module.css";

const LABELS = {
  en: {
    title: "Select a project",
    description: "Choose where the new thread starts.",
    projects: "Projects",
    recent: "Recent",
    oneThread: "1 thread",
    newProjectHint: "Choose a folder on this computer",
    continue: "Continue",
    starting: "Starting thread…",
  },
  ko: {
    title: "프로젝트 선택",
    description: "새 스레드를 시작할 프로젝트를 고르세요.",
    projects: "프로젝트",
    recent: "최근",
    oneThread: "스레드 1개",
    newProjectHint: "이 컴퓨터에서 폴더 선택",
    continue: "계속",
    starting: "스레드를 시작하는 중…",
  },
};

/** Where a project lives, for the second line of its row: the parent directory, or the directory itself at a root. */
function projectLocation(cwd: string): string {
  const { directory } = pathPartsOf(cwd);
  if (directory === "") return cwd;
  const parent = directory.replace(/[/\\]+$/, "");
  return parent === "" || /^[A-Za-z]:$/.test(parent) ? directory : parent;
}

/** "picking" while the native folder dialog is open, "starting" while thread/start is pending. */
export type ProjectPickerBusy = "picking" | "starting";

export interface ProjectPickerProps {
  open: boolean;
  /** Known projects in display order (`listProjects`). */
  projects: readonly ProjectEntry[];
  /** Selected on open when it is listed; otherwise the first project is. */
  lastWorkspace: string | null;
  /** Locks the actions; closing is also ignored while a thread is starting. */
  busy: ProjectPickerBusy | null;
  /** Why a thread cannot start right now (omo is not connected); shown in the footer, and locks the actions. */
  unavailable: string | null;
  /** Start a thread in the selected project. */
  onContinue(cwd: string): void;
  /** Choose a folder for a new project. */
  onNewProject(): void;
  onClose(): void;
}

/**
 * The centered project chooser: one selectable row per known project, a New project row that leads to the native
 * folder picker, and Continue. It holds only the selection; `ProjectPickerHost` supplies the projects and starts the thread.
 */
export function ProjectPicker(props: ProjectPickerProps) {
  return props.open ? <OpenProjectPicker {...props} /> : null;
}

function OpenProjectPicker({ projects, lastWorkspace, busy, unavailable, onContinue, onNewProject, onClose }: ProjectPickerProps) {
  const t = useT();
  const labels = LABELS[useLocale()];
  const id = useId();
  const [selectedCwd, setSelectedCwd] = useState(() => initialProject(projects, lastWorkspace)?.cwd ?? null);
  const selected = projects.find((project) => project.cwd === selectedCwd) ?? projects[0] ?? null;
  const locked = busy !== null || unavailable !== null;

  const submit = (): void => {
    if (!locked && selected !== null) onContinue(selected.cwd);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  };

  const threadsLabel = (count: number): string => {
    if (count === 0) return labels.recent;
    return count === 1 ? labels.oneThread : t("shell.sidebar.threadCount", { count });
  };

  return (
    <Modal
      open
      onClose={() => {
        if (busy !== "starting") onClose();
      }}
      className={css.card}
      contentClassName={css.content}
      title={labels.title}
      closeLabel={t("common.close")}
      description={labels.description}
      footer={
        <>
          <span className={css.status} role="status">
            {busy === "starting" ? labels.starting : unavailable}
          </span>
          <Button variant="outline" className={css.action} disabled={busy === "starting"} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            className={css.action}
            data-testid={PROJECT_TESTID.projectContinue}
            disabled={locked || selected === null}
            onClick={submit}
          >
            {labels.continue}
          </Button>
        </>
      }
    >
      <div className={css.picker} data-testid={PROJECT_TESTID.projectPicker}>
        {projects.length > 0 && (
          <div className={css.list} role="radiogroup" aria-label={labels.projects} aria-disabled={locked} onKeyDown={onListKeyDown}>
            {projects.map((project, index) => {
              const checked = project === selected;
              return (
                <label
                  key={project.cwd}
                  className={clsx(css.row, checked && css.selected)}
                  title={project.cwd}
                  data-testid={PROJECT_TESTID.projectOption}
                  data-cwd={project.cwd}
                  data-selected={checked ? "" : undefined}
                  onDoubleClick={submit}
                >
                  <input
                    type="radio"
                    className={css.radio}
                    name={id}
                    checked={checked}
                    aria-labelledby={`${id}-name-${index}`}
                    aria-describedby={`${id}-path-${index} ${id}-meta-${index}`}
                    data-modal-autofocus={checked ? "" : undefined}
                    onChange={() => {
                      if (!locked) setSelectedCwd(project.cwd);
                    }}
                  />
                  <WorkspaceBadge cwd={project.cwd} className={css.badge} />
                  <span className={css.text}>
                    <span className={css.name} id={`${id}-name-${index}`}>
                      {workspaceName(project.cwd)}
                    </span>
                    <span className={css.path} id={`${id}-path-${index}`}>
                      <bdi dir="ltr">{projectLocation(project.cwd)}</bdi>
                    </span>
                  </span>
                  <span className={css.meta} id={`${id}-meta-${index}`}>
                    {threadsLabel(project.threadCount)}
                  </span>
                  <span className={css.check} aria-hidden="true">
                    {checked && <IconCheckOutlineRegular size={14} />}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className={css.newProject}
          data-testid={PROJECT_TESTID.projectNew}
          disabled={locked}
          onClick={onNewProject}
        >
          <span className={css.newIcon}>
            <PlusCircleGlyph size={20} />
          </span>
          <span className={css.text}>
            <span className={css.name}>{t("shell.newProject")}</span>
            <span className={css.hint}>{labels.newProjectHint}</span>
          </span>
        </button>
      </div>
    </Modal>
  );
}

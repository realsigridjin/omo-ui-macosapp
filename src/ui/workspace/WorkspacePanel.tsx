import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFile } from "../../../shared/workspace";
import { useLocale } from "../../i18n";
import { useAppSelector } from "../app-context";
import css from "./WorkspacePanel.module.css";

const LABELS = {
  en: { title: "Files", close: "Close files", refresh: "Refresh files", changed: "Changes", all: "All files", search: "Search files", file: "File", diff: "Diff", loading: "Loading...", empty: "No files match", noChanges: "No changed files", noDiff: "No changes in this file", select: "Select a file to preview", noWorkspace: "Select a conversation to browse its workspace", readOnly: "Read only", tabClose: "Close tab", error: "Could not load workspace" },
  ko: { title: "파일", close: "파일 패널 닫기", refresh: "파일 새로고침", changed: "변경 사항", all: "모든 파일", search: "파일 검색", file: "파일", diff: "Diff", loading: "불러오는 중...", empty: "일치하는 파일 없음", noChanges: "변경된 파일 없음", noDiff: "이 파일에 변경 사항 없음", select: "미리 볼 파일을 선택하세요", noWorkspace: "대화를 선택해 작업 폴더를 확인하세요", readOnly: "읽기 전용", tabClose: "탭 닫기", error: "작업 폴더를 불러오지 못했습니다" },
};

export interface WorkspacePanelProps {
  placement: "docked" | "overlay";
  onClose: () => void;
}

export function WorkspacePanel({ placement, onClose }: WorkspacePanelProps) {
  const cwd = useAppSelector((state) => state.activeThreadId === null ? null : state.threads[state.activeThreadId]?.cwd ?? null);
  return <WorkspaceContents key={cwd ?? "no-workspace"} cwd={cwd} placement={placement} onClose={onClose} />;
}

function WorkspaceContents({ cwd, placement, onClose }: WorkspacePanelProps & { cwd: string | null }) {
  const labels = LABELS[useLocale()];
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "diff">("file");
  const [filter, setFilter] = useState("");
  const [changesOnly, setChangesOnly] = useState(true);
  const [revision, setRevision] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ text: string; language: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (cwd === null) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void window.omo.listWorkspaceFiles(cwd).then((next) => {
      if (cancelled) return;
      setFiles(next);
    }, (error: unknown) => {
      if (!cancelled) setListError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setListLoading(false);
    });
    return () => { cancelled = true; };
  }, [cwd, revision]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    if (cwd === null || selected === null) return;
    let cancelled = false;
    setPreviewLoading(true);
    const request = mode === "diff"
      ? window.omo.getWorkspaceDiff(cwd, selected).then((text) => ({ text, language: "diff" }))
      : window.omo.readWorkspaceFile(cwd, selected);
    void request.then((document) => {
      if (!cancelled) setPreview(document);
    }, (error: unknown) => {
      if (!cancelled) setPreviewError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => { cancelled = true; };
  }, [cwd, selected, mode, revision]);

  const changed = files.filter((file) => file.status !== "").length;
  const filtered = useMemo(() => files.filter((file) => (!changesOnly || file.status !== "") && file.path.toLowerCase().includes(filter.toLowerCase())), [files, changesOnly, filter]);
  const lines = useMemo(() => preview?.text.split("\n") ?? [], [preview]);
  const openFile = (file: WorkspaceFile) => {
    setTabs((current) => current.includes(file.path) ? current : [...current, file.path]);
    setSelected(file.path);
    if (file.status.includes("D")) setMode("diff");
  };
  const closeTab = (file: string) => {
    const remaining = tabs.filter((tab) => tab !== file);
    setTabs(remaining);
    if (selected === file) setSelected(remaining.at(-1) ?? null);
  };

  return (
    <aside className={css.panel} data-placement={placement} data-testid="workspace-panel" aria-label={labels.title} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <header className={css.header} data-window-drag>
        <span className={css.title}>{labels.title}</span>
        {cwd !== null && <span className={css.workspace} title={cwd}>{cwd.split(/[\\/]/).filter(Boolean).at(-1)}</span>}
        <button className={css.iconButton} type="button" aria-label={labels.refresh} title={labels.refresh} disabled={cwd === null || listLoading} onClick={() => setRevision((value) => value + 1)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 6a5 5 0 1 0 .1 3M13 2.5V6H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <button className={css.iconButton} type="button" aria-label={labels.close} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </header>
      {cwd === null ? <p className={css.empty}>{labels.noWorkspace}</p> : <>
        <div className={css.tabs} aria-label={labels.title}>
          {tabs.map((file) => <div className={css.tab} data-active={selected === file || undefined} key={file}>
            <button type="button" className={css.tabSelect} title={file} aria-pressed={selected === file} onClick={() => setSelected(file)}>{file.split("/").at(-1)}</button>
            <button type="button" className={css.tabClose} aria-label={`${labels.tabClose}: ${file}`} onClick={() => closeTab(file)}>x</button>
          </div>)}
          {tabs.length === 0 && <span className={css.tabPlaceholder}>{labels.readOnly}</span>}
        </div>
        <div className={css.previewToolbar}>
          <span className={css.path} title={selected ?? ""}>{selected ?? labels.select}</span>
          <div className={css.segmented}>
            <button type="button" aria-pressed={mode === "file"} onClick={() => setMode("file")}>{labels.file}</button>
            <button type="button" aria-pressed={mode === "diff"} onClick={() => setMode("diff")}>{labels.diff}</button>
          </div>
        </div>
        <div className={css.preview} aria-busy={previewLoading} tabIndex={0} role="region" aria-label={selected ?? labels.select} data-read={mode === "file" || undefined} data-diff={mode === "diff" || undefined}>
          {previewError !== null ? <p className={css.error} role="alert">{previewError}</p>
            : previewLoading ? <p className={css.empty} role="status">{labels.loading}</p>
            : preview === null ? <p className={css.empty}>{labels.select}</p>
            : mode === "diff" && preview.text === "" ? <p className={css.empty}>{labels.noDiff}</p>
            : <pre className={css.code} data-language={preview.language}>{lines.map((line, index) => <span key={index} className={css.line} data-kind={mode === "diff" ? line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : line.startsWith("@@") ? "hunk" : undefined : undefined}><span className={css.lineNumber} aria-hidden="true">{mode === "file" ? index + 1 : ""}</span><span>{line || " "}</span>{"\n"}</span>)}</pre>}
        </div>
        <section className={css.files} aria-label={labels.changed}>
          <div className={css.listToolbar}>
            <div className={css.listSwitch}>
              <button type="button" aria-pressed={changesOnly} onClick={() => setChangesOnly(true)}>{labels.changed} <span className={css.count}>{changed}</span></button>
              <button type="button" aria-pressed={!changesOnly} onClick={() => setChangesOnly(false)}>{labels.all}</button>
            </div>
          </div>
          <input className={css.search} type="search" aria-label={labels.search} placeholder={labels.search} value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className={css.fileList} aria-busy={listLoading}>
            {listError !== null ? <p className={css.error} role="alert">{labels.error}: {listError}</p>
              : listLoading ? <p className={css.empty} role="status">{labels.loading}</p>
              : filtered.length === 0 ? <p className={css.empty}>{changesOnly && filter === "" ? labels.noChanges : labels.empty}</p>
              : <ul>{filtered.map((file) => <li key={file.path}><button className={css.fileRow} type="button" data-active={selected === file.path || undefined} title={file.path} aria-pressed={selected === file.path} onClick={() => openFile(file)}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2H4v12h8V4.5L9.5 2ZM9 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg><span className={css.filePath}>{file.path}</span><span className={css.status} data-status={file.status.includes("D") ? "deleted" : file.status.includes("A") || file.status === "??" ? "added" : "modified"}>{file.status === "??" ? "U" : file.status}</span></button></li>)}</ul>}
          </div>
        </section>
        <footer className={css.footer}><span>{labels.readOnly}</span><span>{preview?.language ?? ""}</span></footer>
      </>}
    </aside>
  );
}

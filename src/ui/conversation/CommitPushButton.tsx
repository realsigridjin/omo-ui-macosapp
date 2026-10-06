import { useEffect, useRef, useState } from "react";
import { IconChevronDownOutlineRegular, Menu, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import type { GitCommitResult } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { GIT_REFRESH_EVENT, useGitInfo } from "../git/use-git-info";
import css from "./CommitPushButton.module.css";

/**
 * Split button shown for git workspaces next to Open: the primary action opens a dialog that lists
 * `git status --porcelain` changes, commits everything (`git add -A` + commit) and pushes; the
 * chevron menu offers commit-only. Git failures surface verbatim inside the dialog, and a push
 * without an upstream is skipped with a notice instead of an error.
 */
export function CommitPushButton({ cwd }: { cwd: string }) {
  const t = useT();
  const info = useGitInfo(cwd);
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [push, setPush] = useState(true);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GitCommitResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (info === null) return null;

  const start = (withPush: boolean): void => {
    setPush(withPush);
    setOpen(true);
    setMenuOpen(false);
    setResult(null);
    setError(null);
    setChanges(null);
    setMessage("");
    window.omo
      .gitStatus(cwd)
      .then(setChanges, (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)));
  };

  const submit = (): void => {
    if (busy || message.trim() === "") return;
    setBusy(true);
    setError(null);
    window.omo
      .gitCommitPush(cwd, message, push)
      .then(
        (outcome) => {
          setResult(outcome);
          window.dispatchEvent(new Event(GIT_REFRESH_EVENT));
          window.omo.gitStatus(cwd).then(setChanges, () => setChanges(null));
        },
        (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setBusy(false));
  };

  const menuItems = [{ id: "commit-only", label: t("conversation.commit.commitOnly") }];
  const canSubmit = !busy && message.trim() !== "";

  return (
    <>
      <div className={css.split} data-testid={TESTID.commitButton}>
        <Tooltip label={t("conversation.commit.tooltip")} side="bottom" align="end" delayMs={500}>
          <button type="button" className={css.primary} onClick={() => start(true)} disabled={open}>
            <span className={css.label}>{t("conversation.commit.label")}</span>
          </button>
        </Tooltip>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={menuItems}
          onSelect={() => start(false)}
          portal
          anchor={
            <button
              type="button"
              className={css.chevron}
              data-testid={TESTID.commitMenu}
              aria-label={t("conversation.commit.more")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <IconChevronDownOutlineRegular size={12} />
            </button>
          }
        />
      </div>

      {open && (
        <div className={css.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t("conversation.commit.title")} data-testid={TESTID.commitDialog}>
            <div className={css.header}>
              <h2 className={css.title}>{t("conversation.commit.title")}</h2>
              <span className={css.branch}>{info.branch}</span>
            </div>
            <div className={css.changes} data-testid={TESTID.commitChanges}>
              {changes === null && <span className={css.hint}>{t("conversation.commit.loading")}</span>}
              {changes !== null && changes.length === 0 && <span className={css.hint}>{t("conversation.commit.clean")}</span>}
              {changes?.map((line) => (
                <span key={line} className={css.changeLine}>
                  <code>{line.slice(0, 2)}</code>
                  <span className={css.changePath}>{line.slice(3)}</span>
                </span>
              ))}
            </div>
            <input
              ref={inputRef}
              className={css.message}
              data-testid={TESTID.commitMessage}
              type="text"
              placeholder={t("conversation.commit.message")}
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmit) submit();
              }}
            />
            {error !== null && (
              <div className={css.error} data-testid={TESTID.commitError} role="alert">
                {t("conversation.commit.failed", { message: error })}
              </div>
            )}
            {result !== null && (
              <div className={css.result} data-testid={TESTID.commitResult} role="status">
                {result.committed
                  ? result.pushed
                    ? t("conversation.commit.result", { hash: result.commitHash ?? "" })
                    : t("conversation.commit.resultNoPush", { hash: result.commitHash ?? "" })
                  : t("conversation.commit.nothing")}
                {result.pushSkipped === "no-upstream" && <span className={css.notice}>{t("conversation.commit.pushSkipped")}</span>}
              </div>
            )}
            <div className={css.actions}>
              <button type="button" className={css.cancel} data-testid={TESTID.commitCancel} onClick={() => setOpen(false)} disabled={busy}>
                {t("conversation.commit.cancel")}
              </button>
              <button type="button" className={css.submit} data-testid={TESTID.commitSubmit} onClick={submit} disabled={!canSubmit}>
                {push ? t("conversation.commit.label") : t("conversation.commit.submitOnly")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { IconChevronDownOutlineRegular, IconFolderOpenOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { selectActiveCwd } from "../../state";
import { useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { useGitInfo } from "../git/use-git-info";
import { middleTruncate } from "../git/middle-truncate";
import { BranchGlyph } from "../glyphs";
import css from "./CheckoutBar.module.css";

const BRANCH_MAX_LENGTH = 28;

function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

/**
 * Thin bar attached under the composer card: the workspace folder button (opens the workspace in
 * the default Open target) on the left, and the current branch with upstream ahead/behind counts
 * on the right. The branch and counts hide for non-git folders and branches without an upstream.
 */
export function CheckoutBar() {
  const t = useT();
  const cwd = useAppSelector(selectActiveCwd);
  const info = useGitInfo(cwd);
  if (cwd === null) return null;
  return (
    <div
      className={css.bar}
      data-testid={TESTID.checkoutBar}
      data-git={info !== null ? "" : undefined}
      data-ahead={info?.ahead ?? undefined}
      data-behind={info?.behind ?? undefined}
    >
      <button
        type="button"
        className={css.folder}
        data-testid={TESTID.checkoutFolder}
        aria-label={t("composer.checkout.open", { path: cwd })}
        title={cwd}
        onClick={() => {
          window.omo.openWorkspace(cwd, null).catch((error: unknown) => console.warn("workspace did not open", error));
        }}
      >
        <IconFolderOpenOutlineRegular size={13} className={css.icon} />
        <span className={css.folderLabel}>{basename(cwd)}</span>
        <IconChevronDownOutlineRegular size={11} className={css.chevron} />
      </button>
      {info !== null && (
        <span
          className={css.branch}
          data-testid={TESTID.checkoutBranch}
          data-branch={info.branch}
          title={t("composer.checkout.branch", { branch: info.branch })}
        >
          {info.ahead !== null && info.behind !== null && (
            <span className={css.counts} data-testid={TESTID.checkoutCounts} aria-label={t("composer.checkout.counts", { ahead: info.ahead, behind: info.behind })}>
              <span aria-hidden>↑{info.ahead}</span>
              <span aria-hidden>↓{info.behind}</span>
            </span>
          )}
          <BranchGlyph size={13} className={css.icon} />
          <span className={css.branchName}>{middleTruncate(info.branch, BRANCH_MAX_LENGTH)}</span>
          <IconChevronDownOutlineRegular size={11} className={css.chevron} aria-hidden />
        </span>
      )}
    </div>
  );
}

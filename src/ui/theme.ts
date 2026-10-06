import { flushSync } from "react-dom";
import type { ColorTheme, ThemePreference } from "../../shared/ipc";
import { themeRevealGeometry } from "./theme-reveal";

let appliedPreference: ThemePreference | undefined;
let appliedColorTheme: ColorTheme | undefined;
let stopFollowingSystem: (() => void) | undefined;
let activeTransition: ViewTransition | undefined;
let latestChoice = 0;

const DARK_ATTRIBUTE = "data-ds-dark-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function setDark(dark: boolean): void {
  if (dark) document.body.setAttribute(DARK_ATTRIBUTE, "");
  else document.body.removeAttribute(DARK_ATTRIBUTE);
}

/**
 * Applies a theme preference to `document.body` (DSH dark tokens key off `data-ds-dark-theme`).
 * "system" follows `prefers-color-scheme` until another preference is applied.
 */
export function applyThemePreference(pref: ThemePreference): void {
  if (appliedPreference === pref) return;
  stopFollowingSystem?.();
  stopFollowingSystem = undefined;
  appliedPreference = pref;
  if (pref !== "system") {
    setDark(pref === "dark");
    return;
  }
  const query = window.matchMedia(DARK_QUERY);
  const sync = (): void => setDark(query.matches);
  sync();
  query.addEventListener("change", sync);
  stopFollowingSystem = () => query.removeEventListener("change", sync);
}

/** Applies an accent palette; "omo" clears the override so the default tokens apply. */
export function applyColorTheme(theme: ColorTheme): void {
  if (appliedColorTheme === theme) return;
  appliedColorTheme = theme;
  if (theme === "omo") delete document.body.dataset["colorTheme"];
  else document.body.dataset["colorTheme"] = theme;
}

/**
 * Apply in the snapshot update callback before persisting the preference. Skipping an earlier transition does not
 * cancel its update callback, so an update whose choice was superseded by a later one applies and persists nothing.
 */
export function revealThemePreference(pref: ThemePreference, control: HTMLElement, persist: () => void): void {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia(DARK_QUERY).matches);
  if (dark === document.body.hasAttribute(DARK_ATTRIBUTE)) {
    // No visible change, but this is still the latest choice: a pending reveal must not apply after it.
    activeTransition?.skipTransition();
    latestChoice++;
    applyThemePreference(pref);
    persist();
    return;
  }
  revealThemeChange(control, () => {
    applyThemePreference(pref);
    persist();
  });
}

/**
 * Runs the circle-reveal view transition from `control` while `apply` swaps tokens inside the
 * snapshot update callback. Reduced motion or a missing ViewTransition API applies directly.
 */
export function revealThemeChange(control: HTMLElement, apply: () => void): void {
  activeTransition?.skipTransition();
  const choice = ++latestChoice;
  const update = (): void => {
    if (choice !== latestChoice) return;
    flushSync(apply);
  };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches
    || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  const { x, y, radius } = themeRevealGeometry(control.getBoundingClientRect(), {
    width: window.innerWidth, height: window.innerHeight,
  });
  const root = document.documentElement;
  root.style.setProperty("--dsh-theme-reveal-x", `${x}px`);
  root.style.setProperty("--dsh-theme-reveal-y", `${y}px`);
  const transition = document.startViewTransition(update);
  activeTransition = transition;
  void transition.ready.then(() => {
    // Punch the same circle out of the old snapshot so translucent surfaces
    // show native vibrancy, not a second copy of the old UI underneath.
    root.animate(
      { "--dsh-theme-reveal-radius": ["0px", `${radius}px`] },
      { duration: 500, easing: "ease", fill: "forwards", pseudoElement: "::view-transition-old(root)" },
    );
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 500, easing: "ease", pseudoElement: "::view-transition-new(root)" },
    );
  }, (error: unknown) => {
    // A subsequent choice can deliberately skip this snapshot before it is ready.
    if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
  });
  void transition.finished.then(() => {
    if (activeTransition === transition) activeTransition = undefined;
  });
}

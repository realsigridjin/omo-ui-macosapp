import type { ReactNode } from "react";
import css from "./SettingsCard.module.css";

/** Small heading above a settings column's cards: title plus muted intro. */
export function SettingsGroup({ title, intro }: { title: string; intro?: string }) {
  return (
    <header className={css.sectionHeading}>
      <h3 className={css.sectionTitle}>{title}</h3>
      {intro !== undefined && <p className={css.sectionIntro}>{intro}</p>}
    </header>
  );
}

/** Rounded card that groups related rows; rows inside divide themselves with hairlines. */
export function SettingsCard({ children, testId, dataAttrs }: {
  children: ReactNode;
  testId?: string;
  dataAttrs?: Record<string, string>;
}) {
  return (
    <div className={css.card} data-testid={testId} {...dataAttrs}>
      {children}
    </div>
  );
}

/** One preference row: title, muted description, and the control at the right edge. */
export function SettingsRow({ title, description, children }: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.rowTitle}>{title}</div>
        {description !== undefined && <div className={css.rowHint}>{description}</div>}
      </div>
      {children !== undefined && <div className={css.rowControl}>{children}</div>}
    </div>
  );
}

/** Switch control for boolean preferences. */
export function Toggle({ checked, disabled, label, onChange, testId }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(): void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={css.toggle}
      onClick={onChange}
    >
      <span className={css.toggleKnob} />
    </button>
  );
}

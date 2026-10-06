import type { IconProps } from "@deepseek-ai/dsh-client-ui-primitives";

/** The OmO app icon (build/icon.svg) at UI size: dark rounded tile, two eye rings, orange smile. */
export function BrandMark({ size = 20, className }: IconProps) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#26272d" />
      <rect x="112" y="112" width="800" height="800" rx="175" fill="none" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="24" />
      <g fill="none" stroke="#f3efe6" strokeWidth="60">
        <circle cx="352" cy="420" r="98" />
        <circle cx="672" cy="420" r="98" />
      </g>
      <path
        d="M392 744 V682 a60 60 0 0 1 120 0 V744 M512 682 a60 60 0 0 1 120 0 V744"
        fill="none"
        stroke="#ff9a52"
        strokeWidth="54"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 2x3 dot grip. */
export function GripGlyph({ size = 14, className }: IconProps) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} className={className} aria-hidden>
      {[3, 7, 11].flatMap((y) =>
        [5, 9].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />),
      )}
    </svg>
  );
}

/** Open padlock. */
export function LockOpenGlyph({ size = 14, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V4.8a2.5 2.5 0 0 1 4.9-.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Generic code-editor glyph used for the Open button (a chevron pair in a rounded tile). */
export function EditorGlyph({ size = 14, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.3 5.6 4 8l2.3 2.4M9.7 5.6 12 8l-2.3 2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Terminal prompt in a rounded tile. */
export function TerminalGlyph({ size = 14, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="m4.5 6 2.2 2-2.2 2M8 10.3h3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Git branch: a vertical line forking into two commits. */
export function BranchGlyph({ size = 14, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <circle cx="4.5" cy="3.8" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.5v5M4.5 9.4c0-2.6 2-3.4 4.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Plus inside a circle, for the dashed New project button. */
export function PlusCircleGlyph({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 4.8v6.4M4.8 8h6.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/** Up arrow for the round send button. */
export function ArrowUpGlyph({ size = 16, className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden>
      <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

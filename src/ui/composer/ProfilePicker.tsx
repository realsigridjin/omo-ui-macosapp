import { useEffect, useRef, useState } from "react";
import type { Model } from "../../../shared/protocol";
import type { ModelProfile, Preferences } from "../../../shared/ipc";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { laneAt, PROFILE_LANES, resolveProfile } from "./model-profiles";
import css from "./ProfilePicker.module.css";

const FONT: Record<string, string> = {
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01111/10000/10000/10000/10000/10000/01111",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01111/10000/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "11111/00100/00100/00100/00100/00100/11111",
  J: "00111/00010/00010/00010/10010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/10101/01010",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  "5": "11111/10000/10000/11110/00001/00001/11110",
  "6": "01110/10000/10000/11110/10001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  ".": "00000/00000/00000/00000/00000/00100/00100",
  "-": "00000/00000/00000/11111/00000/00000/00000",
};

/** How long the LED readout scrambles from left to right before it settles on the new text. */
const LED_SCRAMBLE_MS = 140;

function Led({
  name,
  effort,
  profile,
  geeky,
}: {
  name: string;
  effort: string;
  profile: string;
  geeky: boolean;
}) {
  const [phase, setPhase] = useState(1);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / LED_SCRAMBLE_MS);
      setPhase(progress);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    setPhase(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [name, effort, profile]);
  const rows = [
    name.toUpperCase().slice(0, 24),
    `${effort.toUpperCase().padEnd(8)}${profile.toUpperCase()}`.slice(0, 24),
  ];
  return (
    <div
      className={css.led}
      data-geeky={geeky}
      data-testid={TESTID.profileLed}
      role="img"
      aria-label={`${name} · ${effort.toUpperCase()} · ${profile}`}
      data-model={name}
      data-effort={effort.toUpperCase()}
      data-settled={phase === 1}
    >
      <svg viewBox="0 0 575 67" aria-hidden="true">
        {rows.flatMap((text, line) =>
          Array.from({ length: 24 }, (_, column) => {
            const char =
              phase < 1 && column / 24 > phase
                ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[
                    (column + Math.floor(phase * 30)) % 26
                  ]!
                : (text[column] ?? " ");
            const bitmap = (FONT[char] ?? "").replaceAll("/", "");
            return Array.from({ length: 35 }, (_, pixel) => (
              <circle
                key={`${line}-${column}-${pixel}`}
                cx={column * 24 + (pixel % 5) * 4 + 3}
                cy={line * 36 + Math.floor(pixel / 5) * 4 + 3}
                r="1.25"
                className={
                  bitmap[pixel] === "1"
                    ? line === 1 && column >= 8
                      ? css.dimDot
                      : css.litDot
                    : css.offDot
                }
              />
            ));
          }),
        )}
      </svg>
    </div>
  );
}

export function ProfilePicker({
  models,
  current,
  profileModels,
  onConfigure,
  onSelect,
}: {
  models: Model[];
  current: ModelProfile | null;
  profileModels?: Preferences["profileModels"];
  onConfigure: (profile: ModelProfile) => void;
  onSelect: (profile: ModelProfile) => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<ModelProfile>(
    current ?? "daily-normal",
  );
  const lane = PROFILE_LANES.find((entry) => entry.id === preview)!;
  const [position, setPosition] = useState({
    x: lane.x as number,
    y: lane.y as number,
  });
  const dragging = useRef(false);
  const dot = useRef<HTMLButtonElement>(null);
  const resolved = resolveProfile(models, preview, profileModels);
  const configuredModelId = profileModels?.[preview];
  const configuredModelUnavailable = configuredModelId !== undefined && !models.some((model) => !model.hidden && model.id === configuredModelId);
  const name =
    resolved.model?.displayName.replace(/^Claude\s+/i, "") ??
    t("composer.model.none");
  const title = `${t(`composer.profile.${lane.family}`)} · ${t(`composer.profile.${lane.weight}`)}`;
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(1, (event.clientX - rect.left) / rect.width),
    );
    const y = Math.max(
      0,
      Math.min(1, (event.clientY - rect.top) / rect.height),
    );
    setPreview(laneAt(x, y));
    return { x, y };
  };
  const snap = (profile: ModelProfile) => {
    const target = PROFILE_LANES.find((entry) => entry.id === profile)!;
    setPosition({ x: target.x, y: target.y });
  };
  return (
    <div className={css.profile}>
      <Led
        name={name}
        effort={resolved.effort ?? ""}
        profile={`${lane.family} ${lane.weight}`}
        geeky={lane.family === "geeky"}
      />
      <div className={css.layout}>
        <div className={css.axes}>
          <div className={css.horizontal}>
            <span>{t("composer.profile.daily")}</span>
            <span>{t("composer.profile.geeky")}</span>
          </div>
          <div className={css.vertical}>
            <span>{t("composer.profile.heavy")}</span>
            <span>{t("composer.profile.normal")}</span>
          </div>
          <div
            className={css.pad}
            data-testid={TESTID.profilePad}
            onPointerDown={(event) => {
              event.preventDefault();
              dot.current?.focus();
              dragging.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setPosition(point(event));
            }}
            onPointerMove={(event) => {
              const next = point(event);
              if (dragging.current) setPosition(next);
            }}
            onPointerLeave={() => {
              if (!dragging.current) setPreview(current ?? "daily-normal");
            }}
            onPointerUp={(event) => {
              if (!dragging.current) return;
              dragging.current = false;
              const next = point(event);
              const profile = laneAt(next.x, next.y);
              snap(profile);
              onSelect(profile);
            }}
            onPointerCancel={() => {
              dragging.current = false;
              setPreview(current ?? "daily-normal");
              snap(current ?? "daily-normal");
            }}
          >
            {PROFILE_LANES.map((entry) => (
              <div
                key={entry.id}
                className={css.lane}
                data-active={entry.id === preview}
                data-geeky={entry.family === "geeky"}
              >
                {resolveProfile(models, entry.id, profileModels).model?.displayName.replace(/^Claude\s+/i, "") ?? entry.name}
              </div>
            ))}
            <button
              ref={dot}
              type="button"
              className={css.dot}
              data-testid={TESTID.profileDot}
              aria-label={t("composer.profile.pad")}
              aria-describedby="profile-keyboard-help"
              style={{
                left: `${position.x * 100}%`,
                top: `${position.y * 100}%`,
              }}
              disabled={models.length === 0}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key,
                  )
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  const next = laneAt(
                    event.key === "ArrowLeft"
                      ? 0.25
                      : event.key === "ArrowRight"
                        ? 0.75
                        : lane.x,
                    event.key === "ArrowUp"
                      ? 0.25
                      : event.key === "ArrowDown"
                        ? 0.75
                        : lane.y,
                  );
                  setPreview(next);
                  snap(next);
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(preview);
                }
              }}
            />
          </div>
          <div className={css.caption}>{t("composer.profile.pull")}</div>
          <span id="profile-keyboard-help" className={css.srOnly}>
            {t("composer.profile.keyboard")}
          </span>
        </div>
        <div
          className={css.card}
          data-testid={TESTID.profilePreview}
          data-profile={preview}
        >
          <div className={css.cardHeader}>
            <strong>{title}</strong>
            <span>
              {t(
                current === preview
                  ? "composer.profile.current"
                  : "composer.profile.preview",
              )}
            </span>
          </div>
          <p>{t(`composer.profile.description.${preview}`)}</p>
          <button type="button" className={css.configure} data-profile-configure={preview} onClick={() => onConfigure(preview)}>
            {t("composer.profile.model")}
          </button>
          <div className={css.resolved}>
            {configuredModelUnavailable && <span role="status" data-profile-unavailable={preview}>
              {t("composer.profile.model")}: {configuredModelId} · {t("composer.model.searchEmpty")}
            </span>}
            <span>{configuredModelUnavailable ? `${t("composer.profile.automatic")} · ` : ""}{t("composer.profile.resolved")}</span>
            <strong>
              {name} · {resolved.effort ?? "—"}
            </strong>
          </div>
        </div>
      </div>
    </div>
  );
}

import type { Model, ReasoningEffort } from "../../../shared/protocol";
import type { ModelProfile, Preferences } from "../../../shared/ipc";

export const PROFILE_LANES = [
  {
    id: "daily-heavy",
    family: "daily",
    weight: "heavy",
    name: "Fable 5.1",
    pattern: /fable[\s-]*5[.\s-]*1/i,
    fallback: /fable|claude|anthropic/i,
    effort: "xhigh",
    x: 0.25,
    y: 0.25,
  },
  {
    id: "geeky-heavy",
    family: "geeky",
    weight: "heavy",
    name: "GPT-6 Astra",
    pattern: /gpt[\s-]*6[\s-]*astra/i,
    fallback: /astra|gpt|openai/i,
    effort: "xhigh",
    x: 0.75,
    y: 0.25,
  },
  {
    id: "daily-normal",
    family: "daily",
    weight: "normal",
    name: "Opus 5.5",
    pattern: /opus[\s-]*5[.\s-]*5/i,
    fallback: /opus|claude|anthropic/i,
    effort: "medium",
    x: 0.25,
    y: 0.75,
  },
  {
    id: "geeky-normal",
    family: "geeky",
    weight: "normal",
    name: "GPT-6 Sol Fast",
    pattern: /gpt[\s-]*6[\s-]*sol[\s-]*fast/i,
    fallback: /sol|gpt|openai/i,
    effort: "medium",
    x: 0.75,
    y: 0.75,
  },
] as const;

export function laneAt(x: number, y: number): ModelProfile {
  return `${x < 0.5 ? "daily" : "geeky"}-${y < 0.5 ? "heavy" : "normal"}`;
}

/** Configured visible model, otherwise Automatic: exact name/id, nearest named family, provider family, default, then first visible model. */
export function resolveProfile(
  models: readonly Model[],
  profile: ModelProfile,
  profileModels?: Preferences["profileModels"],
): { model: Model | null; effort: ReasoningEffort | null } {
  const lane = PROFILE_LANES.find((entry) => entry.id === profile)!;
  const visible = models.filter((model) => !model.hidden);
  const text = (model: Model): string =>
    `${model.displayName} ${model.id} ${model.model}`;
  const family = lane.name
    .split(" ")
    .find((part) => ["Fable", "Opus", "Astra", "Sol"].includes(part))!;
  const model =
    visible.find((entry) => entry.id === profileModels?.[profile]) ??
    visible.find((entry) => lane.pattern.test(text(entry))) ??
    visible.find((entry) =>
      text(entry).toLowerCase().includes(family.toLowerCase()),
    ) ??
    visible.find((entry) => lane.fallback.test(text(entry))) ??
    visible.find((entry) => entry.isDefault) ??
    visible[0] ??
    null;
  if (model === null) return { model, effort: null };
  const supported = model.supportedReasoningEfforts.map(
    (entry) => entry.reasoningEffort,
  );
  const order: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const effort = supported.includes(lane.effort)
    ? lane.effort
    : ([...supported].sort(
        (a, b) =>
          Math.abs(order.indexOf(a) - order.indexOf(lane.effort)) -
          Math.abs(order.indexOf(b) - order.indexOf(lane.effort)),
      )[0] ?? null);
  return { model, effort };
}

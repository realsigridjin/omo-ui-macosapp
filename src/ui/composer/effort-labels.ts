import type { ReasoningEffort } from "../../../shared/protocol";
import type { MessageKey } from "../../i18n";

/** Locale label of each reasoning effort, shared by the model and reasoning pickers. */
export const EFFORT_KEY: Record<ReasoningEffort, MessageKey> = {
  none: "composer.effort.none",
  minimal: "composer.effort.minimal",
  low: "composer.effort.low",
  medium: "composer.effort.medium",
  high: "composer.effort.high",
  xhigh: "composer.effort.xhigh",
  max: "composer.effort.max",
};

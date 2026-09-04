import type { Intention } from "../common/types.js";
import type { WorldModel } from "../common/world-model.js";
import type { BdiOption } from "./strategy.js";
import { intentionStillValid, optionToIntention } from "./strategy.js";

const SWITCH_THRESHOLD = 5;

/** Implements BDI commitment: keep a valid intention unless a clearly better option appears. */
export function reviseIntention(
  world: WorldModel,
  current: Intention | null,
  selected: BdiOption,
  actionTickMs = 350
): { intention: Intention; changed: boolean; reason: string } {
  if (!current || !intentionStillValid(world, current, actionTickMs)) {
    return {
      intention: optionToIntention(selected, world.tick),
      changed: true,
      reason: current ? "current-intention-invalid" : "no-current-intention"
    };
  }

  // Waiting is a fallback, not a goal worth preserving. Map and crate sensing can arrive
  // after the first cycle, so switch as soon as deliberation discovers real work.
  if (current.kind === "wait" && selected.kind !== "wait") {
    return {
      intention: optionToIntention(selected, world.tick),
      changed: true,
      reason: "work-became-available"
    };
  }

  if (selected.score > current.priority + SWITCH_THRESHOLD) {
    return {
      intention: optionToIntention(selected, world.tick),
      changed: true,
      reason: `better-option-by-${(selected.score - current.priority).toFixed(2)}`
    };
  }

  return { intention: current, changed: false, reason: "commitment-persists" };
}

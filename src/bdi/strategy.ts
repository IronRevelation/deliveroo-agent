import type { Intention, ParcelBelief, Position } from "../common/types.js";
import { manhattan, samePosition, uniqueId } from "../common/utils.js";
import type { WorldModel } from "../common/world-model.js";

export interface BdiOption {
  kind: "pickup" | "deliver" | "explore" | "wait";
  target?: Position;
  parcel?: ParcelBelief;
  score: number;
  reason: string;
}

/** Generates and ranks the BDI agent's current desires using reward, decay, distance, and conflict costs. */
export function generateOptions(world: WorldModel, actionTickMs = 350): BdiOption[] {
  const me = world.me;
  if (!me) return [{ kind: "wait", score: -100, reason: "waiting for self state" }];

  const options: BdiOption[] = [];
  const carriedCount = world.carriedParcelBeliefs().length;
  const requiredStack = world.strategyRules.requiredStackSize;
  const stackLimit = requiredStack ?? world.carryingCapacity;
  const canPickMore = stackLimit < 0 || carriedCount < stackLimit;
  // With an "exactly N parcels" mission the agent must keep looking until the stack is
  // complete; delivering a short stack early would fail the mission even if nothing else
  // is currently visible, so only the stack size unlocks delivery here.
  const shouldDeliver = carriedCount > 0 && (!requiredStack || carriedCount >= requiredStack);

  if (shouldDeliver) {
    for (const delivery of world.deliveryTiles()) {
      const travelSteps = world.shortestRouteDistance(me.position, delivery, false);
      if (travelSteps === null) continue;
      const bonus = world.bonusForDelivery(delivery)?.multiplier ?? 1;
      const expectedReward = world.totalCarriedRewardAfterSteps(travelSteps, actionTickMs);
      if (expectedReward <= 0) continue;
      const score = expectedReward * bonus - travelSteps;
      options.push({
        kind: "deliver",
        target: delivery,
        score,
        reason: `deliver ${carriedCount} parcel(s) to ${delivery.x},${delivery.y}, expectedReward=${expectedReward}`
      });
    }
  }

  if (canPickMore) {
    for (const parcel of world.reachableParcels()) {
      const stepsToParcel = world.shortestRouteDistance(me.position, parcel.position, false);
      const delivery = world.nearestDeliveryWithDistance(parcel.position, true);
      if (stepsToParcel === null || !delivery) continue;
      const conflictPenalty = world.agents().some((agent) => manhattan(agent.position, parcel.position) <= 2) ? 4 : 0;
      const travelCost = stepsToParcel + delivery.distance;
      const expectedNewReward = world.rewardAfterTravel(parcel, travelCost, actionTickMs, 2);
      if (expectedNewReward <= 0) continue;
      const expectedCarriedReward = carriedCount > 0 ? world.totalCarriedRewardAfterSteps(travelCost, actionTickMs, 2) : 0;
      const stackBonus = carriedCount > 0 ? Math.min(4, carriedCount + 1) : 0;
      const score = expectedCarriedReward + expectedNewReward * parcel.confidence - travelCost - conflictPenalty + stackBonus;
      options.push({
        kind: "pickup",
        target: parcel.position,
        parcel,
        score,
        reason:
          `pickup ${parcel.id}: reward=${parcel.reward}, expectedNewAtDelivery=${expectedNewReward}, ` +
          `expectedCarriedAfterDetour=${expectedCarriedReward}, stack=${carriedCount + 1}/${stackLimit}, confidence=${parcel.confidence.toFixed(2)}`
      });
    }
  }

  if (options.length === 0) {
    const explorationTarget = world.explorationTarget(true);
    if (explorationTarget) {
      options.push({
        kind: "explore",
        target: explorationTarget,
        score: -0.1,
        reason: `explore toward ${explorationTarget.x},${explorationTarget.y} to refresh parcel beliefs`
      });
    } else {
      options.push({ kind: "wait", score: -1, reason: "no viable pickup, delivery, or exploration target" });
    }
  }

  return options.sort((a, b) => b.score - a.score);
}

/** Promotes a selected desire into the explicit commitment stored by the BDI loop. */
export function optionToIntention(option: BdiOption, tick: number): Intention {
  return {
    id: uniqueId("intent"),
    kind: option.kind,
    target: option.target,
    parcelId: option.parcel?.id,
    priority: option.score,
    createdAt: tick,
    reason: option.reason
  };
}

/** Rechecks a commitment against changing beliefs so obsolete plans are abandoned promptly. */
export function intentionStillValid(world: WorldModel, intention: Intention, actionTickMs = 350): boolean {
  if (!world.me) return false;
  if (intention.kind === "wait") return true;
  if (!intention.target) return false;

  if (intention.kind === "explore") {
    return !samePosition(world.me.position, intention.target) && world.isWalkable(intention.target, false);
  }

  if (intention.kind === "pickup") {
    const parcel = world.parcels().find((candidate) => candidate.id === intention.parcelId);
    const stepsToParcel = world.shortestRouteDistance(world.me.position, intention.target, false);
    const delivery = world.nearestDeliveryWithDistance(intention.target, true);
    const routeSteps = stepsToParcel !== null && delivery ? stepsToParcel + delivery.distance : null;
    const canDeliver =
      parcel &&
      routeSteps !== null &&
      world.rewardAfterTravel(parcel, routeSteps, actionTickMs, 2) > 0 &&
      (world.carriedParcelBeliefs().length === 0 || world.totalCarriedRewardAfterSteps(routeSteps, actionTickMs, 2) > 0);
    return Boolean(
      parcel &&
        parcel.confidence >= 0.25 &&
        parcel.reward > 0 &&
        !parcel.carriedBy &&
        canDeliver &&
        samePosition(parcel.position, intention.target) &&
        world.isWalkable(intention.target, false)
    );
  }

  if (intention.kind === "deliver") {
    return (
      world.totalCarriedRewardAfterTravel(intention.target, actionTickMs, true) > 0 &&
      world.deliveryTiles().some((tile) => samePosition(tile, intention.target!))
    );
  }

  return true;
}

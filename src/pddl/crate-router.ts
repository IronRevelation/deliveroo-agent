import { Pathfinder, type PathWorld } from "../common/pathfinder.js";
import { CRATE_AREA_TILES, WALKABLE_TILES, adjacentPositions, allowsEntry } from "../common/tiles.js";
import type { AgentConfig, PlanAction, PlannerWorldSnapshot, Position, Tile } from "../common/types.js";
import { directionBetween, manhattan, nextPosition, positionKey, samePosition } from "../common/utils.js";
import type { Logger } from "../common/logger.js";
import { PddlPlanner } from "./planner.js";

/** Prevents an unchanged unsolvable crate layout from invoking the external planner every tick. */
const FAILED_ROUTE_COOLDOWN_MS = 750;

export interface CrateRouteResult {
  actions: PlanAction[];
  /** True when the actions end on the requested destination. */
  success: boolean;
  /** True when crates were cleared but the destination still needs another planning round. */
  partial: boolean;
  /** Number of PDDL passages used; zero when plain A* already reached the destination. */
  passages: number;
  reason?: string;
}

/** Uses A* for normal routes and global PDDL planning for crate-blocked routes. */
export class CrateRouter {
  private readonly planner: PddlPlanner;
  private readonly retryAfterByProblem = new Map<string, number>();

  constructor(
    private readonly config: AgentConfig,
    logger: Logger
  ) {
    this.planner = new PddlPlanner(config, logger);
  }

  /** Plans a route from the agent's current position to `goal`, using PDDL only when needed. */
  async route(snapshot: PlannerWorldSnapshot, goal: Position): Promise<CrateRouteResult> {
    const world = new SnapshotWorld(snapshot.tiles, snapshot.crates, snapshot.forbiddenTiles);
    const pathfinder = new Pathfinder(world);
    const start = snapshot.me.position;

    const direct = pathfinder.findPath(start, goal, false);
    if (direct) return { actions: toMoves(direct), success: true, partial: false, passages: 0 };
    if (!this.config.pddlEnabled) return fail("crates block the route and PDDL is disabled");

    const now = Date.now();
    for (const [key, retryAfter] of this.retryAfterByProblem) {
      if (retryAfter <= now) this.retryAfterByProblem.delete(key);
    }
    const problemKey = routeKey(start, goal, world.cratePositions());
    if (this.retryAfterByProblem.has(problemKey)) {
      return fail("crate planner cooling down after an unsuccessful route");
    }

    const optimistic = pathfinder.findPathThroughCrates(start, goal, false);
    if (!optimistic) return fail("destination unreachable");

    // Plan over the complete statically reachable component. This lets PDDL move several
    // interacting crates and choose a different corridor instead of only clearing the first
    // crate found on an optimistic A* path.
    const region = world.reachableTiles(start);
    const crates = world.cratePositions().filter((crate) => region.some((tile) => samePosition(tile, crate)));
    let plannedGoal = goal;
    let exploratoryPush = false;
    let plan = await this.planner.planCratePassage({
      tiles: region,
      crates,
      start,
      goal
    });

    // Under partial observability, an exact distant goal can be unsolvable with the current
    // beliefs even though a nearby push would expose a new part of the maze. In that case,
    // ask the same global model for a route through a pushable boundary crate. The next
    // sensing event then extends the belief state before the original goal is tried again.
    if (!plan.success) {
      const frontierGoal = world.frontierGoal(start, goal);
      if (frontierGoal) {
        plan = await this.planner.planCratePassage({
          tiles: region,
          crates,
          start,
          goal: frontierGoal
        });
        if (plan.success) {
          plannedGoal = frontierGoal;
          exploratoryPush = true;
        }
      }
    }
    if (!plan.success) return this.failedAttempt(problemKey, "global crate planner found no route");

    const finalPosition = simulate(world, start, plan.actions);
    if (!finalPosition || !samePosition(finalPosition, plannedGoal)) {
      return this.failedAttempt(problemKey, "global crate plan did not reach the destination");
    }

    // Execute through the first irreversible push, then revise the sensed crate state and
    // solve the global problem again. This preserves safety without losing the global view.
    const actions = throughFirstPush(plan.actions);
    if (actions.length === 0) return this.failedAttempt(problemKey, "global crate planner returned no push");
    const partialPosition = simulate(world, start, actions);
    const reachedGoal = Boolean(partialPosition && samePosition(partialPosition, goal));
    this.retryAfterByProblem.delete(problemKey);
    return {
      actions,
      success: reachedGoal,
      partial: !reachedGoal,
      passages: 1,
      reason: reachedGoal
        ? undefined
        : exploratoryPush
          ? "replan after globally planned exploratory crate push"
          : "replan after globally planned crate push"
    };
  }

  /** Briefly throttles only the same unchanged state and target. */
  private failedAttempt(problemKey: string, reason: string): CrateRouteResult {
    this.retryAfterByProblem.set(problemKey, Date.now() + FAILED_ROUTE_COOLDOWN_MS);
    return fail(reason);
  }
}

function routeKey(start: Position, goal: Position, crates: Position[]): string {
  const crateState = crates.map(positionKey).sort().join(";");
  return `${positionKey(start)}>${positionKey(goal)}|${crateState}`;
}

/** Replays a symbolic plan to verify its moves and final position. */
function simulate(world: SnapshotWorld, start: Position, actions: PlanAction[]): Position | null {
  const crates = new Set(world.crateKeys());
  let agent = start;
  for (const action of actions) {
    if (action.kind !== "move" || !action.direction) return null;
    agent = nextPosition(agent, action.direction);
    if (!action.cratePush) continue;
    if (!crates.has(positionKey(action.cratePush.from))) return null;
    crates.delete(positionKey(action.cratePush.from));
    crates.add(positionKey(action.cratePush.to));
  }
  return agent;
}

function toMoves(path: Position[]): PlanAction[] {
  return path.slice(1).flatMap((position, index) => {
    const direction = directionBetween(path[index]!, position);
    return direction ? [{ kind: "move" as const, direction }] : [];
  });
}

/** Keeps the walk to a push station and exactly one irreversible crate action. */
function throughFirstPush(actions: PlanAction[]): PlanAction[] {
  const pushIndex = actions.findIndex((action) => action.cratePush !== undefined);
  return pushIndex < 0 ? [] : actions.slice(0, pushIndex + 1);
}

function fail(reason: string): CrateRouteResult {
  return { actions: [], success: false, partial: false, passages: 0, reason };
}

/** Read-only map and crate state used while routing a snapshot. */
class SnapshotWorld implements PathWorld {
  private readonly tileByPosition = new Map<string, Tile>();
  private readonly forbidden: Set<string>;
  private readonly crates: Set<string>;

  constructor(tiles: Tile[], crates: Array<{ position: Position }>, forbidden: Position[]) {
    for (const tile of tiles) this.tileByPosition.set(positionKey(tile), tile);
    this.forbidden = new Set(forbidden.map(positionKey));
    this.crates = new Set(crates.map((crate) => positionKey(crate.position)));
  }

  hasCrate(position: Position): boolean {
    return this.crates.has(positionKey(position));
  }

  crateKeys(): Set<string> {
    return new Set(this.crates);
  }

  cratePositions(): Position[] {
    return [...this.crates].map((key) => {
      const [x, y] = key.split(",").map(Number);
      return { x: x!, y: y! };
    });
  }

  /** Returns the complete directed component reachable when crates are treated as movable. */
  reachableTiles(start: Position): Tile[] {
    const queue = [start];
    const reached = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = positionKey(current);
      if (reached.has(key)) continue;
      reached.add(key);
      for (const next of adjacentPositions(current)) {
        if (!reached.has(positionKey(next)) && this.canMoveIgnoringCrates(current, next, false)) queue.push(next);
      }
    }
    return [...reached].flatMap((key) => {
      const tile = this.tileByPosition.get(key);
      return tile ? [tile] : [];
    });
  }

  /** Finds sensed boundary crates that can be pushed to reveal more of the map. */
  frontierGoal(start: Position, finalGoal: Position): Position | null {
    const queue: Array<{ position: Position; distance: number }> = [{ position: start, distance: 0 }];
    const distanceByPosition = new Map<string, number>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = positionKey(current.position);
      if (distanceByPosition.has(key)) continue;
      distanceByPosition.set(key, current.distance);
      for (const next of adjacentPositions(current.position)) {
        if (!distanceByPosition.has(positionKey(next)) && this.canMove(current.position, next, false)) {
          queue.push({ position: next, distance: current.distance + 1 });
        }
      }
    }

    const pathfinder = new Pathfinder(this);
    return this.cratePositions()
      .flatMap((crate) => {
        const approaches = adjacentPositions(crate).flatMap((station) => {
          const approachDistance = distanceByPosition.get(positionKey(station));
          if (approachDistance === undefined) return [];
          const destination = { x: crate.x + (crate.x - station.x), y: crate.y + (crate.y - station.y) };
          if (!this.isCrateArea(destination) || this.hasCrate(destination)) return [];
          if (!this.canMoveIgnoringCrates(station, crate, false)) return [];
          if (!this.canMoveIgnoringCrates(crate, destination, false)) return [];
          const remaining = pathfinder.findPathThroughCrates(destination, finalGoal, false)?.length ?? Infinity;
          return [{ approachDistance, remaining }];
        });
        if (approaches.length === 0) return [];
        const best = approaches.sort(
          (a, b) => a.remaining - b.remaining || a.approachDistance - b.approachDistance
        )[0]!;
        return [{ crate, ...best }];
      })
      .sort((a, b) => a.remaining - b.remaining || a.approachDistance - b.approachDistance)
      .map(({ crate }) => crate)[0] ?? null;
  }

  private isCrateArea(position: Position): boolean {
    return CRATE_AREA_TILES.has(this.tileByPosition.get(positionKey(position))?.type ?? "0");
  }

  isWalkable(position: Position, _avoidAgents = true): boolean {
    return this.isPassable(position, false);
  }

  isWalkableIgnoringCrates(position: Position, _avoidAgents = true): boolean {
    return this.isPassable(position, true);
  }

  canMove(from: Position, to: Position, avoidAgents = true): boolean {
    return this.canTraverse(from, to, avoidAgents, false);
  }

  canMoveIgnoringCrates(from: Position, to: Position, avoidAgents = true): boolean {
    return this.canTraverse(from, to, avoidAgents, true);
  }

  private isPassable(position: Position, ignoreCrates: boolean): boolean {
    if (this.forbidden.has(positionKey(position))) return false;
    if (!WALKABLE_TILES.has(this.tileByPosition.get(positionKey(position))?.type ?? "0")) return false;
    return ignoreCrates || !this.hasCrate(position);
  }

  private canTraverse(from: Position, to: Position, _avoidAgents: boolean, ignoreCrates: boolean): boolean {
    if (manhattan(from, to) !== 1) return false;
    if (!this.isPassable(to, ignoreCrates)) return false;
    return allowsEntry({ x: to.x - from.x, y: to.y - from.y }, this.tileByPosition.get(positionKey(to))?.type);
  }
}

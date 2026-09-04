import type { Direction, Position } from "./types.js";
import { adjacentPositions } from "./tiles.js";
import { directionBetween, manhattan, positionKey, samePosition } from "./utils.js";
import type { WorldModel } from "./world-model.js";

/** The movement checks needed by A*. */
export type PathWorld = Pick<
  WorldModel,
  "isWalkable" | "canMove" | "isWalkableIgnoringCrates" | "canMoveIgnoringCrates"
>;

/** A* pathfinding over the map stored in the agent's beliefs. */
export class Pathfinder {
  constructor(private readonly world: PathWorld) {}

  /** Runs A* against current beliefs, producing the tile path used by both agent architectures. */
  findPath(start: Position, goal: Position, avoidAgents = true): Position[] | null {
    return this.search(start, goal, avoidAgents, false);
  }

  /** Finds an optimistic path used only to identify blocking crates. */
  findPathThroughCrates(start: Position, goal: Position, avoidAgents = true): Position[] | null {
    return this.search(start, goal, avoidAgents, true);
  }

  private search(start: Position, goal: Position, avoidAgents: boolean, ignoreCrates: boolean): Position[] | null {
    const walkable = (position: Position) =>
      ignoreCrates ? this.world.isWalkableIgnoringCrates(position, avoidAgents) : this.world.isWalkable(position, avoidAgents);
    const canMove = (from: Position, to: Position) =>
      ignoreCrates ? this.world.canMoveIgnoringCrates(from, to, avoidAgents) : this.world.canMove(from, to, avoidAgents);

    if (samePosition(start, goal)) return [start];
    if (!walkable(goal)) return null;

    const open: Array<{ position: Position; score: number; order: number }> = [];
    let order = 0;
    const distance = new Map([[positionKey(start), 0]]);
    const previous = new Map<string, Position>();
    const settled = new Set<string>();
    open.push({ position: start, score: manhattan(start, goal), order: order++ });

    while (open.length > 0) {
      open.sort((a, b) => a.score - b.score || a.order - b.order);
      const current = open.shift()!.position;
      const currentKey = positionKey(current);
      // A node can be queued more than once with improving costs; only expand it once.
      if (settled.has(currentKey)) continue;
      settled.add(currentKey);
      if (samePosition(current, goal)) return buildPath(previous, current);

      const currentDistance = distance.get(currentKey) ?? 0;
      for (const next of adjacentPositions(current)) {
        if (!canMove(current, next)) continue;
        const newDistance = currentDistance + 1;
        const oldDistance = distance.get(positionKey(next));
        if (oldDistance !== undefined && oldDistance <= newDistance) continue;
        distance.set(positionKey(next), newDistance);
        previous.set(positionKey(next), current);
        open.push({ position: next, score: newDistance + manhattan(next, goal), order: order++ });
      }
    }

    return null;
  }

  /** Converts an A* tile path into the movement commands understood by Deliveroo.js. */
  directions(path: Position[]): Direction[] {
    return path.slice(1).flatMap((position, index) => {
      const direction = directionBetween(path[index]!, position);
      return direction ? [direction] : [];
    });
  }
}

/** Reconstructs the winning A* route by following predecessor links back to the start. */
function buildPath(previous: Map<string, Position>, goal: Position): Position[] {
  const path = [goal];
  while (previous.has(positionKey(path[0]!))) path.unshift(previous.get(positionKey(path[0]!))!);
  return path;
}

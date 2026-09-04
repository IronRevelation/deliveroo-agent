import {
  CRATE_AREA_TILES,
  GRID_STEPS,
  WALKABLE_TILES,
  adjacentPositions,
  allowsEntry
} from "../common/tiles.js";
import type { PlannerRequest, Position, Tile } from "../common/types.js";
import { positionKey } from "../common/utils.js";

export interface GeneratedProblem {
  problem: string;
  positionByTileName: Map<string, Position>;
  /** Restores the real parcel identity after the planner uses compact PDDL object names. */
  parcelIdByObjectName: Map<string, string>;
}

/** Input for a global PDDL problem that may move several interacting crates. */
export interface CrateProblemRequest {
  /** Tiles of the reachable component; must contain `start`, `goal`, and all known crates. */
  tiles: Tile[];
  crates: Position[];
  start: Position;
  goal: Position;
}


/** Translate the current beliefs and intention into a classical PDDL problem. */
export function generateProblem(request: PlannerRequest): GeneratedProblem | null {
  const forbidden = new Set(request.world.forbiddenTiles.map(positionKey));
  const crateTiles = new Set(request.world.crates.map((crate) => positionKey(crate.position)));
  const tiles = new Map(
    request.world.tiles
      // A tile holding a crate is left out entirely: the agent can only reach it by pushing,
      // which is a planning decision, not something the routing graph may assume.
      .filter((tile) => WALKABLE_TILES.has(tile.type) && !forbidden.has(positionKey(tile)) && !crateTiles.has(positionKey(tile)))
      .map((tile) => [positionKey(tile), tile])
  );
  const deliveries = request.deliveryTiles.filter((position) => tiles.has(positionKey(position)));
  const carriedIds = new Set(request.carrying);
  const parcels = [
    ...request.world.parcels.filter((parcel) => carriedIds.has(parcel.id)),
    ...request.candidateParcels.filter(
      (parcel) => !carriedIds.has(parcel.id) && !parcel.carriedBy && tiles.has(positionKey(parcel.position))
    )
  ];
  if (parcels.length === 0 || deliveries.length === 0) return null;

  const positionByTileName = new Map<string, Position>();
  for (const tile of tiles.values()) positionByTileName.set(tileName(tile), tile);

  const init = [`(at-agent ${tileName(request.world.me.position)})`];
  for (const tile of tiles.values()) {
    for (const neighbor of adjacentPositions(tile)) {
      if (canMove(tiles, tile, neighbor)) init.push(`(adjacent ${tileName(tile)} ${tileName(neighbor)})`);
    }
    // No `crate-tile` objects are declared here, so the push operator has no groundings at
    // all and the delivery problem stays as small as it was before crates existed.
    init.push(`(crate-free ${tileName(tile)})`);
  }
  for (const delivery of deliveries) init.push(`(delivery ${tileName(delivery)})`);
  parcels.forEach((parcel, index) => {
    init.push(
      carriedIds.has(parcel.id)
        ? `(carrying p${index})`
        : `(at-parcel p${index} ${tileName(parcel.position)})`
    );
  });

  const tileObjects = [...positionByTileName.keys()].join(" ");
  const parcelObjects = parcels.map((_, index) => `p${index}`).join(" ");
  const parcelIdByObjectName = new Map(parcels.map((parcel, index) => [`p${index}`, parcel.id]));
  const goals = parcels.map((_, index) => `(delivered p${index})`).join(" ");
  const problem = `(define (problem deliveroo-problem)
  (:domain deliveroo)
  (:objects
    ${tileObjects} - tile
    ${parcelObjects} - parcel
  )
  (:init
    ${init.join("\n    ")}
  )
  (:goal (and ${goals}))
)`;

  return { problem, positionByTileName, parcelIdByObjectName };
}

/** Generates a global PDDL problem where crates are anonymous occupied tiles. */
export function generateCrateProblem(request: CrateProblemRequest): GeneratedProblem | null {
  const tiles = new Map(request.tiles.filter((tile) => WALKABLE_TILES.has(tile.type)).map((tile) => [positionKey(tile), tile]));
  if (!tiles.has(positionKey(request.start)) || !tiles.has(positionKey(request.goal))) return null;

  const occupied = new Set<string>();
  for (const crate of request.crates) {
    // A crate can only ever sit on a `5` tile, so anything else is stale sensing and is
    // dropped rather than encoded as an immovable obstacle.
    if (tiles.has(positionKey(crate)) && CRATE_AREA_TILES.has(tiles.get(positionKey(crate))!.type)) {
      occupied.add(positionKey(crate));
    }
  }

  const positionByTileName = new Map<string, Position>();
  for (const tile of tiles.values()) positionByTileName.set(tileName(tile), tile);

  const init = [`(at-agent ${tileName(request.start)})`];
  for (const tile of tiles.values()) {
    for (const neighbor of adjacentPositions(tile)) {
      if (canMove(tiles, tile, neighbor)) init.push(`(adjacent ${tileName(tile)} ${tileName(neighbor)})`);
    }
    init.push(occupied.has(positionKey(tile)) ? `(at-crate ${tileName(tile)})` : `(crate-free ${tileName(tile)})`);
  }
  for (const fact of pushLines(tiles)) init.push(fact);

  const plainTiles: string[] = [];
  const crateTiles: string[] = [];
  for (const tile of tiles.values()) {
    (CRATE_AREA_TILES.has(tile.type) ? crateTiles : plainTiles).push(tileName(tile));
  }
  const objects = [`    ${plainTiles.join(" ")} - tile`];
  if (crateTiles.length > 0) objects.push(`    ${crateTiles.join(" ")} - crate-tile`);

  const problem = `(define (problem deliveroo-crate-passage)
  (:domain deliveroo)
  (:objects
${objects.join("\n")}
  )
  (:init
    ${init.join("\n    ")}
  )
  (:goal (at-agent ${tileName(request.goal)}))
)`;

  return { problem, positionByTileName, parcelIdByObjectName: new Map() };
}

/** Lists collinear tile triples because PDDL adjacency alone cannot express a straight push. */
function pushLines(tiles: Map<string, Tile>): string[] {
  const facts: string[] = [];
  for (const through of tiles.values()) {
    for (const step of GRID_STEPS) {
      const from = { x: through.x - step.x, y: through.y - step.y };
      const to = { x: through.x + step.x, y: through.y + step.y };
      const destination = tiles.get(positionKey(to));
      if (!destination || !CRATE_AREA_TILES.has(destination.type)) continue;
      if (!tiles.has(positionKey(from)) || !canMove(tiles, from, through) || !canMove(tiles, through, to)) continue;
      facts.push(`(push-line ${tileName(from)} ${tileName(through)} ${tileName(to)})`);
    }
  }
  return facts;
}

/** Encodes signed grid coordinates as legal and reversible PDDL object names. */
function tileName({ x, y }: Position): string {
  return `t_${x}_${y}`.replaceAll("-", "m");
}

/** Mirrors the world model's arrow-tile rule when constructing the symbolic adjacency graph. */
function canMove(tiles: Map<string, Tile>, from: Position, to: Position): boolean {
  const destination = tiles.get(positionKey(to));
  if (!destination) return false;
  return allowsEntry({ x: to.x - from.x, y: to.y - from.y }, destination.type);
}

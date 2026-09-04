import type { Position, TileType } from "./types.js";

/** Every tile an agent can stand on. */
export const WALKABLE_TILES = new Set<TileType>(["1", "2", "3", "4", "5", "5!", "←", "↑", "→", "↓"]);

/** Tiles a crate may be pushed onto. */
export const CRATE_AREA_TILES = new Set<TileType>(["5", "5!"]);

/** Movement vector each arrow tile points along; used to reproduce its one-way rule. */
export const ARROW_STEPS: Partial<Record<TileType, Position>> = {
  "←": { x: -1, y: 0 },
  "→": { x: 1, y: 0 },
  "↑": { x: 0, y: 1 },
  "↓": { x: 0, y: -1 }
};

/** The four grid steps, in a stable order so generated plans and regions stay deterministic. */
export const GRID_STEPS: readonly Position[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 }
];

/** Returns the four tiles next to a position. */
export function adjacentPositions({ x, y }: Position): Position[] {
  return GRID_STEPS.map((step) => ({ x: x + step.x, y: y + step.y }));
}

/** Reproduces the one-way constraint of arrow tiles for a single graph edge. */
export function allowsEntry(step: Position, destination: TileType | undefined): boolean {
  if (!destination) return false;
  const arrow = ARROW_STEPS[destination];
  return !arrow || step.x !== -arrow.x || step.y !== -arrow.y;
}

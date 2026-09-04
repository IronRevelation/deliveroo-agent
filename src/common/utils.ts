import type { Direction, Position } from "./types.js";

/** Converts a position to the key used by maps and sets. */
export function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

/** Checks whether two positions refer to the same tile. */
export function samePosition(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Returns the grid distance when movement has no obstacles. */
export function manhattan(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns the move from one adjacent tile to another. */
export function directionBetween(from: Position, to: Position): Direction | null {
  if (to.x === from.x + 1 && to.y === from.y) return "right";
  if (to.x === from.x - 1 && to.y === from.y) return "left";
  if (to.x === from.x && to.y === from.y + 1) return "up";
  if (to.x === from.x && to.y === from.y - 1) return "down";
  return null;
}

/** Applies one move to a position. */
export function nextPosition(from: Position, direction: Direction): Position {
  if (direction === "right") return { x: from.x + 1, y: from.y };
  if (direction === "left") return { x: from.x - 1, y: from.y };
  if (direction === "up") return { x: from.x, y: from.y + 1 };
  return { x: from.x, y: from.y - 1 };
}

/** Converts an untyped value to a finite number, or returns the fallback. */
export function normalizeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Creates a readable, sufficiently unique local identifier. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Parses optional coordinates received from messages or LLM tool arguments. */
export function parsePosition(value: unknown): Position | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const x = Number(item.x);
  const y = Number(item.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

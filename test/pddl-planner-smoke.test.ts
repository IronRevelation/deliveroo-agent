import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/common/config.js";
import { Logger } from "../src/common/logger.js";
import type { PlannerRequest } from "../src/common/types.js";
import { PddlPlanner } from "../src/pddl/planner.js";

describe("PddlPlanner smoke", () => {
  it("solves a tiny local planning problem when pyperplan is installed", async () => {
    const config = loadConfig();
    if (!existsSync(config.pyperplanBin)) return;

    const request: PlannerRequest = {
      world: {
        me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
        tiles: [
          { x: 0, y: 0, type: "3" },
          { x: 1, y: 0, type: "1" },
          { x: 2, y: 0, type: "2" }
        ],
        parcels: [{ id: "p1", position: { x: 1, y: 0 }, reward: 10, lastSeenAt: 0, rewardUpdatedAtMs: 0, confidence: 1 }],
        crates: [],
        forbiddenTiles: []
      },
      candidateParcels: [{ id: "p1", position: { x: 1, y: 0 }, reward: 10, lastSeenAt: 0, rewardUpdatedAtMs: 0, confidence: 1 }],
      deliveryTiles: [{ x: 2, y: 0 }],
      carrying: []
    };

    const result = await new PddlPlanner(config, new Logger(config.logDir, "test-pddl")).plan(request);
    expect(result.success).toBe(true);
    expect(result.actions.map((action) => action.kind)).toContain("pickup");
    expect(result.actions.map((action) => action.kind)).toContain("putdown");
  }, 10_000);
});

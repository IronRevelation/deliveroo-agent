import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/pddl/planner.js";
import { generateCrateProblem, generateProblem } from "../src/pddl/problem-generator.js";
import type { PlannerRequest } from "../src/common/types.js";

describe("PDDL integration", () => {
  it("generates a problem with parcel delivery goals", () => {
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
    expect(generateProblem(request)?.problem).toContain("(delivered p0)");
  });

  it("keeps long route corridors connected instead of cropping by proximity", () => {
    const tiles = Array.from({ length: 160 }, (_, x) => ({ x, y: 0, type: x === 159 ? "2" : "3" }) as const);
    const request: PlannerRequest = {
      world: {
        me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
        tiles,
        parcels: [{ id: "p1", position: { x: 80, y: 0 }, reward: 50, lastSeenAt: 0, rewardUpdatedAtMs: 0, confidence: 1 }],
        crates: [],
        forbiddenTiles: []
      },
      candidateParcels: [{ id: "p1", position: { x: 80, y: 0 }, reward: 50, lastSeenAt: 0, rewardUpdatedAtMs: 0, confidence: 1 }],
      deliveryTiles: [{ x: 159, y: 0 }],
      carrying: []
    };

    const problem = generateProblem(request)?.problem;
    expect(problem).toBeDefined();
    for (let x = 0; x < 159; x += 1) {
      expect(problem).toContain(`(adjacent t_${x}_0 t_${x + 1}_0)`);
    }
  });

  it("can generate a delivery-only problem for parcels already being carried", () => {
    const request: PlannerRequest = {
      world: {
        me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: ["p1"] },
        tiles: [
          { x: 0, y: 0, type: "3" },
          { x: 1, y: 0, type: "3" },
          { x: 2, y: 0, type: "2" }
        ],
        parcels: [{ id: "p1", position: { x: 0, y: 0 }, reward: 10, carriedBy: "a", lastSeenAt: 0, rewardUpdatedAtMs: 0, confidence: 1 }],
        crates: [],
        forbiddenTiles: []
      },
      candidateParcels: [],
      deliveryTiles: [{ x: 2, y: 0 }],
      carrying: ["p1"]
    };

    const problem = generateProblem(request)?.problem;
    expect(problem).toContain("(carrying p0)");
    expect(problem).toContain("(delivered p0)");
    expect(problem).not.toContain("(free-hand)");
  });

  it("generates a global crate problem with several occupied tiles and the final route goal", () => {
    const generated = generateCrateProblem({
      tiles: [
        { x: 0, y: 0, type: "3" },
        { x: 1, y: 0, type: "5!" },
        { x: 2, y: 0, type: "5" },
        { x: 3, y: 0, type: "5!" },
        { x: 4, y: 0, type: "5" },
        { x: 5, y: 0, type: "3" }
      ],
      crates: [
        { x: 1, y: 0 },
        { x: 3, y: 0 }
      ],
      start: { x: 0, y: 0 },
      goal: { x: 5, y: 0 }
    });

    expect(generated?.problem).toContain("(at-crate t_1_0)");
    expect(generated?.problem).toContain("(at-crate t_3_0)");
    expect(generated?.problem).toContain("(:goal (at-agent t_5_0))");
  });

  it("parses pyperplan-style plans into actions", () => {
    const positions = new Map([
      ["t_0_0", { x: 0, y: 0 }],
      ["t_1_0", { x: 1, y: 0 }]
    ]);
    expect(parsePlan("0: (move t_0_0 t_1_0)\n1: (pickup p0 t_1_0)", positions)).toEqual([
      { kind: "move", direction: "right", reason: "pddl" },
      { kind: "pickup", reason: "pddl" }
    ]);
  });

  it("restores real parcel ids on symbolic pickup actions", () => {
    const positions = new Map([["t_1_0", { x: 1, y: 0 }]]);
    const parcelIds = new Map([
      ["p0", "parcel-a"],
      ["p1", "parcel-b"]
    ]);

    expect(parsePlan("(pickup p0 t_1_0)\n(pickup p1 t_1_0)", positions, parcelIds)).toEqual([
      { kind: "pickup", reason: "pddl", parcelIds: ["parcel-a"] },
      { kind: "pickup", reason: "pddl", parcelIds: ["parcel-b"] }
    ]);
  });
});

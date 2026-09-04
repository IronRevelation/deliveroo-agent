import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, PlannerWorldSnapshot } from "../src/common/types.js";
import type { Logger } from "../src/common/logger.js";
import { CrateRouter } from "../src/pddl/crate-router.js";

describe("global crate routing", () => {
  it("plans to the final target with the complete reachable crate state, then returns the first push", async () => {
    const config = {
      pddlEnabled: true,
      pyperplanBin: ".venv/bin/pyperplan"
    } as AgentConfig;
    const router = new CrateRouter(config, { event: vi.fn() } as unknown as Logger);
    const planCratePassage = vi.fn().mockResolvedValue({
      success: true,
      actions: [
        {
          kind: "move",
          direction: "right",
          cratePush: { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
        },
        {
          kind: "move",
          direction: "right",
          cratePush: { from: { x: 2, y: 0 }, to: { x: 3, y: 0 } }
        },
        {
          kind: "move",
          direction: "right",
          cratePush: { from: { x: 3, y: 0 }, to: { x: 4, y: 0 } }
        }
      ]
    });
    Object.assign(router, { planner: { planCratePassage } });
    const snapshot: PlannerWorldSnapshot = {
      me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
      tiles: [0, 1, 2, 3, 4].map((x) => ({ x, y: 0, type: "5" as const })),
      parcels: [],
      crates: [{ id: "crate", position: { x: 1, y: 0 }, lastSeenAt: 0 }],
      forbiddenTiles: []
    };

    const result = await router.route(snapshot, { x: 3, y: 0 });

    expect(planCratePassage).toHaveBeenCalledOnce();
    expect(planCratePassage).toHaveBeenCalledWith({
      tiles: snapshot.tiles,
      crates: [{ x: 1, y: 0 }],
      start: { x: 0, y: 0 },
      goal: { x: 3, y: 0 }
    });
    expect(result).toMatchObject({
      success: false,
      partial: true,
      reason: "replan after globally planned crate push"
    });
    expect(result.actions).toEqual([
      {
        kind: "move",
        direction: "right",
        cratePush: { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
      }
    ]);
  });

  it("cools down after an unsolvable crate layout", async () => {
    const config = {
      pddlEnabled: true,
      pyperplanBin: ".venv/bin/pyperplan"
    } as AgentConfig;
    const router = new CrateRouter(config, { event: vi.fn() } as unknown as Logger);
    const snapshot: PlannerWorldSnapshot = {
      me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
      tiles: [
        { x: 0, y: 0, type: "3" },
        { x: 1, y: 0, type: "5!" },
        { x: 2, y: 0, type: "3" }
      ],
      parcels: [],
      crates: [{ id: "crate", position: { x: 1, y: 0 }, lastSeenAt: 0 }],
      forbiddenTiles: []
    };

    const first = await router.route(snapshot, { x: 2, y: 0 });
    const second = await router.route(snapshot, { x: 2, y: 0 });

    expect(first.reason).toBe("global crate planner found no route");
    expect(second.reason).toBe("crate planner cooling down after an unsuccessful route");
  });

  it("does not let one failed goal prevent planning for a different goal", async () => {
    const config = {
      pddlEnabled: true,
      pyperplanBin: ".venv/bin/pyperplan"
    } as AgentConfig;
    const router = new CrateRouter(config, { event: vi.fn() } as unknown as Logger);
    const planCratePassage = vi.fn().mockResolvedValue({ success: false, actions: [] });
    Object.assign(router, { planner: { planCratePassage } });
    const snapshot: PlannerWorldSnapshot = {
      me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
      tiles: [
        { x: 0, y: 0, type: "3" },
        { x: 1, y: 0, type: "5!" },
        { x: 2, y: 0, type: "3" },
        { x: 3, y: 0, type: "3" }
      ],
      parcels: [],
      crates: [{ id: "crate", position: { x: 1, y: 0 }, lastSeenAt: 0 }],
      forbiddenTiles: []
    };

    await router.route(snapshot, { x: 2, y: 0 });
    await router.route(snapshot, { x: 3, y: 0 });

    expect(planCratePassage).toHaveBeenCalledTimes(2);
    expect(planCratePassage).toHaveBeenNthCalledWith(2, expect.objectContaining({ goal: { x: 3, y: 0 } }));
  });

  it("uses a pushable boundary crate to continue sensing when the distant goal is not yet solvable", async () => {
    const config = {
      pddlEnabled: true,
      pyperplanBin: ".venv/bin/pyperplan"
    } as AgentConfig;
    const router = new CrateRouter(config, { event: vi.fn() } as unknown as Logger);
    const planCratePassage = vi
      .fn()
      .mockResolvedValueOnce({ success: false, actions: [] })
      .mockResolvedValueOnce({
        success: true,
        actions: [
          { kind: "move", direction: "right" },
          {
            kind: "move",
            direction: "up",
            cratePush: { from: { x: 1, y: 1 }, to: { x: 1, y: 2 } }
          }
        ]
      });
    Object.assign(router, { planner: { planCratePassage } });
    const snapshot: PlannerWorldSnapshot = {
      me: { id: "a", name: "a", position: { x: 0, y: 0 }, score: 0, carriedParcels: [] },
      tiles: [
        { x: 0, y: 0, type: "5" },
        { x: 1, y: 0, type: "5" },
        { x: 1, y: 1, type: "5!" },
        { x: 1, y: 2, type: "5" },
        { x: 2, y: 1, type: "5" },
        { x: 3, y: 1, type: "5" }
      ],
      parcels: [],
      crates: [{ id: "crate", position: { x: 1, y: 1 }, lastSeenAt: 0 }],
      forbiddenTiles: []
    };

    const result = await router.route(snapshot, { x: 3, y: 1 });

    expect(planCratePassage).toHaveBeenNthCalledWith(2, expect.objectContaining({ goal: { x: 1, y: 1 } }));
    expect(result).toMatchObject({
      success: false,
      partial: true,
      reason: "replan after globally planned exploratory crate push"
    });
    expect(result.actions.at(-1)?.cratePush).toEqual({ from: { x: 1, y: 1 }, to: { x: 1, y: 2 } });
  });
});

import { describe, expect, it, vi } from "vitest";
import { BdiAgent } from "../src/bdi/agentA.js";
import { CoordinationSession } from "../src/common/coordination.js";
import type { Intention } from "../src/common/types.js";
import { WorldModel } from "../src/common/world-model.js";

describe("Agent A coordination", () => {
  it("does not execute a BDI action while waiting on an odd row", async () => {
    const world = new WorldModel();
    world.observeMap(3, 2, [
      { x: 0, y: 1, type: "3" },
      { x: 1, y: 1, type: "3" },
      { x: 2, y: 1, type: "3" }
    ]);
    world.observeSelf({ id: "agent-a", name: "agent A", x: 1, y: 1, score: 0 });
    const coordination = new CoordinationSession();
    coordination.start("mission-red-light", "odd_row_wait", { x: 1, y: 1 });
    coordination.ready({ x: 1, y: 1 });
    const execute = vi.fn();
    const agent = Object.create(BdiAgent.prototype) as any;
    agent.world = world;
    agent.coordination = coordination;
    agent.execute = execute;

    await agent.followTeamMission();

    expect(execute).not.toHaveBeenCalled();
    expect(agent.coordination.mission?.phase).toBe("waiting");
  });
});

describe("Agent A plan execution", () => {
  it("picks up when the parcel is already under the agent", async () => {
    const world = new WorldModel();
    world.observeMap(1, 1, [{ x: 0, y: 0, type: "1" }]);
    world.observeSelf({ id: "agent-a", name: "agent A", x: 0, y: 0, score: 0 });
    const agent = planningAgent(world);
    const intention: Intention = {
      id: "pickup-here",
      kind: "pickup",
      target: { x: 0, y: 0 },
      parcelId: "p1",
      priority: 1,
      createdAt: 1,
      reason: "parcel spawned under agent"
    };

    await expect(agent.selectPlan(intention)).resolves.toEqual([{ kind: "pickup", parcelIds: ["p1"] }]);
  });

  it("puts down when already standing on a delivery tile", async () => {
    const world = new WorldModel();
    world.observeMap(1, 1, [{ x: 0, y: 0, type: "2" }]);
    world.observeSelf({ id: "agent-a", name: "agent A", x: 0, y: 0, score: 0 });
    const agent = planningAgent(world);
    const intention: Intention = {
      id: "deliver-here",
      kind: "deliver",
      target: { x: 0, y: 0 },
      priority: 1,
      createdAt: 1,
      reason: "already on delivery"
    };

    await expect(agent.selectPlan(intention)).resolves.toEqual([{ kind: "putdown" }]);
  });

  it("discards the remaining symbolic route after a successful crate push", async () => {
    const world = new WorldModel();
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "5" },
      { x: 1, y: 0, type: "5!" },
      { x: 2, y: 0, type: "5" }
    ]);
    world.observeSelf({ id: "agent-a", name: "agent A", x: 0, y: 0, score: 0 });
    world.observeCrates([{ id: "crate", x: 1, y: 0 }]);
    const agent = Object.create(BdiAgent.prototype) as any;
    agent.world = world;
    agent.client = { move: vi.fn(async () => ({ ok: true, position: { x: 1, y: 0 } })) };
    agent.logger = { event: vi.fn() };
    agent.plan = [{ kind: "move", direction: "left" }];
    agent.yieldStreak = 0;

    await agent.execute({
      kind: "move",
      direction: "right",
      cratePush: { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
    });

    expect(agent.plan).toEqual([]);
    expect(world.crateAt({ x: 2, y: 0 })?.id).toBe("crate");
  });
});

function planningAgent(world: WorldModel): any {
  const agent = Object.create(BdiAgent.prototype) as any;
  agent.world = world;
  agent.logger = { event: vi.fn() };
  agent.routeTo = vi.fn(async () => []);
  return agent;
}

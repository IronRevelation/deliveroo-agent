import { describe, expect, it, vi } from "vitest";
import type { CommunicationAdapter } from "../src/common/communication.js";
import type { DeliverooClientAdapter } from "../src/common/deliveroo-client-adapter.js";
import type { Logger } from "../src/common/logger.js";
import type { PlanAction, Position } from "../src/common/types.js";
import { WorldModel } from "../src/common/world-model.js";
import { AgentTools } from "../src/llm/tools.js";

describe("Agent B tools", () => {
  it("enforces exact stack size before delivery", async () => {
    const world = deliveryWorld(1);
    const putdown = vi.fn(async () => ({ ids: ["p1"], count: 1 }));
    const tools = agentTools(world, { putdown });

    const result = await tools.execute("deliver_here", {});

    expect(result).toMatchObject({ ok: false, dropped: [], reason: "delivery requires exactly 3 parcels; carrying 1" });
    expect(putdown).not.toHaveBeenCalled();
  });

  it("delivers when the exact stack is complete", async () => {
    const world = deliveryWorld(3);
    const putdown = vi.fn(async () => ({ ids: ["p1", "p2", "p3"], count: 3 }));
    const tools = agentTools(world, { putdown });

    const result = await tools.execute("deliver_here", {});

    expect(result).toMatchObject({ ok: true, dropped: ["p1", "p2", "p3"] });
    expect(putdown).toHaveBeenCalledOnce();
  });

  it("does not pick up beyond the required stack", async () => {
    const world = deliveryWorld(3);
    const pickup = vi.fn(async () => ({ ids: ["extra"], count: 1 }));
    const tools = agentTools(world, { pickup });

    const result = await tools.execute("pickup_here", {});

    expect(result).toMatchObject({ ok: false, picked: [], reason: "stack already contains 3 parcels" });
    expect(pickup).not.toHaveBeenCalled();
  });

  it("does not pick up a parcel pile that would overshoot the required stack", async () => {
    const world = deliveryWorld(2);
    world.observeParcels([
      { id: "extra-1", x: 0, y: 0, reward: 10, carriedBy: null },
      { id: "extra-2", x: 0, y: 0, reward: 10, carriedBy: null }
    ]);
    const pickup = vi.fn(async () => ({ ids: ["extra-1", "extra-2"], count: 2 }));
    const tools = agentTools(world, { pickup });

    const result = await tools.execute("pickup_here", {});

    expect(result).toMatchObject({
      ok: false,
      picked: [],
      reason: "pickup would exceed required stack of 3 parcels"
    });
    expect(pickup).not.toHaveBeenCalled();
  });

  it("uses the injected crate router and revises crate beliefs after a push", async () => {
    const world = new WorldModel();
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "5" },
      { x: 1, y: 0, type: "5!" },
      { x: 2, y: 0, type: "5" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeCrates([{ id: "crate", x: 1, y: 0 }]);
    const move = vi.fn(async () => ({ ok: true, position: { x: 1, y: 0 } }));
    const route = vi.fn(async () => [
      {
        kind: "move" as const,
        direction: "right" as const,
        cratePush: { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
      }
    ]);
    const tools = agentTools(world, { move }, route);

    const result = await tools.execute("move_to", { x: 1, y: 0 });

    expect(result).toEqual({ ok: true, steps: 1, target: { x: 1, y: 0 } });
    expect(route).toHaveBeenCalledWith({ x: 1, y: 0 });
    expect(move).toHaveBeenCalledWith("right");
    expect(world.crateAt({ x: 2, y: 0 })?.id).toBe("crate");
  });

  it("requests a fresh crate route after every push", async () => {
    const world = new WorldModel();
    world.observeMap(4, 1, Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: "5" })));
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeCrates([{ id: "crate", x: 1, y: 0 }]);
    const move = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, position: { x: 1, y: 0 } })
      .mockResolvedValueOnce({ ok: true, position: { x: 2, y: 0 } });
    const route = vi
      .fn()
      .mockResolvedValueOnce([
        {
          kind: "move" as const,
          direction: "right" as const,
          cratePush: { from: { x: 1, y: 0 }, to: { x: 2, y: 0 } }
        }
      ])
      .mockResolvedValueOnce([
        {
          kind: "move" as const,
          direction: "right" as const,
          cratePush: { from: { x: 2, y: 0 }, to: { x: 3, y: 0 } }
        }
      ]);
    const tools = agentTools(world, { move }, route);

    const result = await tools.execute("move_to", { x: 2, y: 0 });

    expect(result).toEqual({ ok: true, steps: 2, target: { x: 2, y: 0 } });
    expect(route).toHaveBeenCalledTimes(2);
    expect(world.crateAt({ x: 3, y: 0 })?.id).toBe("crate");
  });
});

function deliveryWorld(carried: number): WorldModel {
  const world = new WorldModel();
  world.observeMap(1, 1, [{ x: 0, y: 0, type: "2" }]);
  world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
  world.observeParcels(
    Array.from({ length: carried }, (_, index) => ({
      id: `p${index + 1}`,
      x: 0,
      y: 0,
      reward: 10,
      carriedBy: "me"
    }))
  );
  world.setRequiredStackSize(3);
  return world;
}

function agentTools(
  world: WorldModel,
  actions: Record<string, unknown>,
  route: (target: Position) => Promise<PlanAction[] | null> = async () => null
): AgentTools {
  const client = {
    move: vi.fn(),
    pickup: vi.fn(async () => ({ ids: [], count: 0 })),
    putdown: vi.fn(async () => ({ ids: [], count: 0 })),
    ...actions
  } as unknown as DeliverooClientAdapter;
  const communication = { send: vi.fn() } as unknown as CommunicationAdapter;
  const logger = { event: vi.fn() } as unknown as Logger;
  return new AgentTools(world, client, communication, logger, route);
}

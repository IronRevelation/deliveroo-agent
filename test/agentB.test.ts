import { describe, expect, it, vi } from "vitest";
import type { CommunicationAdapter } from "../src/common/communication.js";
import { CoordinationSession } from "../src/common/coordination.js";
import type { DeliverooClientAdapter } from "../src/common/deliveroo-client-adapter.js";
import type { Logger } from "../src/common/logger.js";
import { WorldModel } from "../src/common/world-model.js";
import { LlmAgent } from "../src/llm/agentB.js";
import { AgentTools } from "../src/llm/tools.js";

describe("Agent B mission bounds", () => {
  it("rejects an explicitly negative mission before executing a tool", async () => {
    const { agent, complete, executeTool, say, event } = missionAgent({ ok: true });

    await agent.runMission({ from: "mission-agent", text: "Move to (1,1), but doing so costs 25 points" });

    expect(complete).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(
      "mission-agent",
      "Ignored because the requested action has an explicit negative reward."
    );
    expect(event).toHaveBeenCalledWith("llm_mission_ignored", expect.anything());
  });

  it("finishes a persistent mission after installing its strategy rule", async () => {
    const { agent, complete, executeTool, say } = missionAgent({ ok: true });
    complete.mockResolvedValue(
      JSON.stringify({
        type: "tool_call",
        tool: "set_strategy_rule",
        args: { rule: "required_stack_size", value: 3 }
      })
    );

    await agent.runMission({ from: "mission-agent", text: "Deliver stacks of exactly 3 parcels" });

    expect(complete).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith({
      tool: "set_strategy_rule",
      args: { rule: "required_stack_size", value: 3 }
    });
    expect(say).toHaveBeenCalledWith("mission-agent", "Strategy rule installed successfully.");
  });

  it("does not reject safe tools based on a hard-coded mission category", async () => {
    const { agent, complete, executeTool, say, event } = missionAgent({ ok: true });
    complete
      .mockResolvedValueOnce(JSON.stringify({ type: "tool_call", tool: "plan_delivery", args: { parcelCount: 3 } }))
      .mockResolvedValueOnce(
        JSON.stringify({
          type: "tool_call",
          tool: "set_strategy_rule",
          args: { rule: "required_stack_size", value: 3 }
        })
      );

    await agent.runMission({ from: "mission-agent", text: "Deliver stacks of exactly 3 parcels" });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenNthCalledWith(1, {
      tool: "plan_delivery",
      args: { parcelCount: 3 }
    });
    expect(executeTool).toHaveBeenCalledWith({
      tool: "set_strategy_rule",
      args: { rule: "required_stack_size", value: 3 }
    });
    expect(event).not.toHaveBeenCalledWith("llm_mission_rejected", expect.anything());
    expect(say).toHaveBeenCalledWith("mission-agent", "Strategy rule installed successfully.");
  });

  it("stops after the same tool call fails twice", async () => {
    const { agent, complete, executeTool, say, event } = missionAgent({ ok: false });
    complete.mockResolvedValue(
      JSON.stringify({ type: "tool_call", tool: "pickup_here", args: {} })
    );

    await agent.runMission({ from: "mission-agent", text: "Pick up the parcel" });

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(say).toHaveBeenCalledWith("mission-agent", "Mission failed: pickup_here failed twice");
    expect(event).toHaveBeenCalledWith("llm_mission_failed", {
      mission: "Pick up the parcel",
      error: "pickup_here failed twice"
    });
  });

  it("stops after eight successful tool calls without a final answer", async () => {
    const { agent, complete, executeTool, say } = missionAgent({ ok: true });
    complete.mockResolvedValue(
      JSON.stringify({ type: "tool_call", tool: "get_my_position", args: {} })
    );

    await agent.runMission({ from: "mission-agent", text: "Keep checking forever" });

    expect(executeTool).toHaveBeenCalledTimes(8);
    expect(say).toHaveBeenCalledWith("mission-agent", "Mission failed: execution step limit reached");
  });

  it("starts coordination from Agent A's reported position when it is not visible", async () => {
    const world = new WorldModel();
    world.observeMap(5, 1, Array.from({ length: 5 }, (_, x) => ({ x, y: 0, type: "3" })));
    world.observeSelf({ id: "agent-b", name: "agent B", x: 0, y: 0, score: 0 });
    const send = vi.fn(async () => undefined);
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.world = world;
    agent.coordination = new CoordinationSession();
    agent.communication = { send, drain: vi.fn(() => []) };
    agent.client = { say: vi.fn(async () => undefined) };
    agent.logger = { event: vi.fn() };
    agent.recentObservations = [];
    agent.teammateStatus = null;
    agent.pendingCoordination = null;

    const args = { kind: "meet_near", x: 2, y: 0, maxDistance: 2, requester: "mission-agent" };
    const waiting = await agent.startCoordination(args);

    expect(waiting).toMatchObject({ ok: true, status: "pending", reason: "waiting for teammate status" });
    expect(send).toHaveBeenCalledWith({ type: "eta", to: "agent-a", payload: { request: "status" } });

    agent.communication.drain.mockReturnValueOnce([
      {
        from: "agent-a",
        type: "eta",
        payload: { position: { x: 4, y: 0 }, intention: "explore" },
        timestamp: Date.now()
      }
    ]);
    agent.handleTeamMessages();
    await agent.advancePendingCoordination();

    expect(agent.pendingCoordination).toBeNull();
    expect(agent.coordination.mission?.kind).toBe("meet_near");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "mission_request" }));
  });

  it("lets the LLM select coordination without recognizing an example sentence", async () => {
    const { agent, complete, executeTool, say, event } = missionAgent({ ok: true, status: "pending" });
    const prompt = "Synchronize the whole team on alternating horizontal lanes, then hold position.";
    complete.mockResolvedValue(
      JSON.stringify({ type: "tool_call", tool: "coordinate", args: { kind: "odd_row_wait" } })
    );

    await agent.runMission({ from: "mission-agent", text: prompt });

    expect(complete).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith({
      tool: "coordinate",
      args: { kind: "odd_row_wait", requester: "mission-agent" }
    });
    expect(say).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalledWith("llm_mission_rejected", expect.anything());
  });

  it("does not execute tools while waiting on an odd row", async () => {
    const world = new WorldModel();
    world.observeMap(3, 2, [
      { x: 0, y: 1, type: "3" },
      { x: 1, y: 1, type: "3" },
      { x: 2, y: 1, type: "3" }
    ]);
    world.observeSelf({ id: "agent-b", name: "agent B", x: 1, y: 1, score: 0 });
    const coordination = new CoordinationSession();
    coordination.start("mission-red-light", "odd_row_wait", { x: 1, y: 1 });
    coordination.ready({ x: 1, y: 1 });
    coordination.mission!.teammateReady = true;
    const execute = vi.fn();
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.world = world;
    agent.coordination = coordination;
    agent.tools = { execute };
    agent.communication = { send: vi.fn() };
    agent.logger = { event: vi.fn() };

    await agent.advanceCoordination();

    expect(execute).not.toHaveBeenCalled();
    expect(agent.coordination.mission?.phase).toBe("waiting");
  });
});

describe("Agent B persistent stack strategy", () => {
  it("moves a complete stack directly toward delivery without consulting the LLM", async () => {
    const world = stackWorld(3, { x: 0, y: 0 });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const complete = vi.fn();
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.world = world;
    agent.config = { agentTickMs: 350 };
    agent.executeTool = executeTool;
    agent.llm = { complete };
    agent.logger = { event: vi.fn() };

    await agent.runCourierStep();

    expect(executeTool).toHaveBeenCalledWith({ tool: "move_to", args: { x: 2, y: 0 } });
    expect(complete).not.toHaveBeenCalled();
  });

  it("delivers a complete stack immediately when already on a delivery tile", async () => {
    const world = stackWorld(3, { x: 2, y: 0 });
    const executeTool = vi.fn(async () => ({ ok: true }));
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.world = world;
    agent.config = { agentTickMs: 350 };
    agent.executeTool = executeTool;
    agent.logger = { event: vi.fn() };

    await agent.runRequiredStackStep();

    expect(executeTool).toHaveBeenCalledWith({ tool: "deliver_here", args: {} });
  });

  it("collects a safe partial stack before asking the LLM for another action", async () => {
    const world = stackWorld(1, { x: 0, y: 0 });
    world.observeParcels([{ id: "waiting", x: 0, y: 0, reward: 20, carriedBy: null }]);
    const executeTool = vi.fn(async () => ({ ok: true }));
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.world = world;
    agent.config = { agentTickMs: 350 };
    agent.executeTool = executeTool;
    agent.logger = { event: vi.fn() };

    await agent.runRequiredStackStep();

    expect(executeTool).toHaveBeenCalledWith({ tool: "pickup_here", args: {} });
  });
});

describe("Agent B PDDL delivery bridge", () => {
  it("executes one concrete pickup for two co-located symbolic parcels", async () => {
    const world = new WorldModel();
    world.observeMap(1, 1, [{ x: 0, y: 0, type: "2" }]);
    world.observeSelf({ id: "agent-b", name: "agent B", x: 0, y: 0, score: 0 });
    world.observeParcels([
      { id: "parcel-a", x: 0, y: 0, reward: 20, carriedBy: null },
      { id: "parcel-b", x: 0, y: 0, reward: 10, carriedBy: null }
    ]);
    const pickup = vi.fn(async () => ({ ids: ["parcel-a", "parcel-b"], count: 2 }));
    const putdown = vi.fn(async () => ({ ids: ["parcel-a", "parcel-b"], count: 2 }));
    const client = { pickup, putdown } as unknown as DeliverooClientAdapter;
    const tools = new AgentTools(
      world,
      client,
      { send: vi.fn() } as unknown as CommunicationAdapter,
      { event: vi.fn() } as unknown as Logger,
      async () => null
    );
    const plan = vi.fn(async () => ({
      success: true,
      actions: [
        { kind: "pickup" as const, parcelIds: ["parcel-a"] },
        { kind: "pickup" as const, parcelIds: ["parcel-b"] },
        { kind: "putdown" as const },
        { kind: "putdown" as const }
      ]
    }));
    const agent = Object.create(LlmAgent.prototype) as any;
    agent.config = { pddlEnabled: true };
    agent.world = world;
    agent.planner = { plan };
    agent.tools = tools;

    const result = await agent.planDelivery({ parcelCount: 2 });

    expect(result).toEqual({ ok: true, planner: "PDDL", actions: 4 });
    expect(pickup).toHaveBeenCalledOnce();
    expect(putdown).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({
      candidateParcels: expect.arrayContaining([
        expect.objectContaining({ id: "parcel-a" }),
        expect.objectContaining({ id: "parcel-b" })
      ])
    }));
  });
});

function stackWorld(carried: number, position: { x: number; y: number }): WorldModel {
  const world = new WorldModel();
  world.observeMap(3, 1, [
    { x: 0, y: 0, type: "3" },
    { x: 1, y: 0, type: "3" },
    { x: 2, y: 0, type: "2" }
  ]);
  world.observeSelf({ id: "agent-b", name: "agent B", ...position, score: 0 });
  world.observeParcels(
    Array.from({ length: carried }, (_, index) => ({
      id: `carried-${index}`,
      ...position,
      reward: 30,
      carriedBy: "agent-b"
    }))
  );
  world.setRequiredStackSize(3);
  return world;
}

function missionAgent(toolResult: unknown): {
  agent: any;
  complete: ReturnType<typeof vi.fn>;
  executeTool: ReturnType<typeof vi.fn>;
  say: ReturnType<typeof vi.fn>;
  event: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn();
  const executeTool = vi.fn(async () => toolResult);
  const say = vi.fn(async () => undefined);
  const event = vi.fn();
  const agent = Object.create(LlmAgent.prototype) as any;
  agent.llm = { complete };
  agent.executeTool = executeTool;
  agent.client = { say };
  agent.logger = { event };
  agent.context = () => ({});
  return { agent, complete, executeTool, say, event };
}

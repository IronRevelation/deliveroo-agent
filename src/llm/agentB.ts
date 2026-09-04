import { z } from "zod";
import { loadConfig } from "../common/config.js";
import { CommunicationAdapter } from "../common/communication.js";
import {
  CoordinationSession,
  handoffTargets,
  meetingTargets,
  oddRowTargets,
  parseCoordinationKind
} from "../common/coordination.js";
import { DeliverooClientAdapter } from "../common/deliveroo-client-adapter.js";
import { Logger } from "../common/logger.js";
import { Pathfinder } from "../common/pathfinder.js";
import type { AgentConfig, PlanAction, Position } from "../common/types.js";
import { parsePosition, positionKey, samePosition, sleep, uniqueId } from "../common/utils.js";
import { WorldModel } from "../common/world-model.js";
import { CrateRouter } from "../pddl/crate-router.js";
import { PddlPlanner } from "../pddl/planner.js";
import { LiteLlmClient, type ChatMessage } from "./litellm-client.js";
import { hasExplicitNegativeUtility, type ToolCall } from "./missions.js";
import {
  buildCourierPrompt,
  buildMissionPrompt,
  COURIER_TOOL_NAMES,
  LLM_COURIER_SYSTEM_PROMPT,
  LLM_SYSTEM_PROMPT,
  MISSION_TOOL_NAMES
} from "./prompts.js";
import { AgentTools } from "./tools.js";

const COURIER_TOOLS = new Set<string>(COURIER_TOOL_NAMES);
const MISSION_TOOLS = new Set<string>(MISSION_TOOL_NAMES);
const MAX_MISSION_STEPS = 8;
const MISSION_TIMEOUT_MS = 45_000;
const MAX_IDENTICAL_TOOL_FAILURES = 2;
const TEAMMATE_STATUS_MAX_AGE_MS = 10_000;
const COORDINATION_STATUS_TIMEOUT_MS = 10_000;

const DecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool_call"), tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }),
  z.object({
    type: z.literal("final_answer"),
    answer: z.union([z.string(), z.number()]).transform(String)
  }),
  z.object({ type: z.literal("ignore"), reason: z.string() })
]);
type Decision = z.infer<typeof DecisionSchema>;
type Mission = { from?: string; text: string };

/** Agent B uses the LLM as controller and deterministic functions as tools. */
export class LlmAgent {
  private readonly world = new WorldModel();
  private readonly logger: Logger;
  private readonly client: DeliverooClientAdapter;
  private readonly communication: CommunicationAdapter;
  private readonly llm: LiteLlmClient;
  private readonly tools: AgentTools;
  private readonly planner: PddlPlanner;
  private readonly crateRouter: CrateRouter;
  private readonly pathfinder: Pathfinder;
  private readonly coordination = new CoordinationSession();
  private readonly missions: Mission[] = [];
  private teammateStatus: { position: Position; receivedAt: number } | null = null;
  private pendingCoordination: { args: Record<string, unknown>; requestedAt: number } | null = null;
  private recentObservations: unknown[] = [];
  private running = false;

  /** Wires the LLM, tools, PDDL bridge, communication, and shared belief state. */
  constructor(private readonly config: AgentConfig) {
    this.logger = new Logger(config.logDir, "agent-b-llm");
    this.client = new DeliverooClientAdapter(config.deliverooUrl, config.tokenAgentB, this.logger);
    this.communication = new CommunicationAdapter(this.client, this.logger, "agent-b");
    this.llm = new LiteLlmClient(config);
    this.tools = new AgentTools(this.world, this.client, this.communication, this.logger, (target) =>
      this.routeTo(target)
    );
    this.planner = new PddlPlanner(config, this.logger);
    this.crateRouter = new CrateRouter(config, this.logger);
    this.pathfinder = new Pathfinder(this.world);
  }

  /** Connects sensing, then alternates mission handling with ordinary courier decisions. */
  async start(): Promise<void> {
    if (!this.config.liteLlmApiKey) {
      throw new Error("LITELLM_API_KEY is required for Agent B");
    }
    this.bindSensing();
    this.client.connect();
    this.running = true;
    this.logger.event("agent_started", { architecture: "LLM + tools + PDDL" });
    while (this.running) {
      try {
        await this.cycle();
      } catch (error) {
        this.logger.event("cycle_failed", { error: String(error) });
        this.stop();
        throw error;
      }
      await sleep(this.config.agentTickMs);
    }
  }

  stop(): void {
    this.running = false;
    this.client.disconnect();
  }

  /** Feeds game events into beliefs and separates direct missions from team-protocol traffic. */
  private bindSensing(): void {
    this.client.onSelf((self) => {
      this.world.observeSelf(self);
      this.logger.event("belief_self", { self: this.world.me });
    });
    this.client.onMap(({ width, height, tiles }) => this.world.observeMap(width, height, tiles));
    this.client.onConfig((config) => this.world.observeConfig(config));
    this.client.onParcels((parcels) => this.world.observeParcels(parcels));
    this.client.onAgents((agents) => this.world.observeAgents(agents));
    this.client.onCrates((crates) => this.world.observeCrates(crates));
    this.client.onMessage(({ from, message }) => {
      if (!message.startsWith("TEAMMSG ")) this.missions.push({ from, text: message });
    });
  }

  /** Revises beliefs and gives queued missions priority over the autonomous courier policy. */
  private async cycle(): Promise<void> {
    this.world.advanceTick();
    this.handleTeamMessages();
    if (!this.world.me || !this.client.isConnected) return;

    const signal = this.missions[0];
    if (
      this.coordination.mission?.kind === "odd_row_wait" &&
      this.coordination.mission.localReady &&
      this.coordination.mission.teammateReady &&
      signal &&
      isGreenLight(signal.text)
    ) {
      this.missions.shift();
      await this.finishCoordination(signal.from);
      return;
    }
    if (this.coordination.mission) {
      await this.advanceCoordination();
      return;
    }
    if (this.pendingCoordination) {
      await this.advancePendingCoordination();
      return;
    }

    const mission = this.missions.shift();
    if (mission) await this.runMission(mission);
    else await this.runCourierStep();
  }

  /** Uses the ReAct loop from the lectures: decide, act through a tool, then observe. */
  private async runMission(mission: Mission): Promise<void> {
    if (hasExplicitNegativeUtility(mission.text)) {
      const reason = "Ignored because the requested action has an explicit negative reward.";
      this.logger.event("llm_mission_ignored", { mission: mission.text, reason });
      if (mission.from) await this.client.say(mission.from, reason);
      return;
    }
    const availableTools = MISSION_TOOLS;
    const messages: ChatMessage[] = [
      { role: "system", content: LLM_SYSTEM_PROMPT },
      { role: "user", content: buildMissionPrompt(mission.text, this.context(), [...availableTools]) }
    ];
    const startedAt = Date.now();
    const failedCalls = new Map<string, number>();

    try {
      for (let step = 0; step < MAX_MISSION_STEPS; step += 1) {
        if (Date.now() - startedAt >= MISSION_TIMEOUT_MS) {
          await this.failMission(mission, "execution timed out");
          return;
        }

        const raw = await this.llm.complete(messages);
        const decision = parseDecision(raw);
        this.logger.event("llm_decision", { mission: mission.text, step, decision });
        messages.push({ role: "assistant", content: raw });

        if (decision.type === "tool_call") {
          const args = decision.tool === "coordinate" ? { ...decision.args, requester: mission.from } : decision.args;
          const observation = availableTools.has(decision.tool)
            ? await this.executeTool({ tool: decision.tool, args })
            : { ok: false, reason: "tool is not available to the mission controller" };
          if (!availableTools.has(decision.tool)) {
            this.logger.event("llm_mission_rejected", { mission: mission.text, tool: decision.tool });
          }
          messages.push({ role: "user", content: `Observation: ${JSON.stringify(observation)}` });
          if (decision.tool === "coordinate" && object(observation).status === "pending") return;
          if (decision.tool === "set_strategy_rule" && object(observation).ok === true) {
            if (mission.from) await this.client.say(mission.from, "Strategy rule installed successfully.");
            return;
          }
          if (object(observation).ok === false) {
            const signature = JSON.stringify([decision.tool, decision.args]);
            const failures = (failedCalls.get(signature) ?? 0) + 1;
            failedCalls.set(signature, failures);
            if (failures >= MAX_IDENTICAL_TOOL_FAILURES) {
              await this.failMission(mission, `${decision.tool} failed twice`);
              return;
            }
          }
          continue;
        }

        const answer = decision.type === "final_answer" ? decision.answer : decision.reason;
        if (mission.from) await this.client.say(mission.from, answer);
        return;
      }
      await this.failMission(mission, "execution step limit reached");
    } catch (error) {
      this.logger.event("llm_mission_failed", { mission: mission.text, error: String(error) });
      throw error;
    }
  }

  /** Reports a bounded mission failure so the next queued request can still run. */
  private async failMission(mission: Mission, reason: string): Promise<void> {
    this.logger.event("llm_mission_failed", { mission: mission.text, error: reason });
    if (mission.from) await this.client.say(mission.from, `Mission failed: ${reason}`);
  }

  /** Lets the LLM select one routine tool action. */
  private async runCourierStep(): Promise<void> {
    // The LLM chooses persistent strategies, but an installed exact-stack rule is an
    // invariant rather than a suggestion to rediscover on every courier prompt.
    if (await this.runRequiredStackStep()) return;

    try {
      const availableTools = this.availableCourierTools();
      const raw = await this.llm.complete([
        { role: "system", content: LLM_COURIER_SYSTEM_PROMPT },
        { role: "user", content: buildCourierPrompt(this.context(), [...availableTools]) }
      ]);
      const decision = parseDecision(raw);
      this.logger.event("llm_courier_decision", { decision });
      if (decision.type === "tool_call") {
        if (!availableTools.has(decision.tool)) {
          const result = { ok: false, reason: "tool is not currently available" };
          this.remember({ call: { tool: decision.tool, args: decision.args }, result });
          this.logger.event("llm_courier_rejected", { tool: decision.tool, reason: result.reason });
          return;
        }
        await this.executeTool({ tool: decision.tool, args: decision.args });
      }
    } catch (error) {
      this.logger.event("llm_courier_failed", { error: String(error) });
      throw error;
    }
  }

  /** Executes one deterministic collection/delivery step for an LLM-installed stack rule. */
  private async runRequiredStackStep(): Promise<boolean> {
    const required = this.world.strategyRules.requiredStackSize;
    const me = this.world.me;
    if (required === undefined || !me) return false;

    const carried = me.carriedParcels.length;
    if (carried > required) {
      // This can happen when the rule arrives after parcels were already collected. Wait for
      // the sensed stack to become valid instead of knowingly making a non-compliant delivery.
      this.logger.event("exact_stack_waiting", { required, carried, reason: "stack exceeds required size" });
      return true;
    }

    if (carried === required) {
      const delivery = this.nearestExactStackDelivery(me.position);
      if (!delivery) {
        this.logger.event("exact_stack_waiting", { required, carried, reason: "no reachable delivery tile" });
        return true;
      }
      if (samePosition(me.position, delivery.position)) await this.executeTool({ tool: "deliver_here", args: {} });
      else await this.moveForExactStack(delivery.position);
      return true;
    }

    const remaining = required - carried;
    const here = this.world.pickupableParcelsAt(me.position);
    if (here.length > 0 && here.length <= remaining) {
      await this.executeTool({ tool: "pickup_here", args: {} });
      return true;
    }

    // Pickup collects every parcel on a tile, so group targets by position and reject any
    // tile that would overshoot the exact stack. Prefer a short route whose parcels should
    // still exist by the time the completed stack reaches a delivery tile.
    const groups = new Map<string, typeof here>();
    for (const parcel of this.world.reachableParcels()) {
      const key = positionKey(parcel.position);
      groups.set(key, [...(groups.get(key) ?? []), parcel]);
    }
    const target = [...groups.values()]
      .filter((parcels) => parcels.length <= remaining)
      .flatMap((parcels) => {
        const position = parcels[0]!.position;
        const toParcel = this.world.shortestRouteDistance(me.position, position, true);
        const delivery = this.nearestExactStackDelivery(position);
        if (toParcel === null || !delivery) return [];
        const totalSteps = toParcel + delivery.distance;
        const survives = [...this.world.carriedParcelBeliefs(), ...parcels].every(
          (parcel) => this.world.rewardAfterTravel(parcel, totalSteps, this.config.agentTickMs, 2) > 0
        );
        return survives ? [{ position, totalSteps }] : [];
      })
      .sort((a, b) => a.totalSteps - b.totalSteps)[0]?.position;

    if (!target) {
      const exploration = this.world.explorationTarget(true);
      if (exploration && !samePosition(me.position, exploration)) await this.moveForExactStack(exploration);
      return true;
    }
    await this.moveForExactStack(target);
    return true;
  }

  /** Selects a legal delivery route while treating visible agents as temporary obstacles. */
  private nearestExactStackDelivery(from: Position): { position: Position; distance: number } | null {
    const deliveries = this.world.deliveryTiles().flatMap((position) => {
      const distance = this.world.shortestRouteDistance(from, position, true);
      return distance === null ? [] : [{ position, distance }];
    });
    return deliveries.sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  /** Executes a strategy-selected route and cools down a destination rejected by the server. */
  private async moveForExactStack(target: Position): Promise<void> {
    const result = object(await this.executeTool({ tool: "move_to", args: { ...target } }));
    if (result.ok !== true) this.world.markTileBlocked(target);
  }

  /** Hides courier actions that the current state already proves cannot succeed. */
  private availableCourierTools(): Set<string> {
    const available = new Set(COURIER_TOOLS);
    if (!this.world.me) return available;

    const carried = this.world.me.carriedParcels.length;
    const required = this.world.strategyRules.requiredStackSize;
    const canPickup = this.world.pickupableParcelsAt(this.world.me.position).length > 0;
    if (!canPickup || (required !== undefined && carried >= required)) available.delete("pickup_here");

    const onDelivery = this.world.deliveryTiles().some((tile) => samePosition(tile, this.world.me!.position));
    if (!onDelivery || carried === 0 || (required !== undefined && carried !== required)) {
      available.delete("deliver_here");
    }
    return available;
  }

  /** Runs a validated capability and retains its observation as context for later decisions. */
  private async executeTool(call: ToolCall): Promise<unknown> {
    let result: unknown;
    try {
      if (call.tool === "plan_delivery") {
        result = await this.planDelivery(call.args);
      } else if (call.tool === "coordinate") {
        result = await this.startCoordination(call.args);
      } else {
        result = await this.tools.execute(call.tool, call.args);
      }
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    this.remember({ call, result });
    return result;
  }

  /** Bridges a high-level collection request to PDDL, then executes the returned symbolic actions as tools. */
  private async planDelivery(args: Record<string, unknown>): Promise<unknown> {
    if (!this.config.pddlEnabled) return { ok: false, reason: "PDDL disabled" };
    const snapshot = this.world.plannerSnapshot();
    if (!snapshot || !this.world.me) return { ok: false, reason: "world state unavailable" };

    const requestedCount = Math.max(1, Number(args.parcelCount ?? 1));
    const needed = Math.max(0, requestedCount - this.world.carriedParcelBeliefs().length);
    const candidates = this.world
      .reachableParcels()
      .sort((a, b) => b.reward * b.confidence - a.reward * a.confidence)
      .slice(0, needed);
    if (candidates.length < needed) return { ok: false, reason: "not enough known parcels" };

    const requestedDelivery = parsePosition(args.delivery);
    const deliveryTiles = requestedDelivery ? [requestedDelivery] : this.world.deliveryTiles();
    const plan = await this.planner.plan({
      world: snapshot,
      candidateParcels: candidates,
      deliveryTiles,
      carrying: this.world.me.carriedParcels
    });
    if (!plan.success) return { ok: false, reason: plan.reason };

    for (const action of plan.actions) {
      // One concrete pickup may satisfy several consecutive symbolic pickup actions when
      // their parcel objects occupy the same tile.
      if (
        action.kind === "pickup" &&
        action.parcelIds?.length &&
        action.parcelIds.every((id) => this.world.me?.carriedParcels.includes(id))
      ) {
        continue;
      }
      if (action.kind === "putdown" && this.world.carriedParcelBeliefs().length === 0) continue;
      const result = await this.tools.execute(actionTool(action), actionArgs(action));
      if (object(result).ok === false) return { ok: false, failedAction: action, result };
    }
    return { ok: true, planner: "PDDL", actions: plan.actions.length };
  }

  /** Uses A* normally and local PDDL planning when crates block the route. */
  private async routeTo(target: Position): Promise<PlanAction[] | null> {
    if (!this.world.me) return null;
    const path = this.pathfinder.findPath(this.world.me.position, target, false);
    if (path) return this.pathfinder.directions(path).map((direction) => ({ kind: "move", direction }));

    const snapshot = this.world.plannerSnapshot();
    if (!snapshot) return null;
    const route = await this.crateRouter.route(snapshot, target);
    this.logger.event("crate_route", {
      target,
      success: route.success,
      partial: route.partial,
      passages: route.passages,
      reason: route.reason
    });
    if (route.actions.length === 0) this.world.markTileBlocked(target);
    // A partial route still clears a crate, so it is worth executing: the next decision round
    // re-plans from a different position and may then see a way through.
    return route.actions.length === 0 ? null : route.actions;
  }

  /** Builds the LLM memory from current beliefs and recent tool observations. */
  private context(): Record<string, unknown> {
    return {
      me: this.world.me,
      carriedParcels: this.world.carriedParcelBeliefs(),
      visibleParcels: this.world.reachableParcels(),
      deliveryTiles: this.world.deliveryTiles(),
      explorationTarget: this.world.explorationTarget(true),
      strategyRules: this.world.strategyRules,
      teammate: this.world.agents().find((agent) => agent.name?.toLowerCase().includes("agent")),
      recentObservations: this.recentObservations
    };
  }

  /** Applies teammate parcel claims and keeps recent coordination visible to the LLM. */
  private handleTeamMessages(): void {
    for (const message of this.communication.drain()) {
      if (message.type === "intention_claim" && typeof message.payload.parcelId === "string") {
        this.world.claimParcel(message.payload.parcelId, message.from);
      }
      if (message.type === "eta" && message.from === "agent-a") {
        const teammatePosition = parsePosition(message.payload.position);
        if (teammatePosition) this.teammateStatus = { position: teammatePosition, receivedAt: Date.now() };
      }
      this.coordination.receive(message);
      this.remember({ teamMessage: message });
    }
  }

  /** Keeps the five latest observations used to refine later decisions. */
  private remember(observation: unknown): void {
    this.recentObservations.push(observation);
    this.recentObservations = this.recentObservations.slice(-5);
  }

  /** Starts one Level 3 protocol and assigns different reachable positions to the two agents. */
  private async startCoordination(args: Record<string, unknown>): Promise<unknown> {
    if (!this.world.me) return { ok: false, reason: "world state unavailable" };
    if (this.coordination.mission) {
      return { ok: true, status: "pending", missionId: this.coordination.mission.id };
    }

    const kind = parseCoordinationKind(args.kind);
    if (!kind) return { ok: false, reason: "unknown coordination kind" };

    const teammate = this.teammatePosition();
    if (!teammate) {
      if (!this.pendingCoordination) {
        this.pendingCoordination = { args, requestedAt: Date.now() };
        await this.communication.send({ type: "eta", to: "agent-a", payload: { request: "status" } });
        this.logger.event("coordination_waiting", { kind, reason: "waiting for teammate status" });
      }
      return { ok: true, status: "pending", reason: "waiting for teammate status" };
    }

    const missionId = String(args.missionId ?? uniqueId("team"));
    let targets: { leader: Position; follower: Position } | null = null;
    const payload: Record<string, unknown> = { requester: args.requester };

    if (kind === "meet_near") {
      const center = parsePosition(args) ?? this.world.me.position;
      const requestedDistance = Number(args.maxDistance ?? 3);
      const maxDistance = Number.isFinite(requestedDistance) ? Math.max(0, requestedDistance) : 3;
      targets = meetingTargets(this.world, this.world.me.position, teammate, center, maxDistance);
    }
    if (kind === "odd_row_wait") {
      targets = oddRowTargets(this.world, this.world.me.position, teammate);
    }
    if (kind === "handoff") {
      const prepared = await this.prepareHandoff(teammate);
      if (!prepared) return { ok: false, reason: "no parcel or safe handoff positions available" };
      targets = { leader: prepared.dropTarget, follower: prepared.waitTarget };
      payload.dropTarget = prepared.dropTarget;
      payload.escapeTarget = prepared.escapeTarget;
    }
    if (!targets) return { ok: false, reason: "no distinct reachable coordination targets" };

    this.coordination.start(missionId, kind, targets.leader, payload);
    await this.communication.send(this.coordination.request(targets.follower, payload));
    this.logger.event("coordination_started", { missionId, kind, targets });
    return { ok: true, status: "pending", missionId, targets };
  }

  /** Waits briefly for Agent A's reported position before starting a Level 3 protocol. */
  private async advancePendingCoordination(): Promise<void> {
    const pending = this.pendingCoordination;
    if (!pending) return;
    if (Date.now() - pending.requestedAt > COORDINATION_STATUS_TIMEOUT_MS) {
      this.pendingCoordination = null;
      const reason = "teammate status timeout";
      const requester = typeof pending.args.requester === "string" ? pending.args.requester : undefined;
      if (requester) await this.client.say(requester, `Coordination mission failed: ${reason}`);
      this.logger.event("coordination_failed", { kind: pending.args.kind, reason });
      return;
    }
    if (!this.teammatePosition()) return;

    this.pendingCoordination = null;
    const result = object(await this.startCoordination(pending.args));
    if (result.ok === true) return;
    const reason = typeof result.reason === "string" ? result.reason : "coordination could not start";
    const requester = typeof pending.args.requester === "string" ? pending.args.requester : undefined;
    if (requester) await this.client.say(requester, `Coordination mission failed: ${reason}`);
    this.logger.event("coordination_failed", { kind: pending.args.kind, reason });
  }

  /** Prefers a visible Agent A, then falls back to a recent self-reported position. */
  private teammatePosition(): Position | null {
    const visible = this.world
      .agents()
      .find((agent) => agent.confidence > 0.5 && agent.name?.trim().toLowerCase() === "agent a");
    if (visible) return visible.position;
    if (this.teammateStatus && Date.now() - this.teammateStatus.receivedAt <= TEAMMATE_STATUS_MAX_AGE_MS) {
      return this.teammateStatus.position;
    }
    return null;
  }

  /** Advances an active mission while retrying routes until completion or timeout. */
  private async advanceCoordination(): Promise<void> {
    const mission = this.coordination.mission;
    if (!mission || !this.world.me) return;
    if (this.coordination.expired()) {
      await this.communication.send(this.coordination.cancel("coordination timeout"));
      this.logger.event("coordination_cancelled", { missionId: mission.id, reason: "timeout" });
      await this.reportCoordinationFailed("coordination timeout");
      this.coordination.clear();
      return;
    }
    if (mission.phase === "completed") {
      await this.reportCoordinationCompleted();
      this.coordination.clear();
      return;
    }
    if (mission.phase === "cancelled") {
      const reason = typeof mission.payload.reason === "string" ? mission.payload.reason : "cancelled by teammate";
      await this.reportCoordinationFailed(reason);
      this.coordination.clear();
      return;
    }

    // Once Agent B has announced readiness on an odd row, it must not invoke movement or
    // courier tools. The direct green-light branch in cycle() is the only normal release.
    if (mission.kind === "odd_row_wait" && mission.localReady) return;

    if (!mission.localReady) {
      const movement = object(await this.tools.execute("move_to", { ...mission.target }));
      if (movement.ok !== true) return;
      const ready = this.coordination.ready(this.world.me.position);
      if (ready) await this.communication.send(ready);
    }

    if (mission.kind === "meet_near" && mission.localReady && mission.teammateReady) {
      await this.finishCoordination();
    }

    if (mission.kind === "handoff" && mission.phase === "waiting" && mission.teammateReady) {
      const dropped = object(await this.tools.execute("putdown_here", {}));
      if (dropped.ok !== true) return;
      mission.phase = "handoff_available";
      mission.payload.parcelDropped = true;
    }
    if (mission.kind === "handoff" && mission.phase === "handoff_available" && mission.payload.announced !== true) {
      const escapeTarget = parsePosition(mission.payload.escapeTarget);
      const movement = escapeTarget ? object(await this.tools.execute("move_to", { ...escapeTarget })) : { ok: false };
      if (movement.ok !== true) return;
      await this.communication.send(this.coordination.message("handoff_available", { target: mission.target }));
      mission.payload.announced = true;
    }
  }

  /** Picks the parcel that Agent A will later collect, then finds adjacent wait/drop/escape tiles. */
  private async prepareHandoff(teammate: Position): Promise<{
    dropTarget: Position;
    waitTarget: Position;
    escapeTarget: Position;
  } | null> {
    if (!this.world.me) return null;
    if (this.world.carriedParcelBeliefs().length === 0) {
      const parcel = this.world
        .reachableParcels()
        .filter((candidate) => !candidate.carriedBy)
        .sort((a, b) => b.reward * b.confidence - a.reward * a.confidence)[0];
      if (!parcel) return null;
      const movement = object(await this.tools.execute("move_to", { ...parcel.position }));
      if (movement.ok !== true) return null;
      const pickup = object(await this.tools.execute("pickup_here", {}));
      if (pickup.ok !== true) return null;
    }

    const center = this.world.me.position;
    const targets = handoffTargets(this.world, center, teammate, center, 3);
    if (!targets) return null;
    const escapeTarget = this.world
      .walkableTiles()
      .find(
        (tile) =>
          !samePosition(tile, targets.leader) &&
          !samePosition(tile, targets.follower) &&
          this.world.shortestPathDistance(targets.leader, tile, false) === 1
      );
    return escapeTarget
      ? { dropTarget: targets.leader, waitTarget: targets.follower, escapeTarget }
      : null;
  }

  /** Broadcasts completion, answers the mission agent when needed, and resumes courier work. */
  private async finishCoordination(replyTo?: string): Promise<void> {
    const mission = this.coordination.mission;
    if (!mission) return;
    await this.communication.send(this.coordination.complete());
    await this.reportCoordinationCompleted(replyTo);
    this.coordination.clear();
  }

  /** Reports success once, including missions completed by the teammate after a handoff. */
  private async reportCoordinationCompleted(replyTo?: string): Promise<void> {
    const mission = this.coordination.mission;
    if (!mission || mission.role !== "leader") return;
    const requester = replyTo ?? (typeof mission.payload.requester === "string" ? mission.payload.requester : undefined);
    if (requester) await this.client.say(requester, `Coordination mission ${mission.id} completed`);
    this.logger.event("coordination_completed", { missionId: mission.id, kind: mission.kind });
  }

  /** Reports a terminal protocol failure from the leader instead of leaving the requester waiting. */
  private async reportCoordinationFailed(reason: string): Promise<void> {
    const mission = this.coordination.mission;
    if (!mission || mission.role !== "leader") return;
    const requester = typeof mission.payload.requester === "string" ? mission.payload.requester : undefined;
    if (requester) await this.client.say(requester, `Coordination mission ${mission.id} failed: ${reason}`);
    this.logger.event("coordination_failed", { missionId: mission.id, kind: mission.kind, reason });
  }
}

/** Strips optional Markdown and validates that an LLM response follows the controller protocol. */
function parseDecision(raw: string): Decision {
  const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return DecisionSchema.parse(JSON.parse(json));
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function isGreenLight(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("green light") || lower.includes("move again") || lower.includes("resume");
}

/** Maps symbolic PDDL actions onto the concrete capability names exposed by AgentTools. */
function actionTool(action: PlanAction): string {
  if (action.kind === "move") return "move_direction";
  if (action.kind === "pickup") return "pickup_here";
  if (action.kind === "putdown") return "deliver_here";
  throw new Error(`Unsupported PDDL action: ${action.kind}`);
}

/** Extracts the concrete arguments needed when a symbolic PDDL action becomes a tool call. */
function actionArgs(action: PlanAction): Record<string, unknown> {
  return action.direction ? { direction: action.direction } : {};
}

/** Standalone entry point for running only the LLM/tool agent. */
export async function main(): Promise<void> {
  await new LlmAgent(loadConfig()).start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

import { loadConfig } from "../common/config.js";
import { CommunicationAdapter } from "../common/communication.js";
import { CoordinationSession } from "../common/coordination.js";
import { DeliverooClientAdapter } from "../common/deliveroo-client-adapter.js";
import { Logger } from "../common/logger.js";
import { Pathfinder } from "../common/pathfinder.js";
import type { AgentConfig, Direction, Intention, PlanAction, Position } from "../common/types.js";
import { nextPosition, samePosition, sleep } from "../common/utils.js";
import { WorldModel } from "../common/world-model.js";
import { CrateRouter } from "../pddl/crate-router.js";
import { reviseIntention } from "./intentions.js";
import { generateOptions } from "./strategy.js";

/** How many cycles an agent waits for a teammate to clear a tile before it replans around it. */
const MAX_CONSECUTIVE_YIELDS = 3;

/** Result of a guarded movement: `yielded` means no command was sent at all. */
type MoveAttempt = { yielded: boolean; ok: boolean; position?: Position };

/** Agent A follows the practical-reasoning loop from the BDI lectures. */
export class BdiAgent {
  private readonly world = new WorldModel();
  private readonly logger: Logger;
  private readonly client: DeliverooClientAdapter;
  private readonly communication: CommunicationAdapter;
  private readonly coordination = new CoordinationSession();
  private readonly pathfinder = new Pathfinder(this.world);
  private readonly crateRouter: CrateRouter;
  private intention: Intention | null = null;
  private plan: PlanAction[] = [];
  private yieldStreak = 0;
  private running = false;

  /** Wires the SDK, team protocol, logger, and shared beliefs used by the BDI loop. */
  constructor(private readonly config: AgentConfig) {
    this.logger = new Logger(config.logDir, "agent-a-bdi");
    this.client = new DeliverooClientAdapter(config.deliverooUrl, config.tokenAgentA, this.logger);
    this.communication = new CommunicationAdapter(this.client, this.logger, "agent-a");
    this.crateRouter = new CrateRouter(config, this.logger);
  }

  /** Connects sensing, then repeatedly runs the BDI reasoning cycle until shutdown. */
  async start(): Promise<void> {
    this.bindSensing();
    this.client.connect();
    this.running = true;
    this.logger.event("agent_started", { architecture: "BDI" });
    while (this.running) {
      const startedAt = Date.now();
      try {
        await this.cycle();
      } catch (error) {
        this.logger.event("cycle_failed", { error: String(error) });
        this.intention = null;
        this.resetPlan();
      }
      // Sleep only what is left of the tick. Awaiting an action already costs real time, so
      // a fixed sleep would make the effective cycle period drift with server latency.
      await sleep(Math.max(0, this.config.agentTickMs - (Date.now() - startedAt)));
    }
  }

  stop(): void {
    this.running = false;
    this.client.disconnect();
  }

  /** Discards the current plan so the next cycle performs means-end planning again. */
  private resetPlan(): void {
    this.plan = [];
  }

  /** Routes asynchronous SDK events into the shared belief model used by deliberation. */
  private bindSensing(): void {
    this.client.onSelf((self) => {
      this.world.observeSelf(self);
      this.logger.event("belief_revision", { source: "self", belief: this.world.me });
    });
    this.client.onMap(({ width, height, tiles }) => {
      this.world.observeMap(width, height, tiles);
      this.logger.event("belief_revision", { source: "map", width, height });
    });
    this.client.onConfig((config) => this.world.observeConfig(config));
    this.client.onParcels((parcels) => {
      this.world.observeParcels(parcels);
      this.logger.event("belief_revision", { source: "parcels", beliefs: this.world.parcels() });
    });
    this.client.onAgents((agents) => this.world.observeAgents(agents));
    this.client.onCrates((crates) => this.world.observeCrates(crates));
  }

  /** Performs belief revision, deliberation, means-end planning, and one action in lecture order. */
  private async cycle(): Promise<void> {
    // 1. Observe events and revise beliefs.
    this.world.advanceTick();
    await this.handleMessages();
    if (!this.world.me || !this.client.isConnected) return;

    if (this.coordination.mission) {
      await this.followTeamMission();
      return;
    }

    // 2. Deliberate: generate desires and revise the committed intention.
    const options = generateOptions(this.world, this.config.agentTickMs);
    const revision = reviseIntention(this.world, this.intention, options[0]!, this.config.agentTickMs);
    if (revision.changed) {
      this.intention = revision.intention;
      this.resetPlan();
      this.logger.event("intention_revision", { reason: revision.reason, intention: this.intention });
      if (this.intention.parcelId) {
        this.world.claimParcel(this.intention.parcelId, this.world.me.id);
        await this.communication.send({
          type: "intention_claim",
          payload: { parcelId: this.intention.parcelId }
        });
      }
    }

    // 3. Means-end reasoning: select a plan from the plan library.
    if (this.plan.length === 0) {
      this.plan = await this.selectPlan(this.intention);
    }

    // 4. Execute one action, then reconsider in the changing environment.
    await this.execute(this.plan[0]);
  }

  /** Selects the pickup, delivery, or exploration recipe for the current intention. */
  private async selectPlan(intention: Intention | null): Promise<PlanAction[]> {
    if (!this.world.me || !intention?.target || intention.kind === "wait") return [];
    const plan = await this.routeTo(intention.target);
    // A* represents "already there" as a one-node path, which becomes zero movement
    // actions. That is still a successful route: pickup and putdown must execute on the
    // current tile instead of being mistaken for an unreachable destination.
    if (plan.length === 0 && !samePosition(this.world.me.position, intention.target)) return [];
    if (intention.kind === "pickup") plan.push({ kind: "pickup", parcelIds: intention.parcelId ? [intention.parcelId] : [] });
    if (intention.kind === "deliver") plan.push({ kind: "putdown" });
    this.logger.event("plan_selected", { intention, plan });
    return plan;
  }

  /** Uses A* for normal movement and global PDDL planning when crates block the route. */
  private async routeTo(target: Position): Promise<PlanAction[]> {
    if (!this.world.me) return [];
    const path = this.pathfinder.findPath(this.world.me.position, target);
    if (path) return this.pathfinder.directions(path).map((direction) => ({ kind: "move", direction }));

    const snapshot = this.world.plannerSnapshot();
    if (!snapshot) return [];
    const route = await this.crateRouter.route(snapshot, target);
    this.logger.event("crate_route", {
      target,
      success: route.success,
      partial: route.partial,
      passages: route.passages,
      reason: route.reason
    });
    // An optimistic route does not prove that its crates can actually be pushed. Cool down
    // an unsuccessful target so deliberation can try a different parcel or exploration area
    // instead of invoking the external planner again on every reasoning tick.
    if (route.actions.length === 0) this.world.markTileBlocked(target, 5_000);
    return route.actions;
  }

  /** Executes one plan step and immediately reconciles success or failure with beliefs. */
  private async execute(action: PlanAction | undefined): Promise<void> {
    if (!action) return;

    if (action.kind === "move" && action.direction) {
      const attempt = await this.attemptMove(action.direction, action.cratePush);
      // A yielded step stays pending, so the next cycle retries it once the tile is free.
      if (attempt.yielded) return;
      this.plan.shift();
      this.yieldStreak = 0;
      if (attempt.ok && attempt.position && this.world.me) {
        this.world.observeSelf({ ...this.world.me, ...attempt.position });
        // The server never announces a push, so revise the crate belief from the plan instead
        // of waiting for the crate to re-enter the sensing radius.
        if (action.cratePush) {
          this.world.markCratePushed(action.cratePush.from, action.cratePush.to);
          // A symbolic crate route is based on a snapshot. Replan immediately after each
          // irreversible push so subsequent pushes use the newly sensed/predicted layout.
          this.resetPlan();
        }
      } else if (this.world.me) {
        this.world.markTileBlocked(nextPosition(this.world.me.position, action.direction));
        this.intention = null;
        this.resetPlan();
      }
      return;
    }

    this.yieldStreak = 0;
    if (action.kind === "pickup") {
      const expected = this.world.me
        ? this.world.pickupableParcelsAt(this.world.me.position).map((parcel) => parcel.id)
        : action.parcelIds ?? [];
      const result = await this.client.pickup();
      const picked = result.ids.length > 0 ? result.ids : expected.slice(0, result.count);
      if (result.count > 0) {
        const unknown = this.world.markPickedUp(picked);
        if (unknown.length > 0) this.logger.event("pickup_unknown_ids", { ids: unknown, expected });
      } else {
        this.world.markPickupFailed(action.parcelIds);
      }
      this.resetPlan();
    }
    if (action.kind === "putdown") {
      const result = await this.client.putdown();
      if (result.count > 0) this.world.markPutdown();
      this.resetPlan();
    }
  }

  /** Rechecks a planned move against current beliefs before sending it. */
  private async attemptMove(direction: Direction, cratePush?: { from: Position; to: Position }): Promise<MoveAttempt> {
    const me = this.world.me;
    if (!me) return { yielded: false, ok: false };
    const destination = nextPosition(me.position, direction);
    // A crate tile is not walkable, so a push has to be validated against the push rule
    // instead: the tile beyond the crate must be a free crate-sliding tile.
    const pushTarget =
      cratePush && this.world.hasCrate(destination) ? this.world.cratePushDestination(me.position, destination) : null;
    if (cratePush ? pushTarget !== null : this.world.canMove(me.position, destination)) {
      return { yielded: false, ...(await this.client.move(direction)) };
    }
    if (cratePush) {
      this.logger.event("push_aborted", { direction, destination, expected: cratePush });
      this.intention = null;
      this.resetPlan();
      return { yielded: false, ok: false };
    }

    const blocker = this.world
      .agents()
      .find((agent) => agent.confidence > 0.5 && samePosition(agent.position, destination));
    if (blocker && this.shouldYieldTo(blocker.id) && this.yieldStreak < MAX_CONSECUTIVE_YIELDS) {
      this.yieldStreak += 1;
      this.logger.event("move_yielded", { direction, destination, blockedBy: blocker.id, streak: this.yieldStreak });
      return { yielded: true, ok: false };
    }

    // Wall, forbidden tile, or a teammate that has already used up its turn to move: stop
    // routing through here and let the next cycle plan a way around it.
    this.logger.event("move_aborted", { direction, destination, blockedBy: blocker?.id });
    this.world.markTileBlocked(destination);
    this.intention = null;
    this.resetPlan();
    return { yielded: false, ok: false };
  }

  /** Breaks head-on deadlocks by making the agent with the larger id yield. */
  private shouldYieldTo(otherAgentId: string): boolean {
    return Boolean(this.world.me) && otherAgentId < this.world.me!.id;
  }

  /** Incorporates teammate claims and mission requests before the agent deliberates. */
  private async handleMessages(): Promise<void> {
    for (const message of this.communication.drain()) {
      if (message.type === "intention_claim" && typeof message.payload.parcelId === "string") {
        this.world.claimParcel(message.payload.parcelId, message.from);
      }
      if (this.coordination.receive(message)) this.resetPlan();
      if (message.type === "eta") {
        await this.communication.send({
          type: "eta",
          to: message.from,
          payload: { position: this.world.me?.position, intention: this.intention?.kind ?? "idle" }
        });
      }
    }
  }

  /** Temporarily gives a coordinated Level 3 target precedence over ordinary courier intentions. */
  private async followTeamMission(): Promise<void> {
    const mission = this.coordination.mission;
    if (!this.world.me || !mission) return;
    if (this.coordination.expired()) {
      await this.communication.send(this.coordination.cancel("coordination timeout"));
      this.logger.event("coordination_cancelled", { missionId: mission.id, reason: "timeout" });
      this.coordination.clear();
      this.resetPlan();
      return;
    }
    if (mission.phase === "completed" || mission.phase === "cancelled") {
      this.coordination.clear();
      this.resetPlan();
      return;
    }

    if (mission.kind === "handoff" && mission.phase === "handoff_available") {
      await this.receiveHandoff();
      return;
    }

    // Readiness is the red-light state. Agent B will send mission_done after the mission
    // agent's green light; until then no BDI intention or movement may resume.
    if (mission.kind === "odd_row_wait" && mission.localReady) return;

    if (samePosition(this.world.me.position, mission.target)) {
      if (mission.kind === "handoff" && mission.payload.stage === "deliver") {
        const carried = this.world.carriedParcelBeliefs().length;
        await this.execute({ kind: "putdown" });
        if (carried > 0 && this.world.carriedParcelBeliefs().length === 0) {
          await this.communication.send(this.coordination.complete());
          this.logger.event("coordination_completed", { missionId: mission.id, kind: mission.kind });
          this.coordination.clear();
        }
        return;
      }
      const ready = this.coordination.ready(this.world.me.position);
      if (ready) await this.communication.send(ready);
      return;
    }

    if (this.plan.length === 0) {
      this.plan = await this.routeTo(mission.target);
    }
    await this.execute(this.plan[0]);
  }

  /** Picks up Agent B's parcel, acknowledges the transfer, and delivers it normally. */
  private async receiveHandoff(): Promise<void> {
    const mission = this.coordination.mission;
    if (!this.world.me || !mission) return;
    if (!samePosition(this.world.me.position, mission.target)) {
      if (this.plan.length === 0) {
        this.plan = await this.routeTo(mission.target);
      }
      await this.execute(this.plan[0]);
      return;
    }

    const expected = this.world.pickupableParcelsAt(this.world.me.position).map((parcel) => parcel.id);
    const result = await this.client.pickup();
    if (result.count === 0) return;
    const picked = result.ids.length > 0 ? result.ids : expected.slice(0, result.count);
    const unknown = this.world.markPickedUp(picked);
    if (unknown.length > 0) this.logger.event("pickup_unknown_ids", { ids: unknown, expected });
    await this.communication.send(this.coordination.message("handoff_received"));
    const delivery = this.world.nearestDeliveryWithDistance(this.world.me.position);
    if (!delivery) return;
    mission.phase = "moving";
    mission.localReady = false;
    mission.target = delivery.position;
    mission.payload.stage = "deliver";
    this.resetPlan();
  }
}

/** Standalone entry point for running only the BDI agent. */
export async function main(): Promise<void> {
  await new BdiAgent(loadConfig()).start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

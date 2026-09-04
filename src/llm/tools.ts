import type { CommunicationAdapter } from "../common/communication.js";
import type { DeliverooClientAdapter } from "../common/deliveroo-client-adapter.js";
import type { Logger } from "../common/logger.js";
import type { Direction, PlanAction, Position, TeamMessageType } from "../common/types.js";
import { samePosition } from "../common/utils.js";
import type { WorldModel } from "../common/world-model.js";
import { evaluateArithmetic } from "./missions.js";

type Tool = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** Concrete tools available to the LLM controller. */
export class AgentTools {
  private readonly tools: Record<string, Tool>;

  /** Registers the finite capability set that grounds LLM decisions in safe game operations. */
  constructor(
    private readonly world: WorldModel,
    private readonly client: DeliverooClientAdapter,
    private readonly communication: CommunicationAdapter,
    private readonly logger: Logger,
    private readonly route: (target: Position) => Promise<PlanAction[] | null>
  ) {
    this.tools = {
      get_my_position: () => this.world.me,
      get_visible_parcels: () => this.world.reachableParcels(),
      get_delivery_tiles: () => this.world.deliveryTiles(),
      move_to: (args) => this.moveTo(position(args)),
      move_direction: (args) => this.moveDirection(String(args.direction) as Direction),
      move_to_leftmost_delivery: () => this.moveToLeftmostDelivery(),
      move_to_odd_row: () => this.moveToOddRow(),
      pickup_here: () => this.pickupHere(),
      deliver_here: () => this.deliverHere(),
      // Raw putdown is internal: coordination uses it to transfer a parcel without delivering it.
      putdown_here: () => this.putdownHere(),
      calculate: (args) => evaluateArithmetic(String(args.expression)),
      set_strategy_rule: (args) => this.setStrategyRule(String(args.rule), args.value),
      send_team_message: async (args) => {
        await this.communication.send({
          type: String(args.type) as TeamMessageType,
          to: typeof args.to === "string" ? args.to : undefined,
          payload: object(args.payload)
        });
        return { ok: true };
      },
      ask_bdi_status: async () => {
        await this.communication.send({ type: "eta", payload: { request: "status" } });
        return { ok: true };
      }
    };
  }

  /** Dispatches a named capability and logs both sides of the LLM's tool-observation exchange. */
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    this.logger.event("tool_call", { name, args });
    const result = await tool(args);
    this.logger.event("tool_result", { name, result });
    return result;
  }

  /** Claims parcel targets, follows an A* route, and stops early if the changing world blocks it. */
  private async moveTo(target: Position): Promise<{ ok: boolean; steps: number; target: Position }> {
    if (!this.world.me) return { ok: false, steps: 0, target };
    const parcel = this.world
      .reachableParcels()
      .find((candidate) => samePosition(candidate.position, target));
    if (parcel) {
      this.world.claimParcel(parcel.id, this.world.me.id);
      await this.communication.send({ type: "intention_claim", payload: { parcelId: parcel.id } });
    }

    let steps = 0;
    // Crate routes are snapshots. Execute through the next push, revise crate beliefs, then
    // request a fresh route instead of trusting a chain of predicted future crate positions.
    for (let planningRound = 0; planningRound < 12; planningRound += 1) {
      if (this.world.me && samePosition(this.world.me.position, target)) return { ok: true, steps, target };
      const plan = await this.route(target);
      if (!plan || plan.length === 0) return { ok: false, steps, target };

      let pushed = false;
      for (const action of plan) {
        if (action.kind !== "move" || !action.direction) return { ok: false, steps, target };
        const result = await this.moveDirection(action.direction, action.cratePush);
        steps += 1;
        if (!result.ok) return { ok: false, steps, target };
        if (action.cratePush) {
          pushed = true;
          break;
        }
      }
      if (!pushed) return { ok: Boolean(this.world.me && samePosition(this.world.me.position, target)), steps, target };
    }
    return { ok: Boolean(this.world.me && samePosition(this.world.me.position, target)), steps, target };
  }

  /** Validates one LLM-supplied direction and mirrors a successful move into beliefs. */
  private async moveDirection(
    direction: Direction,
    cratePush?: { from: Position; to: Position }
  ): Promise<{ ok: boolean; position?: Position }> {
    if (!["up", "down", "left", "right"].includes(direction)) return { ok: false };
    const result = await this.client.move(direction);
    if (result.ok && result.position && this.world.me) {
      this.world.observeSelf({ ...this.world.me, ...result.position });
      if (cratePush) this.world.markCratePushed(cratePush.from, cratePush.to);
    }
    return result;
  }

  /** Reconciles a pickup with sensed ids because Deliveroo action replies may contain only a count. */
  private async pickupHere(): Promise<{ ok: boolean; picked: string[]; reason?: string }> {
    const required = this.world.strategyRules.requiredStackSize;
    const carried = this.world.me?.carriedParcels.length ?? 0;
    if (required !== undefined && carried >= required) {
      return { ok: false, picked: [], reason: `stack already contains ${required} parcels` };
    }
    const expected = this.world.me ? this.world.pickupableParcelsAt(this.world.me.position).map((parcel) => parcel.id) : [];
    if (required !== undefined && carried + expected.length > required) {
      return {
        ok: false,
        picked: [],
        reason: `pickup would exceed required stack of ${required} parcels`
      };
    }
    const result = await this.client.pickup();
    const picked = result.ids.length > 0 ? result.ids : expected.slice(0, result.count);
    const unknown = result.count > 0 ? this.world.markPickedUp(picked) : [];
    if (unknown.length > 0) this.logger.event("pickup_unknown_ids", { ids: unknown, expected });
    return { ok: result.count > 0, picked };
  }

  /** Delivers only when the current position and persistent stack rule both allow it. */
  private async deliverHere(): Promise<{ ok: boolean; dropped: string[]; reason?: string }> {
    if (!this.world.me) return { ok: false, dropped: [], reason: "self state unavailable" };
    const onDelivery = this.world.deliveryTiles().some((tile) => samePosition(tile, this.world.me!.position));
    if (!onDelivery) return { ok: false, dropped: [], reason: "not on a delivery tile" };

    const carried = this.world.me.carriedParcels.length;
    const required = this.world.strategyRules.requiredStackSize;
    if (required !== undefined && carried !== required) {
      return { ok: false, dropped: [], reason: `delivery requires exactly ${required} parcels; carrying ${carried}` };
    }
    return this.putdownHere();
  }

  /** Reconciles a raw putdown with the carried stack and clears it from the belief model. */
  private async putdownHere(): Promise<{ ok: boolean; dropped: string[] }> {
    const carried = [...(this.world.me?.carriedParcels ?? [])];
    const result = await this.client.putdown();
    const dropped = result.ids.length > 0 ? result.ids : carried.slice(0, result.count);
    if (result.count > 0) this.world.markPutdown();
    return { ok: result.count > 0, dropped };
  }

  /** Implements the Challenge 2 leftmost-delivery primitive available to LLM missions. */
  private async moveToLeftmostDelivery(): Promise<unknown> {
    const target = this.world.deliveryTiles().sort((a, b) => a.x - b.x || a.y - b.y)[0];
    return target ? this.moveTo(target) : { ok: false, reason: "no delivery tile" };
  }

  /** Finds the closest valid odd row for the coordinated red-light mission. */
  private async moveToOddRow(): Promise<unknown> {
    if (!this.world.me) return { ok: false };
    const target = this.world
      .walkableTiles()
      .filter((tile) => Math.abs(tile.y) % 2 === 1)
      .flatMap((tile) => {
        const distance = this.world.shortestPathDistance(this.world.me!.position, tile, false);
        return distance === null ? [] : [{ tile, distance }];
      })
      .sort((a, b) => a.distance - b.distance)[0]?.tile;
    return target ? this.moveTo(target) : { ok: false, reason: "no odd row" };
  }

  /** Persists a Level 2 mission constraint in the world model so every later decision obeys it. */
  private setStrategyRule(rule: string, value: unknown): unknown {
    switch (rule) {
      case "required_stack_size":
        this.world.setRequiredStackSize(Number(value));
        break;
      case "forbidden_tile":
        this.world.addForbiddenTile(position(value));
        break;
      case "bonus_delivery_tile": {
        const bonus = object(value);
        this.world.addBonusDeliveryTile(position(bonus), Number(bonus.multiplier ?? 1));
        break;
      }
      case "ignored_delivery_tile":
        this.world.addIgnoredDeliveryTile(position(value));
        break;
      case "max_deliverable_reward":
        this.world.setMaxDeliverableReward(Number(value));
        break;
      default:
        throw new Error(`Unknown strategy rule: ${rule}`);
    }
    return { ok: true, rules: this.world.strategyRules };
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Converts generic tool arguments into the coordinate type consumed by A*. */
function position(value: unknown): Position {
  const item = object(value);
  return { x: Number(item.x), y: Number(item.y) };
}

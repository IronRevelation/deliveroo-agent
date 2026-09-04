import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import type { Direction, Position, TeamMessage } from "./types.js";
import type { Logger } from "./logger.js";

type Sensing = { parcels?: unknown[]; agents?: unknown[]; crates?: unknown[] };
type ParcelActionResult = { ids: string[]; count: number };

/** Normalizes action replies so belief revision still knows whether an action succeeded when Socket.IO drops private ids. */
export function parseParcelActionResult(value: unknown): ParcelActionResult {
  if (!Array.isArray(value)) return { ids: [], count: 0 };
  const ids = value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return typeof raw === "string" ? [raw] : [];
    const parcel = raw as Record<string, unknown>;
    const nested = parcel.parcel && typeof parcel.parcel === "object" ? (parcel.parcel as Record<string, unknown>) : {};
    const id = parcel.id ?? nested.id;
    return typeof id === "string" && id ? [id] : [];
  });
  return { ids, count: value.length };
}

/** Thin wrapper around the exact SDK methods used by the two agents. */
export class DeliverooClientAdapter {
  private socket: any;

  /** Creates the single SDK socket through which one agent senses and acts in Deliveroo.js. */
  constructor(
    host: string,
    token: string,
    private readonly logger: Logger
  ) {
    this.socket = DjsConnect(host, token || undefined, undefined, false);
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket?.disconnect();
  }

  get isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  onSelf(handler: (self: unknown) => void): void {
    this.socket.onYou(handler);
  }

  onMap(handler: (map: { width: number; height: number; tiles: unknown[] }) => void): void {
    this.socket.onMap((width: number, height: number, tiles: unknown[]) => handler({ width, height, tiles }));
  }

  onConfig(handler: (config: unknown) => void): void {
    this.socket.onConfig(handler);
  }

  onParcels(handler: (parcels: unknown[]) => void): void {
    this.socket.onSensing((sensing: Sensing) => handler(sensing.parcels ?? []));
  }

  onAgents(handler: (agents: unknown[]) => void): void {
    this.socket.onSensing((sensing: Sensing) => handler(sensing.agents ?? []));
  }

  /** Reports every crate inside the sensing radius, not just the ones that moved. */
  onCrates(handler: (crates: unknown[]) => void): void {
    this.socket.onSensing((sensing: Sensing) => handler(sensing.crates ?? []));
  }

  onMessage(handler: (message: { from?: string; message: string }) => void): void {
    this.socket.onMsg((id: string, _name: string, message: unknown) => handler({ from: id, message: String(message) }));
  }

  /** Wraps movement failures in data so reasoning loops can replan instead of handling SDK exceptions. */
  async move(direction: Direction): Promise<{ ok: boolean; position?: Position }> {
    try {
      const position = await this.socket.emitMove(direction);
      const result = position ? { ok: true, position: { x: Number(position.x), y: Number(position.y) } } : { ok: false };
      this.logger.event("move", { direction, ...result });
      return result;
    } catch (error) {
      this.logger.event("move_failed", { direction, error: String(error) });
      return { ok: false };
    }
  }

  /** Executes a pickup and returns both known ids and count for the world-model reconciliation step. */
  async pickup(): Promise<ParcelActionResult> {
    try {
      const parcels = await this.socket.emitPickup();
      const result = parseParcelActionResult(parcels);
      this.logger.event("pickup", result);
      return result;
    } catch (error) {
      this.logger.event("pickup_failed", { error: String(error) });
      return { ids: [], count: 0 };
    }
  }

  /** Executes a putdown using the same normalized result contract as pickup. */
  async putdown(): Promise<ParcelActionResult> {
    try {
      const parcels = await this.socket.emitPutdown();
      const result = parseParcelActionResult(parcels);
      this.logger.event("putdown", result);
      return result;
    } catch (error) {
      this.logger.event("putdown_failed", { error: String(error) });
      return { ids: [], count: 0 };
    }
  }

  /** Broadcasts the structured team envelope through Deliveroo's global shout channel. */
  async sendTeamMessage(message: TeamMessage): Promise<void> {
    await this.socket.emitShout(`TEAMMSG ${JSON.stringify(message)}`);
  }

  /** Sends a private mission response back to the external requester. */
  async say(agentId: string, message: string): Promise<void> {
    await this.socket.emitSay(agentId, message);
  }
}

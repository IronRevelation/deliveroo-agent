import type { Position, TeamMessage } from "./types.js";
import { manhattan, parsePosition, samePosition } from "./utils.js";
import type { WorldModel } from "./world-model.js";

export type CoordinationKind = "meet_near" | "handoff" | "odd_row_wait";
export type CoordinationPhase =
  | "moving"
  | "waiting"
  | "handoff_available"
  | "handoff_received"
  | "completed"
  | "cancelled";

export interface CoordinationMission {
  id: string;
  kind: CoordinationKind;
  role: "leader" | "follower";
  target: Position;
  phase: CoordinationPhase;
  localReady: boolean;
  teammateReady: boolean;
  deadline: number;
  payload: Record<string, unknown>;
}

type OutgoingTeamMessage = Omit<TeamMessage, "from" | "timestamp">;

/** Tracks one two-agent mission without mixing protocol state into either reasoning architecture. */
export class CoordinationSession {
  mission: CoordinationMission | null = null;

  constructor(private readonly timeoutMs = 30_000) {}

  /** Opens the leader's local session before its request is sent to the teammate. */
  start(
    id: string,
    kind: CoordinationKind,
    target: Position,
    payload: Record<string, unknown> = {},
    now = Date.now()
  ): void {
    this.mission = this.create(id, kind, "leader", target, payload, now);
  }

  /** Builds the request that gives the follower its own reachable target and role. */
  request(target: Position, payload: Record<string, unknown> = {}): OutgoingTeamMessage {
    if (!this.mission) throw new Error("No active coordination mission");
    return {
      type: "mission_request",
      payload: {
        ...payload,
        missionId: this.mission.id,
        kind: this.mission.kind,
        role: "follower",
        target
      }
    };
  }

  /** Applies validated protocol messages and creates follower sessions from mission requests. */
  receive(message: TeamMessage, now = Date.now()): boolean {
    const missionId = String(message.payload.missionId ?? "");
    if (message.type === "mission_request") {
      const kind = parseCoordinationKind(message.payload.kind);
      const target = parsePosition(message.payload.target);
      if (!missionId || !kind || !target) return false;
      this.mission = this.create(missionId, kind, "follower", target, message.payload, now);
      return true;
    }

    if (!this.mission || missionId !== this.mission.id) return false;
    this.mission.deadline = now + this.timeoutMs;
    if (message.type === "wait_ready") this.mission.teammateReady = true;
    if (message.type === "handoff_available") {
      this.mission.phase = "handoff_available";
      this.mission.payload = { ...this.mission.payload, ...message.payload };
      this.mission.target = parsePosition(message.payload.target) ?? this.mission.target;
    }
    if (message.type === "handoff_received") this.mission.phase = "handoff_received";
    if (message.type === "mission_done") this.mission.phase = "completed";
    if (message.type === "mission_cancel") {
      this.mission.phase = "cancelled";
      this.mission.payload = { ...this.mission.payload, ...message.payload };
    }
    return true;
  }

  /** Marks this agent as waiting and emits at most one ready acknowledgement. */
  ready(position: Position): OutgoingTeamMessage | null {
    if (!this.mission || this.mission.localReady) return null;
    this.mission.localReady = true;
    this.mission.phase = "waiting";
    return {
      type: "wait_ready",
      payload: { missionId: this.mission.id, position }
    };
  }

  message(type: "handoff_available" | "handoff_received", payload: Record<string, unknown> = {}): OutgoingTeamMessage {
    if (!this.mission) throw new Error("No active coordination mission");
    return { type, payload: { ...payload, missionId: this.mission.id } };
  }

  /** Completes both sides of a mission and lets ordinary courier behaviour resume. */
  complete(): OutgoingTeamMessage {
    if (!this.mission) throw new Error("No active coordination mission");
    this.mission.phase = "completed";
    return { type: "mission_done", payload: { missionId: this.mission.id } };
  }

  /** Cancels a stalled mission so neither agent waits forever. */
  cancel(reason: string): OutgoingTeamMessage {
    if (!this.mission) throw new Error("No active coordination mission");
    this.mission.phase = "cancelled";
    return { type: "mission_cancel", payload: { missionId: this.mission.id, reason } };
  }

  expired(now = Date.now()): boolean {
    // Reaching an odd row is a real red-light state: only the mission agent's green-light
    // message may release it. A generic coordination timeout must not resume courier work.
    if (this.mission?.kind === "odd_row_wait" && this.mission.localReady) return false;
    return Boolean(this.mission && now > this.mission.deadline);
  }

  clear(): void {
    this.mission = null;
  }

  private create(
    id: string,
    kind: CoordinationKind,
    role: "leader" | "follower",
    target: Position,
    payload: Record<string, unknown>,
    now: number
  ): CoordinationMission {
    return {
      id,
      kind,
      role,
      target,
      phase: "moving",
      localReady: false,
      teammateReady: false,
      deadline: now + this.timeoutMs,
      payload
    };
  }
}

/** Assigns two different reachable tiles inside a mission's requested neighborhood. */
export function meetingTargets(
  world: WorldModel,
  leader: Position,
  follower: Position,
  center: Position,
  maxDistance: number
): { leader: Position; follower: Position } | null {
  const candidates = world
    .walkableTiles()
    .filter((tile) => manhattan(tile, center) <= maxDistance);
  return assignTargets(world, leader, follower, candidates);
}

/** Keeps parcel handoffs away from delivery tiles so the transfer is not scored as a delivery. */
export function handoffTargets(
  world: WorldModel,
  leader: Position,
  follower: Position,
  center: Position,
  maxDistance: number
): { leader: Position; follower: Position } | null {
  const deliveries = world.deliveryTiles();
  const candidates = world
    .walkableTiles()
    .filter((tile) => manhattan(tile, center) <= maxDistance)
    .filter((tile) => !deliveries.some((delivery) => samePosition(delivery, tile)));
  return assignTargets(world, leader, follower, candidates);
}

/** Reuses meeting assignment for the red-light mission, restricted to odd-numbered rows. */
export function oddRowTargets(
  world: WorldModel,
  leader: Position,
  follower: Position
): { leader: Position; follower: Position } | null {
  const oddTiles = world.walkableTiles().filter((tile) => Math.abs(tile.y) % 2 === 1);
  return assignTargets(world, leader, follower, oddTiles);
}

function assignTargets(
  world: WorldModel,
  leader: Position,
  follower: Position,
  tiles: Position[]
): { leader: Position; follower: Position } | null {
  const leaderTargets = tiles.flatMap((tile) => {
    const distance = world.shortestPathDistance(leader, tile, false);
    return distance === null ? [] : [{ tile, distance }];
  });
  const followerTargets = tiles.flatMap((tile) => {
    const distance = world.shortestPathDistance(follower, tile, false);
    return distance === null ? [] : [{ tile, distance }];
  });
  let best: { leader: Position; follower: Position; cost: number } | null = null;
  for (const leaderTarget of leaderTargets) {
    for (const followerTarget of followerTargets) {
      if (samePosition(leaderTarget.tile, followerTarget.tile)) continue;
      const cost = leaderTarget.distance + followerTarget.distance;
      if (!best || cost < best.cost) best = { leader: leaderTarget.tile, follower: followerTarget.tile, cost };
    }
  }
  return best && { leader: best.leader, follower: best.follower };
}

export function parseCoordinationKind(value: unknown): CoordinationKind | null {
  return value === "meet_near" || value === "handoff" || value === "odd_row_wait" ? value : null;
}

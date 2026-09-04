export type Direction = "up" | "down" | "left" | "right";

export interface Position {
  x: number;
  y: number;
}

/** Deliveroo tile types; `5!` is a crate tile whose initial state contains a crate. */
export type TileType = "0" | "1" | "2" | "3" | "4" | "5" | "5!" | "←" | "↑" | "→" | "↓";

export interface Tile {
  x: number;
  y: number;
  type: TileType;
}

export interface SelfState {
  id: string;
  name: string;
  position: Position;
  score: number;
  penalty?: number;
  carriedParcels: string[];
}

export interface ParcelBelief {
  id: string;
  position: Position;
  reward: number;
  carriedBy?: string | null;
  lastSeenAt: number;
  rewardUpdatedAtMs: number;
  confidence: number;
}

export interface CrateBelief {
  id: string;
  position: Position;
  lastSeenAt: number;
}

export interface AgentBelief {
  id: string;
  name?: string;
  position: Position;
  score?: number;
  penalty?: number;
  lastSeenAt: number;
  confidence: number;
}

export interface BonusDeliveryTile {
  position: Position;
  multiplier: number;
}

export interface StrategyRules {
  requiredStackSize?: number;
  forbiddenTiles: Position[];
  bonusDeliveryTiles: BonusDeliveryTile[];
  ignoredDeliveryTiles: Position[];
  maxDeliverableReward?: number;
}

export const TEAM_MESSAGE_TYPES = [
  "intention_claim",
  "mission_request",
  "eta",
  "handoff_available",
  "handoff_received",
  "wait_ready",
  "mission_done",
  "mission_cancel"
] as const;

export type TeamMessageType = (typeof TEAM_MESSAGE_TYPES)[number];

export interface TeamMessage {
  from: string;
  to?: string;
  type: TeamMessageType;
  payload: Record<string, unknown>;
  timestamp: number;
}

export interface Intention {
  id: string;
  kind: "pickup" | "deliver" | "explore" | "wait";
  target?: Position;
  parcelId?: string;
  priority: number;
  createdAt: number;
  reason: string;
}

export interface PlanAction {
  kind: "move" | "pickup" | "putdown";
  direction?: Direction;
  parcelIds?: string[];
  reason?: string;
  /** Expected crate movement caused by this step. */
  cratePush?: { from: Position; to: Position };
}

export interface PlannerWorldSnapshot {
  me: SelfState;
  tiles: Tile[];
  parcels: ParcelBelief[];
  crates: CrateBelief[];
  forbiddenTiles: Position[];
}

export interface PlannerRequest {
  world: PlannerWorldSnapshot;
  candidateParcels: ParcelBelief[];
  deliveryTiles: Position[];
  carrying: string[];
}

export interface PlannerResult {
  actions: PlanAction[];
  success: boolean;
  reason?: string;
}

export interface AgentConfig {
  deliverooUrl: string;
  tokenAgentA: string;
  tokenAgentB: string;
  liteLlmBaseUrl: string;
  liteLlmApiKey: string;
  liteLlmModel: string;
  pyperplanBin: string;
  pddlEnabled: boolean;
  agentTickMs: number;
  agentBTargetStack: number;
  logDir: string;
}

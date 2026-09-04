import { Pathfinder } from "./pathfinder.js";
import type {
  AgentBelief,
  BonusDeliveryTile,
  CrateBelief,
  ParcelBelief,
  PlannerWorldSnapshot,
  Position,
  SelfState,
  StrategyRules,
  Tile,
  TileType
} from "./types.js";
import { CRATE_AREA_TILES, WALKABLE_TILES, allowsEntry } from "./tiles.js";
import { manhattan, normalizeNumber, positionKey, samePosition } from "./utils.js";

/** How many cycles an out-of-view crate remains in memory. */
const CRATE_MEMORY_TICKS = 200;

/** The BDI beliefs: everything the agent currently thinks is true about the game. */
export class WorldModel {
  private tickValue = 0;
  private readonly tileByPosition = new Map<string, Tile>();
  private readonly parcelById = new Map<string, ParcelBelief>();
  private readonly crateById = new Map<string, CrateBelief>();
  private readonly agentById = new Map<string, AgentBelief>();
  private readonly parcelClaims = new Map<string, string>();
  private readonly observedAt = new Map<string, number>();
  private readonly blockedUntil = new Map<string, number>();
  private parcelDecayMs = 1000;
  private movementMs = 50;
  private sensingDistance = 5;
  private capacity = 5;

  me: SelfState | null = null;
  readonly strategyRules: StrategyRules = {
    forbiddenTiles: [],
    bonusDeliveryTiles: [],
    ignoredDeliveryTiles: []
  };

  get tick(): number {
    return this.tickValue;
  }

  get carryingCapacity(): number {
    return this.capacity;
  }

  /** Ages uncertain beliefs and decays parcel rewards once per reasoning cycle. */
  advanceTick(now = Date.now()): void {
    this.tickValue += 1;
    if (this.me) this.markObserved(this.me.position);

    for (const [id, parcel] of this.parcelById) {
      const elapsed = now - parcel.rewardUpdatedAtMs;
      if (Number.isFinite(this.parcelDecayMs) && elapsed >= this.parcelDecayMs) {
        const decay = Math.floor(elapsed / this.parcelDecayMs);
        parcel.reward = Math.max(0, parcel.reward - decay);
        parcel.rewardUpdatedAtMs += decay * this.parcelDecayMs;
      }
      if (parcel.lastSeenAt < this.tickValue) parcel.confidence *= 0.9;
      if (parcel.reward <= 0 || (parcel.confidence < 0.2 && parcel.carriedBy !== this.me?.id)) {
        this.parcelById.delete(id);
        if (this.me) this.me.carriedParcels = this.me.carriedParcels.filter((parcelId) => parcelId !== id);
      }
    }

    for (const crate of [...this.crateById.values()]) {
      if (this.tickValue - crate.lastSeenAt > CRATE_MEMORY_TICKS) this.crateById.delete(crate.id);
    }

    for (const agent of this.agentById.values()) {
      if (agent.lastSeenAt < this.tickValue) agent.confidence *= 0.8;
    }
  }

  /** Converts server timing and capacity settings into values used by deliberation and planning. */
  observeConfig(raw: unknown): void {
    const config = object(raw);
    const game = object(config.GAME ?? config.game);
    const parcels = object(game.parcels);
    const player = object(game.player);
    const clock = normalizeNumber(config.CLOCK ?? config.clock, 50);
    this.parcelDecayMs = duration(
      parcels.decaying_event ?? parcels.decading_event ?? config.PARCEL_DECADING_INTERVAL ?? config.PARCEL_DECAYING_INTERVAL,
      clock
    );
    this.movementMs = normalizeNumber(player.movement_duration ?? config.MOVEMENT_DURATION, this.movementMs);
    this.sensingDistance = normalizeNumber(player.observation_distance ?? config.OBSERVATION_DISTANCE, this.sensingDistance);
    this.capacity = normalizeNumber(player.capacity ?? config.CAPACITY, this.capacity);
  }

  /** Stores the map used by pathfinding and planning. */
  observeMap(_width: number, _height: number, rawTiles: unknown[]): void {
    for (const raw of rawTiles) {
      const value = object(raw);
      const tile: Tile = {
        x: normalizeNumber(value.x),
        y: normalizeNumber(value.y),
        type: String(value.type ?? (value.delivery ? "2" : "3")) as TileType
      };
      this.tileByPosition.set(positionKey(tile), tile);
    }
  }

  /** Revises the agent's own state and marks the newly visible area as observed. */
  observeSelf(raw: unknown): void {
    const value = object(raw);
    const position = {
      x: coordinate(value.x, this.me?.position.x),
      y: coordinate(value.y, this.me?.position.y)
    };
    this.me = {
      id: String(value.id ?? this.me?.id ?? "me"),
      name: String(value.name ?? this.me?.name ?? "me"),
      position,
      score: normalizeNumber(value.score, this.me?.score),
      penalty: normalizeNumber(value.penalty, this.me?.penalty),
      carriedParcels: this.me?.carriedParcels ?? []
    };
    this.markObserved(position);
  }

  /** Merges parcel sensing into beliefs while preserving local reward-decay timestamps. */
  observeParcels(rawParcels: unknown[]): void {
    const now = Date.now();
    for (const raw of rawParcels) {
      const outer = object(raw);
      const value = object(outer.parcel ?? outer);
      const id = String(value.id ?? outer.id ?? "");
      if (!id) continue;
      const previous = this.parcelById.get(id);
      const reward = normalizeNumber(value.reward ?? outer.reward);
      const parcel: ParcelBelief = {
        id,
        position: {
          x: coordinate(value.x ?? outer.x),
          y: coordinate(value.y ?? outer.y)
        },
        reward,
        carriedBy: value.carriedBy ?? outer.carriedBy ?? null,
        lastSeenAt: this.tickValue,
        rewardUpdatedAtMs: previous?.reward === reward ? previous.rewardUpdatedAtMs : now,
        confidence: 1
      };
      this.parcelById.set(id, parcel);
    }

    if (this.me) {
      const carried = this.parcels().filter((parcel) => parcel.carriedBy === this.me!.id).map((parcel) => parcel.id);
      this.me.carriedParcels = [...new Set([...this.me.carriedParcels, ...carried])];
    }
  }

  /** Reconciles the complete local sensing window; older distant beliefs expire later. */
  observeCrates(rawCrates: unknown[]): void {
    const sensed = rawCrates.flatMap((raw) => {
      const value = object(raw);
      const id = String(value.id ?? "");
      return id ? [{ id, position: { x: coordinate(value.x), y: coordinate(value.y) } }] : [];
    });

    if (this.me) {
      const visiblePositions = new Set(sensed.map((crate) => positionKey(crate.position)));
      for (const [id, crate] of this.crateById) {
        if (
          manhattan(this.me.position, crate.position) <= this.sensingDistance &&
          !visiblePositions.has(positionKey(crate.position))
        ) {
          this.crateById.delete(id);
        }
      }
    }

    for (const { id, position } of sensed) {
      this.crateById.set(id, {
        id,
        position,
        lastSeenAt: this.tickValue
      });
    }
  }

  /** Refreshes dynamic-agent beliefs so pathfinding can temporarily avoid occupied tiles. */
  observeAgents(rawAgents: unknown[]): void {
    for (const raw of rawAgents) {
      const outer = object(raw);
      const value = object(outer.agent ?? outer);
      const id = String(value.id ?? outer.id ?? "");
      if (!id || id === this.me?.id) continue;
      this.agentById.set(id, {
        id,
        name: String(value.name ?? id),
        position: { x: coordinate(value.x ?? outer.x), y: coordinate(value.y ?? outer.y) },
        score: normalizeNumber(value.score),
        penalty: normalizeNumber(value.penalty),
        lastSeenAt: this.tickValue,
        confidence: 1
      });
    }
  }

  /** Applies a pickup immediately and returns ids that were not previously sensed. */
  markPickedUp(ids: string[]): string[] {
    if (!this.me) return [...ids];
    this.me.carriedParcels = [...new Set([...this.me.carriedParcels, ...ids])];
    const unknown: string[] = [];
    for (const id of ids) {
      const parcel = this.parcelById.get(id);
      if (parcel) parcel.carriedBy = this.me.id;
      else unknown.push(id);
    }
    return unknown;
  }

  /** Removes stale targets after the server confirms that nothing was available to pick up. */
  markPickupFailed(ids: string[] = []): void {
    for (const id of ids) this.parcelById.delete(id);
  }

  /** Clears carried beliefs after delivery so the next cycle can pursue new parcels. */
  markPutdown(): void {
    if (!this.me) return;
    for (const id of this.me.carriedParcels) this.parcelById.delete(id);
    this.me.carriedParcels = [];
  }

  parcels(): ParcelBelief[] {
    return [...this.parcelById.values()];
  }

  agents(): AgentBelief[] {
    return [...this.agentById.values()];
  }

  crates(): CrateBelief[] {
    return [...this.crateById.values()];
  }

  tiles(): Tile[] {
    return [...this.tileByPosition.values()];
  }

  /** Reports whether a crate currently occupies a tile, making it impassable without a push. */
  hasCrate(position: Position): boolean {
    return [...this.crateById.values()].some((crate) => samePosition(crate.position, position));
  }

  crateAt(position: Position): CrateBelief | undefined {
    return [...this.crateById.values()].find((crate) => samePosition(crate.position, position));
  }

  /** True for the type-`5` tiles a crate can legally be shoved onto. */
  isCrateArea(position: Position): boolean {
    return CRATE_AREA_TILES.has(this.tileByPosition.get(positionKey(position))?.type ?? "0");
  }

  /** Exposes legal delivery destinations after persistent mission rules are applied. */
  deliveryTiles(): Position[] {
    return this.tiles()
      .filter((tile) => tile.type === "2")
      .map(({ x, y }) => ({ x, y }))
      .filter((position) =>
        this.strategyRules.ignoredDeliveryTiles.every((ignored) => !samePosition(ignored, position))
      );
  }

  /** Lists parcel-spawning tiles that exploration may revisit to obtain fresh observations. */
  spawnTiles(): Position[] {
    return this.tiles().filter((tile) => tile.type === "1").map(({ x, y }) => ({ x, y }));
  }

  /** Exposes the currently legal map area to mission-specific target selectors. */
  walkableTiles(): Position[] {
    return this.tiles()
      .filter((tile) => WALKABLE_TILES.has(tile.type))
      .map(({ x, y }) => ({ x, y }))
      .filter(
        (position) =>
          this.strategyRules.forbiddenTiles.every((tile) => !samePosition(tile, position)) &&
          !this.isTemporarilyBlocked(position) &&
          !this.hasCrate(position)
      );
  }

  /** Returns viable, sufficiently certain, unclaimed parcels lying on the ground. */
  reachableParcels(): ParcelBelief[] {
    return this.parcels().filter((parcel) => {
      if (parcel.reward <= 0 || parcel.confidence < 0.25 || parcel.carriedBy) return false;
      if (this.strategyRules.maxDeliverableReward && parcel.reward > this.strategyRules.maxDeliverableReward) return false;
      const claim = this.parcelClaims.get(parcel.id);
      return !claim || claim === this.me?.id;
    });
  }

  /** Resolves carried ids back to beliefs so reward predictions retain parcel details. */
  carriedParcelBeliefs(): ParcelBelief[] {
    const ids = new Set(this.me?.carriedParcels ?? []);
    return this.parcels().filter((parcel) => ids.has(parcel.id));
  }

  /** Finds the sensed ids used to reconcile Deliveroo pickup replies that omit private ids. */
  pickupableParcelsAt(position: Position): ParcelBelief[] {
    return this.reachableParcels().filter((parcel) => samePosition(parcel.position, position));
  }

  /** Records teammate commitments so the agents avoid competing for the same parcel. */
  claimParcel(parcelId: string, agentId: string): void {
    this.parcelClaims.set(parcelId, agentId);
  }

  /** Predicts reward at arrival so agents reject routes whose parcels decay before delivery. */
  rewardAfterTravel(parcel: ParcelBelief, steps: number, tickMs: number, extraActions = 1): number {
    if (!Number.isFinite(this.parcelDecayMs)) return parcel.reward;
    const elapsed = steps * (this.movementMs + tickMs) + extraActions * tickMs;
    return Math.max(0, parcel.reward - Math.ceil(elapsed / this.parcelDecayMs));
  }

  /** Estimates the future value of the whole carried stack for pickup-versus-deliver decisions. */
  totalCarriedRewardAfterSteps(steps: number, tickMs: number, extraActions = 1): number {
    return this.carriedParcelBeliefs().reduce(
      (total, parcel) => total + this.rewardAfterTravel(parcel, steps, tickMs, extraActions),
      0
    );
  }

  /** Combines A* distance and decay prediction to validate a proposed delivery intention. */
  totalCarriedRewardAfterTravel(target: Position, tickMs: number, throughCrates = false): number {
    if (!this.me) return 0;
    const steps = throughCrates
      ? this.shortestRouteDistance(this.me.position, target, false)
      : this.shortestPathDistance(this.me.position, target, false);
    return steps === null ? 0 : this.totalCarriedRewardAfterSteps(steps, tickMs);
  }

  /** Checks static rules, mission restrictions, and temporary obstacles. */
  isWalkable(position: Position, avoidAgents = true): boolean {
    return this.isPassable(position, avoidAgents, false);
  }

  /** Checks the optimistic graph used to identify which crate blocks a route. */
  isWalkableIgnoringCrates(position: Position, avoidAgents = true): boolean {
    return this.isPassable(position, avoidAgents, true);
  }

  private isPassable(position: Position, avoidAgents: boolean, ignoreCrates: boolean): boolean {
    if (this.strategyRules.forbiddenTiles.some((tile) => samePosition(tile, position))) return false;
    if (this.isTemporarilyBlocked(position)) return false;
    if (!WALKABLE_TILES.has(this.tileByPosition.get(positionKey(position))?.type ?? "0")) return false;
    if (!ignoreCrates && this.hasCrate(position)) return false;
    return (
      !avoidAgents ||
      ![...this.agentById.values()].some(
        (agent) => agent.confidence > 0.5 && samePosition(agent.position, position)
      )
    );
  }

  /** Reports whether a tile is still inside its temporary block window, discarding expired entries. */
  private isTemporarilyBlocked(position: Position): boolean {
    const key = positionKey(position);
    const blockedUntil = this.blockedUntil.get(key);
    if (blockedUntil === undefined) return false;
    if (blockedUntil <= Date.now()) {
      this.blockedUntil.delete(key);
      return false;
    }
    return true;
  }

  /** Checks a single graph edge, including the one-way constraint of arrow tiles. */
  canMove(from: Position, to: Position, avoidAgents = true): boolean {
    return this.canTraverse(from, to, avoidAgents, false);
  }

  /** Edge check on the optimistic graph where crates are treated as passable. */
  canMoveIgnoringCrates(from: Position, to: Position, avoidAgents = true): boolean {
    return this.canTraverse(from, to, avoidAgents, true);
  }

  private canTraverse(from: Position, to: Position, avoidAgents: boolean, ignoreCrates: boolean): boolean {
    if (manhattan(from, to) !== 1 || !this.isPassable(to, avoidAgents, ignoreCrates)) return false;
    return allowsEntry({ x: to.x - from.x, y: to.y - from.y }, this.tileByPosition.get(positionKey(to))?.type);
  }

  /** Returns where a crate would land after a legal push, or null. */
  cratePushDestination(from: Position, crate: Position): Position | null {
    if (manhattan(from, crate) !== 1) return null;
    const destination = { x: crate.x + (crate.x - from.x), y: crate.y + (crate.y - from.y) };
    if (!this.isCrateArea(destination) || !this.isWalkable(destination, false)) return null;
    return destination;
  }

  /** Uses the shared A* implementation as the distance oracle for scoring and target selection. */
  shortestPathDistance(from: Position, to: Position, avoidAgents = true): number | null {
    const path = new Pathfinder(this).findPath(from, to, avoidAgents);
    return path ? path.length - 1 : null;
  }

  /** Finds a distance while treating crates as movable when necessary. */
  shortestRouteDistance(from: Position, to: Position, avoidAgents = true): number | null {
    const direct = this.shortestPathDistance(from, to, avoidAgents);
    if (direct !== null) return direct;
    const path = new Pathfinder(this).findPathThroughCrates(from, to, avoidAgents);
    return path ? path.length - 1 : null;
  }

  /** Finds the cheapest reachable delivery tile for courier heuristics and mission tools. */
  nearestDeliveryWithDistance(from: Position, throughCrates = false): { position: Position; distance: number } | null {
    const candidates = this.deliveryTiles().flatMap((position) => {
      const distance = throughCrates
        ? this.shortestRouteDistance(from, position, false)
        : this.shortestPathDistance(from, position, false);
      return distance === null ? [] : [{ position, distance }];
    });
    return candidates.sort((a, b) => a.distance - b.distance)[0] ?? null;
  }

  /** Chooses an old or unseen spawn area to refresh parcel beliefs when no task is profitable. */
  explorationTarget(throughCrates = false): Position | null {
    if (!this.me) return null;
    let targets = this.explorationCandidates(this.spawnTiles(), throughCrates);
    // A crate maze may place the agent in a section with no optimistic path to a spawner.
    // Exploring another stale map tile is still useful: it refreshes crate beliefs and can
    // expose a pushable passage instead of committing to wait forever.
    if (targets.length === 0 && throughCrates && this.crates().length > 0) {
      targets = this.explorationCandidates(this.walkableTiles(), true);
    }
    const stale = targets.filter((target) => target.age > 20);
    if (stale.length > 0) return stale.sort((a, b) => b.age - a.age || a.distance - b.distance)[0]!.position;
    if (this.tickValue <= 20) return null;
    return targets.sort((a, b) => a.distance - b.distance)[0]?.position ?? null;
  }

  /** Scores possible exploration destinations using either the real or optimistic graph. */
  private explorationCandidates(positions: Position[], throughCrates: boolean): Array<{
    position: Position;
    age: number;
    distance: number;
  }> {
    return positions.flatMap((position) => {
      if (samePosition(this.me!.position, position)) return [];
      const distance = throughCrates
        ? this.shortestRouteDistance(this.me!.position, position, false)
        : this.shortestPathDistance(this.me!.position, position, false);
      if (distance === null) return [];
      const lastObserved = this.observedAt.get(positionKey(position));
      const age = lastObserved === undefined ? Infinity : this.tickValue - lastObserved;
      return [{ position, age, distance }];
    });
  }

  /** Temporarily removes a failed movement destination so the next A* call can route around it. */
  markTileBlocked(position: Position, milliseconds = 2000): void {
    this.blockedUntil.set(positionKey(position), Date.now() + milliseconds);
  }

  /** Stores a persistent stack-size mission constraint used by both courier policies. */
  setRequiredStackSize(size: number): void {
    this.strategyRules.requiredStackSize = size;
  }

  /** Applies a planned crate push before the next sensing update arrives. */
  markCratePushed(from: Position, to: Position): void {
    const crate = this.crateAt(from);
    if (!crate) return;
    crate.position = { x: to.x, y: to.y };
    crate.lastSeenAt = this.tickValue;
  }

  /** Adds a mission-level obstacle to the graph shared by A* and PDDL. */
  addForbiddenTile(position: Position): void {
    if (!this.strategyRules.forbiddenTiles.some((tile) => samePosition(tile, position))) {
      this.strategyRules.forbiddenTiles.push(position);
    }
  }

  /** Records a reward multiplier that changes delivery option scoring. */
  addBonusDeliveryTile(position: Position, multiplier: number): void {
    this.strategyRules.bonusDeliveryTiles.push({ position, multiplier });
  }

  /** Removes a mission-forbidden destination from future delivery choices. */
  addIgnoredDeliveryTile(position: Position): void {
    this.strategyRules.ignoredDeliveryTiles.push(position);
  }

  /** Stores the reward ceiling imposed by a persistent strategy mission. */
  setMaxDeliverableReward(max: number): void {
    this.strategyRules.maxDeliverableReward = max;
  }

  /** Looks up the mission multiplier used while ranking a delivery intention. */
  bonusForDelivery(position: Position): BonusDeliveryTile | undefined {
    return this.strategyRules.bonusDeliveryTiles.find((bonus) => samePosition(bonus.position, position));
  }

  /** Freezes the relevant beliefs into the smaller state consumed by the PDDL problem generator. */
  plannerSnapshot(): PlannerWorldSnapshot | null {
    // The planner has to deliver the whole stack, so it is given the carried parcels
    // explicitly: reachableParcels() deliberately excludes them.
    return this.me
      ? {
          me: this.me,
          tiles: this.tiles(),
          parcels: [...this.carriedParcelBeliefs(), ...this.reachableParcels()],
          crates: this.crates(),
          forbiddenTiles: this.strategyRules.forbiddenTiles
        }
      : null;
  }

  /** Tracks which spawn tiles fall inside the sensing radius to drive later exploration. */
  private markObserved(position: Position): void {
    for (const tile of this.tileByPosition.values()) {
      if (manhattan(position, tile) <= this.sensingDistance) this.observedAt.set(positionKey(tile), this.tickValue);
    }
  }
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function coordinate(value: unknown, fallback = 0): number {
  return Math.round(normalizeNumber(value, fallback));
}

/** Parses Deliveroo's human-readable timing values for reward prediction and belief aging. */
function duration(value: unknown, frameMs: number): number {
  if (typeof value === "number") return value;
  const text = String(value ?? "1s").toLowerCase();
  if (text === "infinite") return Infinity;
  if (text === "frame") return frameMs;
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!match) return 1000;
  const amount = Number(match[1]);
  return amount * (match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1000 : 1);
}

import { describe, expect, it, vi } from "vitest";
import type { Intention } from "../src/common/types.js";
import { WorldModel } from "../src/common/world-model.js";
import { generateOptions, intentionStillValid } from "../src/bdi/strategy.js";

describe("WorldModel", () => {
  it("decays stale parcel beliefs", () => {
    const world = new WorldModel();
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([{ id: "p1", x: 1, y: 1, reward: 10 }]);
    expect(world.parcels()[0]?.confidence).toBe(1);
    world.advanceTick();
    world.advanceTick();
    expect(world.parcels()[0]?.confidence).toBeLessThan(1);
  });

  it("rounds continuous server coordinates to grid tiles", () => {
    const world = new WorldModel();
    world.observeSelf({ id: "me", x: 1.6, y: 2.4 });
    world.observeAgents([{ id: "other", x: 3.7, y: 4.2 }]);
    world.observeParcels([{ id: "p1", x: 5.8, y: 6.1, reward: 10 }]);

    expect(world.me?.position).toEqual({ x: 2, y: 2 });
    expect(world.agents()[0]?.position).toEqual({ x: 4, y: 4 });
    expect(world.parcels()[0]?.position).toEqual({ x: 6, y: 6 });
  });

  it("does not chase spawn tiles already covered by observation radius", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 5 } } });
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    expect(world.explorationTarget()).toBeNull();
  });

  it("revisits a spawning tile instead of idling forever", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 5 } } });
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });

    for (let i = 0; i < 25; i += 1) world.advanceTick();

    expect(world.explorationTarget()).toEqual({ x: 2, y: 0 });
  });

  it("explores the nearest unseen spawning tile", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 2 } } });
    world.observeMap(10, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "3" },
      { x: 3, y: 0, type: "3" },
      { x: 4, y: 0, type: "3" },
      { x: 5, y: 0, type: "3" },
      { x: 6, y: 0, type: "3" },
      { x: 7, y: 0, type: "1" },
      { x: 8, y: 0, type: "1" },
      { x: 9, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    expect(world.explorationTarget()).toEqual({ x: 7, y: 0 });
  });

  it("does not select the current tile as an exploration destination", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 0 } } });
    world.observeMap(2, 1, [
      { x: 0, y: 0, type: "1" },
      { x: 1, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", x: 0, y: 0 });
    for (let i = 0; i < 25; i += 1) world.advanceTick();

    expect(world.explorationTarget()).toEqual({ x: 1, y: 0 });
  });

  it("keeps crate-blocked spawn tiles available for crate-aware deliberation", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 1 } } });
    world.observeMap(3, 3, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "5" },
      { x: 0, y: 1, type: "3" },
      { x: 1, y: 1, type: "5!" },
      { x: 2, y: 1, type: "1" },
      { x: 1, y: 2, type: "5" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 1, score: 0 });
    world.observeCrates([{ id: "crate", x: 1, y: 1 }]);

    expect(world.explorationTarget()).toBeNull();
    expect(world.explorationTarget(true)).toEqual({ x: 2, y: 1 });
  });

  it("removes a remembered crate when its visible tile is sensed empty", () => {
    const world = new WorldModel();
    world.observeConfig({ GAME: { player: { observation_distance: 2 } } });
    world.observeSelf({ id: "me", x: 0, y: 0 });
    world.observeCrates([
      { id: "near", x: 1, y: 0 },
      { id: "far", x: 4, y: 0 }
    ]);

    world.observeCrates([]);

    expect(world.crates().map((crate) => crate.id)).toEqual(["far"]);
  });

  it("keeps out-of-view crate memory bounded", () => {
    const world = new WorldModel();
    world.observeCrates([{ id: "crate", x: 4, y: 0 }]);

    for (let i = 0; i < 200; i += 1) world.advanceTick();
    expect(world.crates()).toHaveLength(1);
    world.advanceTick();

    expect(world.crates()).toHaveLength(0);
  });

  it("expires parcels using the configured decay interval", () => {
    const world = new WorldModel();
    world.observeConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: "1s" }, player: { movement_duration: 50 } } });
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([{ id: "p1", x: 1, y: 1, reward: 2 }]);
    const seenAt = world.parcels()[0]?.rewardUpdatedAtMs ?? Date.now();

    world.advanceTick(seenAt + 2500);

    expect(world.parcels()).toHaveLength(0);
  });

  it("does not select a parcel that cannot be delivered before decay", () => {
    const world = new WorldModel();
    world.observeConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: "1s" }, player: { movement_duration: 50 } } });
    world.observeMap(5, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "1" },
      { x: 2, y: 0, type: "3" },
      { x: 3, y: 0, type: "3" },
      { x: 4, y: 0, type: "2" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([{ id: "p1", x: 1, y: 0, reward: 1 }]);

    expect(generateOptions(world, 350).some((option) => option.kind === "pickup")).toBe(false);
  });

  it("prefers picking a nearby second parcel while carrying when the stacked route is valuable", () => {
    const world = new WorldModel();
    world.observeConfig({
      CLOCK: 50,
      GAME: { parcels: { decaying_event: "1s" }, player: { movement_duration: 50, capacity: 5 } }
    });
    world.observeMap(4, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "1" },
      { x: 2, y: 0, type: "3" },
      { x: 3, y: 0, type: "2" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([
      { id: "carried", x: 0, y: 0, reward: 30, carriedBy: "me" },
      { id: "nearby", x: 1, y: 0, reward: 20 }
    ]);

    const options = generateOptions(world, 50);

    expect(options[0]?.kind).toBe("pickup");
    expect(options[0]?.parcel?.id).toBe("nearby");
  });

  it("reports pickupable parcels at the current tile", () => {
    const world = new WorldModel();
    world.observeSelf({ id: "me", name: "me", x: 1, y: 0, score: 0 });
    world.observeParcels([
      { id: "carried", x: 1, y: 0, reward: 10, carriedBy: "me" },
      { id: "here", x: 1, y: 0, reward: 10 },
      { id: "elsewhere", x: 2, y: 0, reward: 10 }
    ]);

    expect(world.pickupableParcelsAt({ x: 1, y: 0 }).map((parcel) => parcel.id)).toEqual(["here"]);
  });

  it("invalidates delivery intentions when carried parcels will expire before drop", () => {
    const world = new WorldModel();
    world.observeConfig({ CLOCK: 50, GAME: { parcels: { decaying_event: "1s" }, player: { movement_duration: 50 } } });
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "2" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([{ id: "p1", x: 0, y: 0, reward: 1, carriedBy: "me" }]);
    const intention: Intention = {
      id: "deliver-test",
      kind: "deliver",
      target: { x: 2, y: 0 },
      priority: 1,
      createdAt: 0,
      reason: "test"
    };

    expect(intentionStillValid(world, intention, 350)).toBe(false);
  });

  it("keeps carried parcels out of reachableParcels but still hands them to the planner", () => {
    const world = new WorldModel();
    world.observeMap(3, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "3" },
      { x: 2, y: 0, type: "2" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([
      { id: "carried", x: 0, y: 0, reward: 10, carriedBy: "me" },
      { id: "theirs", x: 1, y: 0, reward: 10, carriedBy: "other" },
      { id: "ground", x: 1, y: 0, reward: 10 }
    ]);

    // Only parcels still on the ground are things the agent could go and pick up.
    expect(world.reachableParcels().map((parcel) => parcel.id)).toEqual(["ground"]);
    expect(world.pickupableParcelsAt({ x: 0, y: 0 })).toEqual([]);
    expect(world.carriedParcelBeliefs().map((parcel) => parcel.id)).toEqual(["carried"]);

    // The PDDL bridge must still see the carried stack, otherwise plans would not deliver it.
    expect(world.plannerSnapshot()?.parcels.map((parcel) => parcel.id)).toEqual(["carried", "ground"]);
  });

  it("forgets a parcel after an empty pickup result", () => {
    const world = new WorldModel();
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeParcels([{ id: "p1", x: 0, y: 0, reward: 10 }]);

    world.markPickupFailed(["p1"]);

    expect(world.parcels()).toHaveLength(0);
    expect(world.me?.carriedParcels).toEqual([]);
  });

  describe("temporarily blocked tiles", () => {
    const buildWorld = (): WorldModel => {
      const world = new WorldModel();
      world.observeMap(3, 1, [
        { x: 0, y: 0, type: "3" },
        { x: 1, y: 0, type: "3" },
        { x: 2, y: 0, type: "3" }
      ]);
      world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
      return world;
    };

    it("treats a blocked tile as not walkable so the pathfinder routes around it", () => {
      const world = buildWorld();
      expect(world.isWalkable({ x: 1, y: 0 }, false)).toBe(true);

      world.markTileBlocked({ x: 1, y: 0 });

      expect(world.isWalkable({ x: 1, y: 0 }, false)).toBe(false);
      expect(world.canMove({ x: 0, y: 0 }, { x: 1, y: 0 }, false)).toBe(false);
      expect(world.walkableTiles()).not.toContainEqual({ x: 1, y: 0 });
    });

    it("stops blocking once the TTL expires", () => {
      vi.useFakeTimers();
      const world = buildWorld();
      world.markTileBlocked({ x: 1, y: 0 }, 1);

      expect(world.isWalkable({ x: 1, y: 0 }, false)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(world.isWalkable({ x: 1, y: 0 }, false)).toBe(true);
      vi.useRealTimers();
    });
  });
});

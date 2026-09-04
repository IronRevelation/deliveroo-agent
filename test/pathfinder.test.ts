import { describe, expect, it } from "vitest";
import { Pathfinder } from "../src/common/pathfinder.js";
import { WorldModel } from "../src/common/world-model.js";

describe("Pathfinder", () => {
  it("finds a path around walls", () => {
    const world = new WorldModel();
    world.observeMap(3, 3, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "0" },
      { x: 2, y: 0, type: "3" },
      { x: 0, y: 1, type: "3" },
      { x: 1, y: 1, type: "3" },
      { x: 2, y: 1, type: "3" },
      { x: 0, y: 2, type: "3" },
      { x: 1, y: 2, type: "3" },
      { x: 2, y: 2, type: "3" }
    ]);
    const path = new Pathfinder(world).findPath({ x: 0, y: 0 }, { x: 2, y: 0 });
    expect(path?.map((p) => `${p.x},${p.y}`)).toEqual(["0,0", "0,1", "1,1", "2,1", "2,0"]);
  });

  it("does not path into an occupied goal tile", () => {
    const world = new WorldModel();
    world.observeMap(2, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    world.observeAgents([{ id: "other", name: "other", x: 1, y: 0, score: 0 }]);

    expect(new Pathfinder(world).findPath({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { reviseIntention } from "../src/bdi/intentions.js";
import type { BdiOption } from "../src/bdi/strategy.js";
import type { Intention } from "../src/common/types.js";
import { WorldModel } from "../src/common/world-model.js";

describe("intention revision", () => {
  it("leaves a wait intention when sensing reveals useful work", () => {
    const world = new WorldModel();
    world.observeMap(2, 1, [
      { x: 0, y: 0, type: "3" },
      { x: 1, y: 0, type: "1" }
    ]);
    world.observeSelf({ id: "me", name: "me", x: 0, y: 0, score: 0 });
    const current: Intention = {
      id: "wait",
      kind: "wait",
      priority: -1,
      createdAt: 1,
      reason: "no work was visible"
    };
    const selected: BdiOption = {
      kind: "explore",
      target: { x: 1, y: 0 },
      score: -0.1,
      reason: "a target became visible"
    };

    const revision = reviseIntention(world, current, selected);

    expect(revision.changed).toBe(true);
    expect(revision.reason).toBe("work-became-available");
    expect(revision.intention.kind).toBe("explore");
  });
});

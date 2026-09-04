import { describe, expect, it } from "vitest";
import { parseParcelActionResult } from "../src/common/deliveroo-client-adapter.js";

describe("parseParcelActionResult", () => {
  it("returns the parcel count and any available ids", () => {
    expect(parseParcelActionResult([{ id: "p1" }, { parcel: { id: "p2" } }])).toEqual({
      ids: ["p1", "p2"],
      count: 2
    });
    expect(parseParcelActionResult([{ reward: 10 }])).toEqual({ ids: [], count: 1 });
  });
});

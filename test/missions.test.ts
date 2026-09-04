import { describe, expect, it } from "vitest";
import { evaluateArithmetic, hasExplicitNegativeUtility } from "../src/llm/missions.js";

describe("mission tools", () => {
  it("evaluates arithmetic safely", () => {
    expect(evaluateArithmetic("5*5")).toBe(25);
    expect(evaluateArithmetic("4*2 + (1+3)*3")).toBe(20);
    expect(() => evaluateArithmetic("process.exit()")).toThrow();
  });

  it("detects explicit negative action utility without rejecting avoidance rules", () => {
    expect(hasExplicitNegativeUtility("Move to (4,7) and get -10 points")).toBe(true);
    expect(hasExplicitNegativeUtility("Step onto (1,1) even though doing so costs 25 points")).toBe(true);
    expect(hasExplicitNegativeUtility("Accept a penalty of 50 points for moving left")).toBe(true);
    expect(hasExplicitNegativeUtility("Do not enter (1,1), otherwise you lose 50 points")).toBe(false);
    expect(hasExplicitNegativeUtility("Move to (4,7) to receive 10 points")).toBe(false);
  });
});

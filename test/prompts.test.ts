import { describe, expect, it } from "vitest";
import {
  buildCourierPrompt,
  buildMissionPrompt,
  COURIER_TOOL_NAMES,
  LLM_COURIER_SYSTEM_PROMPT,
  LLM_SYSTEM_PROMPT
} from "../src/llm/prompts.js";

describe("LLM prompts", () => {
  it("keeps mission-only tools out of ordinary courier decisions", () => {
    for (const tool of ["move_to_leftmost_delivery", "move_to_odd_row", "set_strategy_rule", "coordinate", "plan_delivery"]) {
      expect(LLM_COURIER_SYSTEM_PROMPT).not.toContain(tool);
      expect(LLM_SYSTEM_PROMPT).toContain(tool);
    }
    for (const tool of COURIER_TOOL_NAMES) expect(LLM_SYSTEM_PROMPT).toContain(tool);
    expect(LLM_SYSTEM_PROMPT).not.toContain("putdown_here");
  });

  it("puts only the currently available tools in each prompt", () => {
    const courier = buildCourierPrompt({}, ["move_to", "get_visible_parcels"]);
    const mission = buildMissionPrompt("Deliver exactly 3 parcels", {}, ["get_my_position", "set_strategy_rule"]);

    expect(courier).toContain('["move_to","get_visible_parcels"]');
    expect(courier).not.toContain("deliver_here");
    expect(mission).toContain('["get_my_position","set_strategy_rule"]');
    expect(mission).not.toContain("plan_delivery");
  });
});

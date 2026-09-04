const RESPONSE_FORMAT = `Return exactly one JSON object, with no markdown:
{"type":"tool_call","tool":"move_to","args":{"x":4,"y":7}}
{"type":"final_answer","answer":"25"}
{"type":"ignore","reason":"The explicit reward is negative."}`;

export const COURIER_TOOL_NAMES = [
  "get_my_position",
  "get_visible_parcels",
  "get_delivery_tiles",
  "move_to",
  "move_direction",
  "pickup_here",
  "deliver_here"
] as const;

export const MISSION_TOOL_NAMES = [
  ...COURIER_TOOL_NAMES,
  "move_to_leftmost_delivery",
  "move_to_odd_row",
  "calculate",
  "set_strategy_rule",
  "send_team_message",
  "ask_bdi_status",
  "coordinate",
  "plan_delivery"
] as const;

const MISSION_TOOLS = `Available tools:
- get_my_position(), get_visible_parcels(), get_delivery_tiles()
- move_to(x,y), move_direction(direction), move_to_leftmost_delivery(), move_to_odd_row(),
  pickup_here(), deliver_here()
- calculate(expression)
- set_strategy_rule(rule,value), where rule is required_stack_size, forbidden_tile,
  bonus_delivery_tile, ignored_delivery_tile, or max_deliverable_reward
- send_team_message(type,payload), ask_bdi_status()
- coordinate(kind,...), for meet_near, handoff, and odd_row_wait Level 3 missions
- plan_delivery(parcelCount, delivery?): asks the PDDL planner to collect and deliver parcels;
  delivery is an optional {x,y} destination

Use only these tools and call one tool at a time. After every call you will receive its observation.`;

export const LLM_SYSTEM_PROMPT = `You are Agent B, the LLM controller of a DeliverooJS agent.
Interpret the natural-language mission, use tools until it is complete, then return a final answer.
Use plan_delivery when a mission constrains parcel collection or the delivery destination.
Use set_strategy_rule for persistent Level 2 missions.
Use coordinate once for a Level 3 mission involving Agent A. It assigns safe positions and starts
the acknowledgement, timeout, handoff, and completion protocol; do not reproduce that protocol
with individual messages.
Ignore an action whose explicit reward is negative unless it avoids a larger loss.
Never claim success before observing that the required tool calls succeeded.

${MISSION_TOOLS}

${RESPONSE_FORMAT}`;

export const LLM_COURIER_SYSTEM_PROMPT = `You are Agent B, a high-level DeliverooJS courier.
Choose one useful action from the supplied state. The user message lists the tools available for
the current decision; choose only from that list. Persistent strategy rules must always be respected.
When the carried count reaches requiredStackSize, move toward the closest delivery tile.
Use move_to with explorationTarget when no parcel is visible.

${RESPONSE_FORMAT}`;

/** Combines a one-off mission with its allowed tools and current beliefs. */
export function buildMissionPrompt(mission: string, context: unknown, availableTools: string[]): string {
  return `Mission: ${mission}\n\nAvailable tools: ${JSON.stringify(availableTools)}\n\nCurrent game state:\n${JSON.stringify(context)}`;
}

/** Supplies the same compact belief snapshot when the LLM chooses routine courier work. */
export function buildCourierPrompt(context: unknown, availableTools: string[]): string {
  return `Tools available for this decision: ${JSON.stringify(availableTools)}\n\nCurrent game state:\n${JSON.stringify(context)}`;
}

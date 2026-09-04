import { describe, expect, it, vi } from "vitest";
import { CommunicationAdapter } from "../src/common/communication.js";
import type { DeliverooClientAdapter } from "../src/common/deliveroo-client-adapter.js";
import type { Logger } from "../src/common/logger.js";
import type { TeamMessage } from "../src/common/types.js";

describe("team communication", () => {
  it("sends and receives validated JSON messages", async () => {
    let receive: ((value: { from?: string; message: string }) => void) | undefined;
    const client = {
      onMessage: vi.fn((handler) => {
        receive = handler;
      }),
      sendTeamMessage: vi.fn()
    } as unknown as DeliverooClientAdapter;
    const logger = { event: vi.fn() } as unknown as Logger;
    const communication = new CommunicationAdapter(client, logger, "agent-a");

    await communication.send({ type: "eta", to: "agent-b", payload: { turns: 2 } });
    expect(client.sendTeamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: "agent-a", to: "agent-b", type: "eta" })
    );

    const incoming: TeamMessage = {
      from: "agent-b",
      to: "agent-a",
      type: "mission_request",
      payload: { kind: "meet_near" },
      timestamp: 1
    };
    receive?.({ from: "socket-b", message: `TEAMMSG ${JSON.stringify(incoming)}` });
    expect(communication.drain()).toEqual([incoming]);
  });
});

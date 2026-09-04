import { z } from "zod";
import type { DeliverooClientAdapter } from "./deliveroo-client-adapter.js";
import type { Logger } from "./logger.js";
import { TEAM_MESSAGE_TYPES, type TeamMessage } from "./types.js";

const TeamMessageSchema = z.object({
  from: z.string(),
  to: z.string().optional(),
  type: z.enum(TEAM_MESSAGE_TYPES),
  payload: z.record(z.string(), z.unknown()),
  timestamp: z.number()
});

/** Adds a small typed team protocol on top of Deliveroo's unstructured shout messages. */
export class CommunicationAdapter {
  private inbound: TeamMessage[] = [];

  /** Attaches the protocol parser once so reasoning cycles only handle validated messages. */
  constructor(
    private readonly client: DeliverooClientAdapter,
    private readonly logger: Logger,
    private readonly selfName: string
  ) {
    this.client.onMessage(({ from, message }) => this.handleRawMessage(from, message));
  }

  /** Adds protocol metadata before broadcasting a message to the other agent. */
  async send(message: Omit<TeamMessage, "from" | "timestamp">): Promise<void> {
    const full: TeamMessage = {
      ...message,
      from: this.selfName,
      timestamp: Date.now()
    };
    await this.client.sendTeamMessage(full);
  }

  /** Hands queued messages to the current reasoning cycle and clears the inbox. */
  drain(): TeamMessage[] {
    const messages = this.inbound;
    this.inbound = [];
    return messages;
  }

  /** Filters, validates, and queues only team-protocol messages addressed to this agent. */
  private handleRawMessage(from: string | undefined, raw: string): void {
    const prefix = "TEAMMSG ";
    if (!raw.startsWith(prefix)) return;
    try {
      const parsed = TeamMessageSchema.parse(JSON.parse(raw.slice(prefix.length)));
      if (parsed.from === this.selfName) return;
      if (parsed.to && parsed.to !== this.selfName) return;
      this.inbound.push(parsed);
      this.logger.event("message_received", { from, message: parsed });
    } catch (error) {
      this.logger.event("message_parse_failed", { from, raw, error: String(error) });
    }
  }
}

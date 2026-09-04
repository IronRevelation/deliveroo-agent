import type { AgentConfig } from "../common/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Keeps OpenAI-compatible HTTP details outside Agent B's reasoning loop. */
export class LiteLlmClient {
  constructor(private readonly config: AgentConfig) {}

  /** Requests one deterministic controller decision for the current prompt and observations. */
  async complete(messages: ChatMessage[]): Promise<string> {
    if (!this.config.liteLlmApiKey) {
      throw new Error("LITELLM_API_KEY is missing");
    }
    const response = await fetch(`${this.config.liteLlmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.liteLlmApiKey}`
      },
      body: JSON.stringify({
        model: this.config.liteLlmModel,
        temperature: 0,
        messages
      })
    });

    if (!response.ok) {
      throw new Error(`LiteLLM request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as any;
    return String(data.choices?.[0]?.message?.content ?? "");
  }
}

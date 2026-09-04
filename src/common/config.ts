import "dotenv/config";
import { z } from "zod";
import type { AgentConfig } from "./types.js";

const EnvSchema = z.object({
  DELIVEROOJS_URL: z.string().default("http://localhost:8080"),
  TOKEN_AGENT_A: z.string().default(""),
  TOKEN_AGENT_B: z.string().default(""),
  LITELLM_BASE_URL: z.string().default("https://llm.bears.disi.unitn.it/v1"),
  LITELLM_API_KEY: z.string().default(""),
  LITELLM_MODEL: z.string().default("llama-3.3-70b-lmstudio"),
  PYPERPLAN_BIN: z.string().default(".venv/bin/pyperplan"),
  PDDL_ENABLED: z
    .string()
    .default("true")
    .transform((value) => !["0", "false", "no", "off"].includes(value.toLowerCase())),
  AGENT_TICK_MS: z.coerce.number().int().positive().default(350),
  AGENT_B_TARGET_STACK: z.coerce.number().int().positive().default(3),
  LOG_DIR: z.string().default("logs")
});

/** Validates environment variables once and gives both agents one shared runtime configuration. */
export function loadConfig(): AgentConfig {
  const env = EnvSchema.parse(process.env);
  return {
    deliverooUrl: env.DELIVEROOJS_URL,
    tokenAgentA: env.TOKEN_AGENT_A,
    tokenAgentB: env.TOKEN_AGENT_B,
    liteLlmBaseUrl: env.LITELLM_BASE_URL,
    liteLlmApiKey: env.LITELLM_API_KEY,
    liteLlmModel: env.LITELLM_MODEL,
    pyperplanBin: env.PYPERPLAN_BIN,
    pddlEnabled: env.PDDL_ENABLED,
    agentTickMs: env.AGENT_TICK_MS,
    agentBTargetStack: env.AGENT_B_TARGET_STACK,
    logDir: env.LOG_DIR
  };
}

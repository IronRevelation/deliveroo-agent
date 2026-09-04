import { loadConfig } from "../common/config.js";
import { BdiAgent } from "../bdi/agentA.js";
import { LlmAgent } from "../llm/agentB.js";

const config = loadConfig();
const agentA = new BdiAgent(config);
const agentB = new LlmAgent(config);

// A single signal stops both reasoning loops so local experiments do not leave connected agents behind.
process.on("SIGINT", () => {
  agentA.stop();
  agentB.stop();
  process.exit(0);
});

await Promise.all([
  agentA.start().catch((error) => {
    agentB.stop();
    throw error;
  }),
  agentB.start().catch((error) => {
    agentA.stop();
    throw error;
  })
]);

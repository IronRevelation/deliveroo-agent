# Deliveroo Autonomous Agents

Two agents for the Deliveroo.js project:

- Agent A: BDI agent;
- Agent B: LLM agent with tools and coordination;
- Pyperplan: PDDL planning for constrained deliveries and crates.

## Requirements

- Node.js 20 or newer;
- npm;
- Python 3 if PDDL is enabled;
- a Deliveroo.js server;
- two Deliveroo tokens and a LiteLLM API key to run the complete team.

## Installation

```bash
npm install
cp .env.example .env
npm run planner:setup
```

`planner:setup` creates a local Python environment and installs Pyperplan. It can be
skipped if `PDDL_ENABLED=false` is set in `.env`.

## Configuration

Open `.env` and set at least:

```env
DELIVEROOJS_URL=http://localhost:8080
TOKEN_AGENT_A=replace-with-agent-a-token
TOKEN_AGENT_B=replace-with-agent-b-token
LITELLM_API_KEY=replace-with-course-key
```

The two Deliveroo tokens must use the same team name. Agent B cannot run without a valid
LiteLLM configuration.

## Running

Make sure `DELIVEROOJS_URL` points to the running Deliveroo.js server, then start both
agents:

```bash
npm run dev:team
```

The available run commands are:

```bash
npm run dev:a       # Agent A only
npm run dev:b       # Agent B only
npm run dev:team    # Agent A and Agent B
```

## Validation

```bash
npm run build
npm test
```

# Benchmark script

`benchmark-maps.mjs` starts one local Deliveroo server and either Agent A or the two-agent team for
each map. Runs are strictly sequential and use unique log directories, so old logs cannot
contaminate fresh measurements. Each experiment writes `metadata.json`, `results.json`,
`results.csv`, and per-run logs/stdout/stderr in a timestamped directory under `data/benchmarks/`.

Run the eight 2026 Challenge 1 maps with Agent A for 60 seconds each:

```bash
BENCHMARK_DURATION_MS=60000 \
npm run benchmark:maps -- 26c1_1 26c1_2 26c1_3 26c1_4 26c1_5 26c1_6 26c1_7 26c1_8
```

Run the two-agent team. This mode requires the configured `LITELLM_API_KEY`, because the current
Agent B intentionally has no no-LLM runtime mode:

```bash
BENCHMARK_MODE=team \
BENCHMARK_DURATION_MS=60000 \
npm run benchmark:maps -- 26c1_1 26c1_2
```

Repeat each selected map five times:

```bash
BENCHMARK_REPETITIONS=5 \
BENCHMARK_DURATION_MS=60000 \
npm run benchmark:maps -- 26c1_1 26c1_2
```

The harness loads the normal `.env` configuration but never writes secrets to metadata. Supported
controls are:

- `BENCHMARK_MODE`: `a` (default) or `team`.
- `BENCHMARK_DURATION_MS`: measured duration per run (default: 60,000 ms).
- `BENCHMARK_REPETITIONS`: repetitions per selected map (default: 1).
- `BENCHMARK_COOLDOWN_MS`: pause between sequential runs (default: 1,000 ms).
- `BENCHMARK_PORT`: base port; each run receives a distinct successive port.
- `BENCHMARK_OUTPUT_DIR`: output root (default: `data/benchmarks`).
- `DELIVEROO_SERVER_DIR`: Deliveroo.js checkout (default: `../Deliveroo.js`).

The CSV reports per-agent score, pickup/putdown counts, moves and failures, Agent A intention
revisions, Agent B tool/PDDL/mission counters, received messages, and cycle failures. A run is
marked failed if the server or agent process exits early or if neither agent produces structured
events. Raw logs remain available for metrics that need map-specific interpretation.

This is a map/runtime benchmark harness; it does not inject synthetic Challenge 2 messages. Mission
counters are populated when the selected server scenario or an external mission agent sends them.

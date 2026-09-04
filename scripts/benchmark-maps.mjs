#!/usr/bin/env node
import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const root = resolve(".");
const serverRoot = resolve(process.env.DELIVEROO_SERVER_DIR ?? "../Deliveroo.js");
const gamesRoot = join(serverRoot, "packages/@unitn-asa/deliveroo-js-assets/assets/games");
const outputRoot = resolve(process.env.BENCHMARK_OUTPUT_DIR ?? "data/benchmarks");
const durationMs = positiveInteger("BENCHMARK_DURATION_MS", 60_000);
const cooldownMs = nonNegativeInteger("BENCHMARK_COOLDOWN_MS", 1_000);
const basePort = positiveInteger("BENCHMARK_PORT", 18_080);
const repetitions = positiveInteger("BENCHMARK_REPETITIONS", 1);
const mode = process.env.BENCHMARK_MODE === "team" ? "team" : "a";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const experimentDir = join(outputRoot, `${stamp}-${mode}`);
const runsDir = join(experimentDir, "runs");

if (!existsSync(serverRoot)) throw new Error(`Deliveroo server not found: ${serverRoot}`);
if (!existsSync(gamesRoot)) throw new Error(`Deliveroo games not found: ${gamesRoot}`);
if (mode === "team" && !process.env.LITELLM_API_KEY) {
  throw new Error("BENCHMARK_MODE=team requires LITELLM_API_KEY because the current Agent B has no no-LLM runtime mode");
}
mkdirSync(runsDir, { recursive: true });

const requestedMaps = process.argv.slice(2);
const maps = (requestedMaps.length > 0
  ? requestedMaps.map(resolveMap)
  : readdirSync(gamesRoot).filter((file) => file.endsWith(".json")).sort().map((file) => join(gamesRoot, file))
).flatMap((map) => Array.from({ length: repetitions }, (_, repetition) => ({ map, repetition: repetition + 1 })));

if (maps.length === 0) throw new Error("No maps found");

const metadata = {
  startedAt: new Date().toISOString(),
  gitCommit: gitCommit(),
  gitDirty: gitDirty(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  mode,
  agentCommand: mode === "team" ? "npm run dev:team" : "npm run dev:a",
  durationMs,
  cooldownMs,
  repetitions,
  llmEnabled: mode === "team",
  pddlEnabled: parseBoolean(process.env.PDDL_ENABLED, true),
  sequential: true,
  maximumConcurrentProcesses: mode === "team" ? 3 : 2,
  maps: maps.map(({ map, repetition }) => ({ map: basename(map, ".json"), repetition }))
};
writeFileSync(join(experimentDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const results = [];
for (let index = 0; index < maps.length; index += 1) {
  const item = maps[index];
  results.push(await benchmark(item.map, item.repetition, basePort + index));
  writeOutputs(results);
  if (index < maps.length - 1 && cooldownMs > 0) await sleep(cooldownMs);
}

console.log(`Fresh results written to ${experimentDir}`);

/** Runs one isolated server/agent session. No two map runs overlap. */
async function benchmark(map, repetition, port) {
  const mapName = basename(map, ".json");
  const runName = `${String(results.length + 1).padStart(2, "0")}-${mapName}-r${repetition}`;
  const runDir = join(runsDir, runName);
  const logDir = join(runDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  console.log(`[${results.length + 1}/${maps.length}] ${mode} on ${mapName}, repetition ${repetition}`);

  const server = spawn("node", ["backend/index.js", "--port", String(port), "--game", map], {
    cwd: serverRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  collectOutput(server, runDir, "server");

  let agents;
  let error = null;
  try {
    await waitForServer(`http://localhost:${port}`, 12_000);
    agents = spawn("npm", ["run", mode === "team" ? "dev:team" : "dev:a"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DELIVEROOJS_URL: `http://localhost:${port}`,
        LOG_DIR: logDir
      }
    });
    collectOutput(agents, runDir, "agents");
    const outcome = await Promise.race([
      sleep(durationMs).then(() => null),
      processExit(agents).then(({ code, signal }) => `agents exited early (code=${code ?? "null"}, signal=${signal ?? "none"})`),
      processExit(server).then(({ code, signal }) => `server exited early (code=${code ?? "null"}, signal=${signal ?? "none"})`)
    ]);
    if (outcome) error = outcome;
  } catch (caught) {
    error = String(caught);
  } finally {
    await stop(agents);
    await stop(server);
  }

  const metrics = summarizeLogs(logDir);
  if (!error && metrics.agentA.events === 0 && metrics.agentB.events === 0) {
    error = "agents produced no structured log events";
  }
  const result = {
    map: mapName,
    repetition,
    mode,
    port,
    status: error ? "failed" : "ok",
    error,
    startedAt,
    elapsedMs: Date.now() - startedMs,
    runDir,
    metrics
  };
  console.log(
    `${mapName}: A=${metrics.agentA.finalScore ?? "n/a"}, B=${metrics.agentB.finalScore ?? "n/a"}, ` +
      `putdowns=${metrics.total.putdownParcels}, failedMoves=${metrics.total.failedMoves}`
  );
  return result;
}

/** Summarizes only files created inside this run's unique log directory. */
function summarizeLogs(directory) {
  const metrics = {
    agentA: emptyAgentMetrics(),
    agentB: emptyAgentMetrics(),
    total: { pickupParcels: 0, putdownParcels: 0, moves: 0, failedMoves: 0, messagesReceived: 0 }
  };
  if (!existsSync(directory)) return metrics;

  for (const file of readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
    const target = file.includes("agent-a-bdi") ? metrics.agentA : file.includes("agent-b-llm") ? metrics.agentB : null;
    if (!target) continue;
    const rows = readFileSync(join(directory, file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          target.malformedLogRows += 1;
          return [];
        }
      });

    for (const row of rows) {
      target.events += 1;
      if (row.type === "belief_revision" && row.source === "self") target.finalScore = numberOr(row.belief?.score, target.finalScore);
      if (row.type === "belief_self") target.finalScore = numberOr(row.self?.score, target.finalScore);
      if (row.type === "move") {
        target.moves += 1;
        if (row.ok === false) target.failedMoves += 1;
      }
      if (row.type === "move_failed") target.failedMoves += 1;
      if (row.type === "pickup") target.pickupParcels += Number(row.count ?? 0);
      if (row.type === "putdown") target.putdownParcels += Number(row.count ?? 0);
      if (row.type === "intention_revision") target.intentionRevisions += 1;
      if (row.type === "pddl_result" || row.type === "pddl_crate_result" || row.type === "pddl_fallback") {
        target.pddlCalls += 1;
      }
      if ((row.type === "pddl_result" || row.type === "pddl_crate_result") && row.success === true) {
        target.pddlSuccesses += 1;
      }
      if (row.type === "llm_decision" && row.step === 0) target.missionsStarted += 1;
      if (row.type === "llm_mission_failed") target.missionFailures += 1;
      if (row.type === "llm_courier_failed") target.llmCourierFailures += 1;
      if (row.type === "tool_call") target.toolCalls += 1;
      if (row.type === "tool_result" && row.result?.ok === false) target.toolFailures += 1;
      if (row.type === "message_received") target.messagesReceived += 1;
      if (row.type === "coordination_started") target.coordinationStarted += 1;
      if (row.type === "coordination_completed") target.coordinationCompleted += 1;
      if (row.type === "coordination_cancelled") target.coordinationCancelled += 1;
      if (row.type === "cycle_failed") target.cycleFailures += 1;
    }
  }

  for (const target of [metrics.agentA, metrics.agentB]) {
    metrics.total.pickupParcels += target.pickupParcels;
    metrics.total.putdownParcels += target.putdownParcels;
    metrics.total.moves += target.moves;
    metrics.total.failedMoves += target.failedMoves;
    metrics.total.messagesReceived += target.messagesReceived;
  }
  return metrics;
}

function emptyAgentMetrics() {
  return {
    finalScore: null,
    events: 0,
    moves: 0,
    failedMoves: 0,
    pickupParcels: 0,
    putdownParcels: 0,
    intentionRevisions: 0,
    pddlCalls: 0,
    pddlSuccesses: 0,
    missionsStarted: 0,
    missionFailures: 0,
    llmCourierFailures: 0,
    toolCalls: 0,
    toolFailures: 0,
    messagesReceived: 0,
    coordinationStarted: 0,
    coordinationCompleted: 0,
    coordinationCancelled: 0,
    cycleFailures: 0,
    malformedLogRows: 0
  };
}

function writeOutputs(currentResults) {
  writeFileSync(join(experimentDir, "results.json"), `${JSON.stringify(currentResults, null, 2)}\n`);
  writeFileSync(join(experimentDir, "results.csv"), toCsv(currentResults));
}

function toCsv(currentResults) {
  const columns = [
    "map", "repetition", "mode", "status", "elapsedMs", "scoreA", "scoreB", "pickupsA", "pickupsB",
    "putdownsA", "putdownsB", "movesA", "movesB", "failedMovesA", "failedMovesB", "intentionRevisionsA",
    "pddlCallsB", "pddlSuccessesB", "missionsStartedB", "missionFailuresB", "toolCallsB", "toolFailuresB",
    "messagesA", "messagesB", "cycleFailuresA", "cycleFailuresB"
  ];
  const rows = currentResults.map((result) => {
    const a = result.metrics.agentA;
    const b = result.metrics.agentB;
    const row = {
      ...result,
      scoreA: a.finalScore, scoreB: b.finalScore,
      pickupsA: a.pickupParcels, pickupsB: b.pickupParcels,
      putdownsA: a.putdownParcels, putdownsB: b.putdownParcels,
      movesA: a.moves, movesB: b.moves,
      failedMovesA: a.failedMoves, failedMovesB: b.failedMoves,
      intentionRevisionsA: a.intentionRevisions,
      pddlCallsB: b.pddlCalls, pddlSuccessesB: b.pddlSuccesses,
      missionsStartedB: b.missionsStarted, missionFailuresB: b.missionFailures,
      toolCallsB: b.toolCalls, toolFailuresB: b.toolFailures,
      messagesA: a.messagesReceived, messagesB: b.messagesReceived,
      cycleFailuresA: a.cycleFailures, cycleFailuresB: b.cycleFailures
    };
    return columns.map((column) => csvCell(row[column])).join(",");
  });
  return `${columns.join(",")}\n${rows.join("\n")}\n`;
}

function resolveMap(value) {
  if (isAbsolute(value)) return value;
  const local = resolve(value);
  if (existsSync(local)) return local;
  const filename = value.endsWith(".json") ? value : `${value}.json`;
  const inGames = join(gamesRoot, filename);
  if (!existsSync(inGames)) throw new Error(`Map not found: ${value}`);
  return inGames;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGINT");
  const exited = await Promise.race([
    new Promise((resolveDone) => child.once("exit", () => resolveDone(true))),
    sleep(2_000).then(() => false)
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGTERM");
}

function collectOutput(child, directory, label) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.once("close", () => {
    writeFileSync(join(directory, `${label}.stdout.txt`), stdout);
    writeFileSync(join(directory, `${label}.stderr.txt`), stderr);
  });
}

function processExit(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gitDirty() {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

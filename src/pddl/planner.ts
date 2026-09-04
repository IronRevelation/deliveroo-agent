import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentConfig, PlanAction, PlannerRequest, PlannerResult, Position } from "../common/types.js";
import type { Logger } from "../common/logger.js";
import { directionBetween } from "../common/utils.js";
import { generateCrateProblem, generateProblem, type CrateProblemRequest, type GeneratedProblem } from "./problem-generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_PATH = resolve(__dirname, "domain.pddl");
const CRATE_SEARCH_ARGS = ["-s", "gbf", "-H", "hff"];
const CRATE_PLANNER_TIMEOUT_MS = 5_000;

/** Isolates the external pyperplan process behind the PlanAction format used by Agent B. */
export class PddlPlanner {
  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger
  ) {}

  /** Generates a temporary problem, runs pyperplan, and translates its solution for tool execution. */
  async plan(request: PlannerRequest): Promise<PlannerResult> {
    return this.run(() => generateProblem(request), "pddl_result");
  }

  /** Solves the global crate puzzle from the current agent position to the real route goal. */
  async planCratePassage(request: CrateProblemRequest): Promise<PlannerResult> {
    return this.run(
      () => generateCrateProblem(request),
      "pddl_crate_result",
      CRATE_SEARCH_ARGS,
      CRATE_PLANNER_TIMEOUT_MS
    );
  }

  private async run(
    generate: () => GeneratedProblem | null,
    eventName: string,
    plannerArgs: string[] = [],
    timeoutMs?: number
  ): Promise<PlannerResult> {
    const started = Date.now();
    const generated = generate();
    if (!generated) {
      return this.fail(started, "no-suitable-pddl-problem");
    }

    if (!existsSync(this.config.pyperplanBin)) {
      return this.fail(started, `planner-not-found:${this.config.pyperplanBin}`);
    }

    const tmpDir = resolve(".tmp", "pddl");
    mkdirSync(tmpDir, { recursive: true });
    const problemPath = join(tmpDir, `problem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pddl`);
    writeFileSync(problemPath, generated.problem);

    const result = await runPlanner(this.config.pyperplanBin, DOMAIN_PATH, problemPath, plannerArgs, timeoutMs);
    const rawPlan = result.solution || result.stdout;
    const actions = parsePlan(rawPlan, generated.positionByTileName, generated.parcelIdByObjectName);
    const success = result.exitCode === 0 && actions.length > 0;
    const plannerResult: PlannerResult = {
      actions,
      success,
      reason: success ? undefined : plannerFailureReason(result)
    };
    this.logger.event(eventName, {
      success: plannerResult.success,
      durationMs: Date.now() - started,
      reason: plannerResult.reason,
      actionCount: plannerResult.actions.length
    });
    return plannerResult;
  }

  /** Produces one logged failure shape so Agent B can fall back without special-case exceptions. */
  private fail(started: number, reason: string): PlannerResult {
    const result = {
      actions: [],
      success: false,
      reason
    };
    this.logger.event("pddl_fallback", { ...result, durationMs: Date.now() - started });
    return result;
  }
}

/** Reduces verbose planner output to a useful diagnostic stored in experiment logs. */
function plannerFailureReason(result: { stdout: string; stderr: string; solution: string; exitCode: number | null }): string {
  const detail = result.stderr.trim() || result.stdout.trim() || result.solution.trim();
  if (!detail) return `empty-plan exit=${result.exitCode ?? "unknown"}`;
  return detail.length > 500 ? `${detail.slice(0, 500)}...` : detail;
}

/** Runs pyperplan asynchronously and collects either its solution file or process diagnostics. */
function runPlanner(bin: string, domainPath: string, problemPath: string, plannerArgs: string[] = [], timeoutMs?: number): Promise<{
  stdout: string;
  stderr: string;
  solution: string;
  exitCode: number | null;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, [...plannerArgs, domainPath, problemPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) stderr += `${stderr ? "\n" : ""}${error}`;
      const solutionPath = `${problemPath}.soln`;
      const solution = existsSync(solutionPath) ? readFileSync(solutionPath, "utf8") : "";
      resolvePromise({ stdout, stderr, solution, exitCode });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => finish(exitCode));
    child.on("error", (error) => finish(1, String(error)));
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        stderr += `${stderr ? "\n" : ""}planner timed out after ${timeoutMs} ms`;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
  });
}

/** Converts symbolic planner output into the movement, pickup, and putdown actions AgentTools understands. */
export function parsePlan(
  rawPlan: string,
  positionByTileName: Map<string, Position>,
  parcelIdByObjectName = new Map<string, string>()
): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const line of rawPlan.split(/\r?\n/)) {
    const normalized = line.trim().replace(/^\d+:\s*/, "").replace(/[()]/g, "").toLowerCase();
    if (!normalized) continue;
    const [action, ...args] = normalized.split(/\s+/);
    if (action === "move") {
      const from = positionByTileName.get(args[0] ?? "");
      const to = positionByTileName.get(args[1] ?? "");
      if (!from || !to) continue;
      const direction = directionBetween(from, to);
      if (direction) actions.push({ kind: "move", direction, reason: "pddl" });
    }
    if (action === "push") {
      // (push ?from ?through ?to): the agent steps onto ?through while the crate slides to ?to.
      const from = positionByTileName.get(args[0] ?? "");
      const through = positionByTileName.get(args[1] ?? "");
      const to = positionByTileName.get(args[2] ?? "");
      if (!from || !through || !to) continue;
      const direction = directionBetween(from, through);
      if (direction) {
        actions.push({ kind: "move", direction, reason: "pddl-push", cratePush: { from: through, to } });
      }
    }
    if (action === "pickup") {
      const parcelId = parcelIdByObjectName.get(args[0] ?? "");
      actions.push({ kind: "pickup", reason: "pddl", ...(parcelId ? { parcelIds: [parcelId] } : {}) });
    }
    if (action === "drop") actions.push({ kind: "putdown", reason: "pddl" });
  }
  return actions;
}

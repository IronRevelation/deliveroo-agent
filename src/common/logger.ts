import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Writes structured events used to inspect agents and compute experiment metrics. */
export class Logger {
  private readonly filePath: string;

  /** Creates a separate timestamped event stream for one agent or experiment run. */
  constructor(logDir: string, name: string) {
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(logDir, `${stamp}-${name}.jsonl`);
  }

  /** Appends one timestamped JSONL record without coupling agent logic to a reporting system. */
  event(type: string, data: Record<string, unknown> = {}): void {
    const row = {
      at: new Date().toISOString(),
      type,
      ...data
    };
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`);
  }

  get path(): string {
    return this.filePath;
  }
}

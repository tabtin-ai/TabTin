import fs from "node:fs/promises";
import path from "node:path";
import type { RunContext, TimelineEvent } from "./types";
import { sanitizePathSegment, toRepoRelative } from "./paths";

export class EvidenceWriter {
  readonly scenarioArtifactDir: string;

  constructor(
    private readonly repoRoot: string,
    private readonly runId: string,
    private readonly scenarioId: string
  ) {
    this.scenarioArtifactDir = path.join(
      repoRoot,
      "tests",
      "electron",
      "artifacts",
      "runs",
      sanitizePathSegment(runId),
      sanitizePathSegment(scenarioId)
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.scenarioArtifactDir, { recursive: true });
    await fs.mkdir(path.join(this.scenarioArtifactDir, "snapshots"), { recursive: true });
    await fs.mkdir(path.join(this.scenarioArtifactDir, "logs"), { recursive: true });
    await fs.mkdir(path.join(this.scenarioArtifactDir, "screenshots"), { recursive: true });
    await fs.mkdir(path.join(this.scenarioArtifactDir, "traces"), { recursive: true });
  }

  createContext(updateBaseline: boolean): RunContext {
    return {
      repoRoot: this.repoRoot,
      runId: this.runId,
      scenarioId: this.scenarioId,
      scenarioArtifactDir: this.scenarioArtifactDir,
      preparedData: {},
      updateBaseline,
      writeJson: (relativePath, value) => this.writeJson(relativePath, value),
      writeText: (relativePath, value) => this.writeText(relativePath, value),
      writeTimeline: (event) => this.writeTimeline(event),
      reportProgress: (phase, message) => this.reportProgress(phase, message),
    };
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    return this.writeFile(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeText(relativePath: string, value: string): Promise<string> {
    return this.writeFile(relativePath, value.endsWith("\n") ? value : `${value}\n`);
  }

  async writeTimeline(event: Omit<TimelineEvent, "ts" | "scenarioId" | "runId">): Promise<void> {
    const line: TimelineEvent = {
      ts: new Date().toISOString(),
      scenarioId: this.scenarioId,
      runId: this.runId,
      ...event,
    };
    await fs.appendFile(
      path.join(this.scenarioArtifactDir, "timeline.jsonl"),
      `${JSON.stringify(line)}\n`,
      "utf8"
    );
  }

  async reportProgress(phase: string, message: string): Promise<void> {
    const time = new Date().toISOString();
    console.log(`[e2e ${time}] ${this.scenarioId} ${phase} ${message}`);
    await this.writeTimeline({
      event: "progress",
      payload: { phase, message },
    });
  }

  private async writeFile(relativePath: string, value: string): Promise<string> {
    const target = path.resolve(this.scenarioArtifactDir, relativePath);
    const relativeTarget = path.relative(this.scenarioArtifactDir, target);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new Error(`Artifact path escapes scenario directory: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value, "utf8");
    return toRepoRelative(this.repoRoot, target);
  }
}

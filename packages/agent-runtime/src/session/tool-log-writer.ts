/**
 * @tabtin/agent-runtime — Tool Log Writer
 *
 * Writes per-tool-call markdown files into the Agent sandbox so that
 * the Agent can reference full tool input/output via `read_file` in
 * subsequent turns, without stuffing the entire content into the LLM
 * context window.
 *
 * File layout:
 *   {toolLogsDir}/{sessionId}/
 *     _index.jsonl      — one line per tool call (summary + file path)
 *     {tool_call_id}.md — full input + output in markdown
 *
 * The writer is fire-and-forget: IO errors are logged but never propagate
 * to the caller — tool log persistence is secondary to the main execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolLogEntry {
  tool_name: string;
  tool_call_id: string;
  input?: unknown;
  output?: unknown;
  is_error?: boolean;
  duration_ms?: number;
  timestamp?: number;
}

export interface ToolLogWriterOptions {
  /** Base directory for tool logs (typically `{sandboxRoot}/tool-logs`). */
  toolLogsDir: string;
  sessionId: string;
  onError?: (err: Error) => void;
}

export class ToolLogWriter {
  private readonly sessionDir: string;
  private readonly indexPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly onError: (err: Error) => void;
  private readonly pendingInputs = new Map<string, unknown>();

  constructor(private readonly options: ToolLogWriterOptions) {
    this.sessionDir = path.join(options.toolLogsDir, options.sessionId);
    this.indexPath = path.join(this.sessionDir, '_index.jsonl');
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Cache tool input from a `start` event. The `end` event only carries
   * output; input is only available on `start`. Call this on every
   * `agent.stream.tool` with `phase === 'start'`.
   */
  onToolStart(toolCallId: string, input: unknown): void {
    this.pendingInputs.set(toolCallId, input);
  }

  /**
   * Write a tool call log entry. If input was previously cached via
   * `onToolStart`, it is automatically merged. Safe to call concurrently
   * — writes are serialised through an internal queue.
   */
  writeToolLog(entry: ToolLogEntry): void {
    const cachedInput = this.pendingInputs.get(entry.tool_call_id);
    this.pendingInputs.delete(entry.tool_call_id);
    const merged: ToolLogEntry = {
      ...entry,
      input: entry.input ?? cachedInput,
    };
    this.writeQueue = this.writeQueue.then(() => this._doWrite(merged)).catch(() => undefined);
  }

  private async _doWrite(entry: ToolLogEntry): Promise<void> {
    try {
      await this._ensureDir();

      const mdPath = path.join(this.sessionDir, `${entry.tool_call_id}.md`);
      const relativeMdPath = `tool-logs/${this.options.sessionId}/${entry.tool_call_id}.md`;
      const ts = entry.timestamp ?? Date.now();

      const mdContent = this._buildMarkdown(entry, ts);
      await fs.promises.writeFile(mdPath, mdContent, { mode: 0o600 });

      const indexLine = JSON.stringify({
        tool_name: entry.tool_name,
        tool_call_id: entry.tool_call_id,
        ts: new Date(ts).toISOString(),
        is_error: Boolean(entry.is_error),
        duration_ms: entry.duration_ms ?? null,
        path: relativeMdPath,
      }) + '\n';
      await fs.promises.appendFile(this.indexPath, indexLine, { mode: 0o600 });
    } catch (err) {
      this.onError(err as Error);
    }
  }

  private _buildMarkdown(entry: ToolLogEntry, ts: number): string {
    const lines: string[] = [];
    lines.push(`# Tool Call: ${entry.tool_name}`);
    lines.push(`- call_id: ${entry.tool_call_id}`);
    lines.push(`- timestamp: ${new Date(ts).toISOString()}`);
    if (entry.duration_ms != null) {
      lines.push(`- duration: ${entry.duration_ms}ms`);
    }
    if (entry.is_error) {
      lines.push(`- error: true`);
    }
    lines.push('');
    lines.push('## Input');
    lines.push(formatValue(entry.input));
    lines.push('');
    lines.push('## Output');
    lines.push(formatValue(entry.output));
    lines.push('');
    return lines.join('\n');
  }

  private async _ensureDir(): Promise<void> {
    if (!fs.existsSync(this.sessionDir)) {
      await fs.promises.mkdir(this.sessionDir, { recursive: true });
    }
  }
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Remove tool-log session directories older than `maxAgeMs`.
 * Intended to be called once at host startup.
 */
export async function cleanupOldToolLogs(
  toolLogsBaseDir: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): Promise<{ removed: number; errors: number }> {
  let removed = 0;
  let errors = 0;

  if (!fs.existsSync(toolLogsBaseDir)) return { removed, errors };

  const cutoff = Date.now() - maxAgeMs;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(toolLogsBaseDir, { withFileTypes: true });
  } catch {
    return { removed, errors };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(toolLogsBaseDir, entry.name);
    try {
      const stat = await fs.promises.stat(dirPath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        removed++;
      }
    } catch {
      errors++;
    }
  }
  return { removed, errors };
}

/**
 * Normalize tool output to a string for SessionStorage / relay consumption.
 * Shared between Electron and Daemon hosts.
 */
export function toolOutputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '(none)';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

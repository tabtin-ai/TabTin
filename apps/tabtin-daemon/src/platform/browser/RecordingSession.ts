/**
 * RecordingSession — captures browser actions as a replayable sequence.
 *
 * Records CLI-level actions (navigate, click, fill, etc.) rather than
 * raw input events, making recordings more stable across page changes.
 */

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';

export interface RecordedAction {
  type: string;
  timestamp: number;
  url?: string;
  selector?: string;
  value?: string;
  expression?: string;
  direction?: string;
  args?: Record<string, any>;
}

export interface Recording {
  runId: string;
  startedAt: string;
  endedAt?: string;
  actions: RecordedAction[];
  metadata?: Record<string, any>;
}

const RECORDINGS_DIR = getHomeTabtinPath('recordings');

export class RecordingManager {
  private active = new Map<string, Recording>();

  async start(runId: string, metadata?: Record<string, any>): Promise<Recording> {
    const recording: Recording = {
      runId,
      startedAt: new Date().toISOString(),
      actions: [],
      metadata,
    };
    this.active.set(runId, recording);
    return recording;
  }

  record(runId: string, action: RecordedAction): void {
    const rec = this.active.get(runId);
    if (!rec) return;
    rec.actions.push({ ...action, timestamp: Date.now() });
  }

  async stop(runId: string): Promise<Recording | null> {
    const rec = this.active.get(runId);
    if (!rec) return null;

    rec.endedAt = new Date().toISOString();
    this.active.delete(runId);

    await mkdir(RECORDINGS_DIR, { recursive: true });
    const path = join(RECORDINGS_DIR, `${runId}.json`);
    await writeFile(path, JSON.stringify(rec, null, 2));

    return rec;
  }

  async stopCurrent(): Promise<Recording | null> {
    const runId = this.active.keys().next().value as string | undefined
    return runId ? this.stop(runId) : null
  }

  getStatus(runId: string): { recording: boolean; actionCount: number } | null {
    const rec = this.active.get(runId);
    if (!rec) return null;
    return { recording: true, actionCount: rec.actions.length };
  }

  isRecording(runId: string): boolean {
    return this.active.has(runId);
  }

  async load(runId: string): Promise<Recording | null> {
    try {
      const path = join(RECORDINGS_DIR, `${runId}.json`);
      const data = await readFile(path, 'utf-8');
      return JSON.parse(data) as Recording;
    } catch {
      return null;
    }
  }

  async list(): Promise<Array<{ runId: string; startedAt: string; actionCount: number }>> {
    try {
      await mkdir(RECORDINGS_DIR, { recursive: true });
      const files = await readdir(RECORDINGS_DIR);
      const results: Array<{ runId: string; startedAt: string; actionCount: number }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await readFile(join(RECORDINGS_DIR, file), 'utf-8');
          const rec = JSON.parse(data) as Recording;
          results.push({
            runId: rec.runId,
            startedAt: rec.startedAt,
            actionCount: rec.actions.length,
          });
        } catch { /* skip corrupt files */ }
      }

      return results.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    } catch {
      return [];
    }
  }

  /** Finalize every active recording so daemon shutdown never drops captured actions. */
  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.active.keys()].map((runId) => this.stop(runId)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

export class ReplayEngine {
  async run(
    recording: Recording,
    executor: (action: RecordedAction) => Promise<any>,
    opts?: {
      speed?: number;
      skipWaits?: boolean;
      stopOnError?: boolean;
      signal?: AbortSignal;
      onProgress?: (progress: { completed: number; total: number }) => void;
    }
  ): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
    const speed = opts?.speed ?? 1;
    const skipWaits = opts?.skipWaits ?? false;
    const stopOnError = opts?.stopOnError ?? true;
    return replayActions(recording, executor, { speed, skipWaits, stopOnError, signal: opts?.signal, onProgress: opts?.onProgress });
  }
}

async function replayActions(
  recording: Recording,
  executor: (action: RecordedAction) => Promise<any>,
  opts: { speed: number; skipWaits: boolean; stopOnError: boolean; signal?: AbortSignal; onProgress?: (progress: { completed: number; total: number }) => void },
): Promise<{ success: boolean; completed: number; total: number; errors: string[] }> {
    const errors: string[] = [];
    let completed = 0;

    let prevTimestamp = recording.actions[0]?.timestamp ?? 0;

    for (const action of recording.actions) {
      throwIfReplayAborted(opts?.signal);
      await waitBeforeReplayAction(action.timestamp, prevTimestamp, opts.speed, opts.skipWaits, opts.signal);
      prevTimestamp = action.timestamp;
      throwIfReplayAborted(opts?.signal);

      try {
        await executor(action);
        completed++;
        opts?.onProgress?.({ completed, total: recording.actions.length });
      } catch (err: any) {
        if (isAbortError(err)) throw err;
        const msg = `Action ${completed + 1} (${action.type}) failed: ${errorMessage(err)}`;
        errors.push(msg);
        if (opts.stopOnError) break;
      }
    }

    return {
      success: errors.length === 0,
      completed,
      total: recording.actions.length,
      errors,
    };
}

function replayAbortError(): Error {
  const err = new Error('Replay aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfReplayAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw replayAbortError();
}

function replaySleep(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(replayAbortError()); return; }
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(replayAbortError()); }, { once: true });
  });
}

async function waitBeforeReplayAction(timestamp: number, previous: number, speed: number, skip: boolean, signal?: AbortSignal): Promise<void> {
  if (skip || previous <= 0) return;
  const delay = (timestamp - previous) / speed;
  if (delay > 0 && delay < 30_000) await replaySleep(delay, signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

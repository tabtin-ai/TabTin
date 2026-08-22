import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve a real FFmpeg binary. Returns null when none can execute `-version`.
 * Does not invent a path or assume FFmpeg is present.
 */
export async function findFFmpegAsync(explicitPath?: string): Promise<string | null> {
  const fromEnv = process.env.FFMPEG_PATH?.trim();
  const candidates = [explicitPath?.trim(), fromEnv].filter(
    (value): value is string => Boolean(value),
  );

  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(whichCmd, ['ffmpeg'], { timeout: 5_000 });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) candidates.push(first);
  } catch {
    candidates.push('ffmpeg');
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await execFileAsync(candidate, ['-version'], { timeout: 5_000 });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Execute an FFmpeg command with structured error handling and optional progress parsing.
 *
 * All FFmpeg-based atomic capabilities (reverse, stabilize, denoise, separate,
 * volume, fade, pitch, gif-export, speed-ramp, freeze-frame) delegate here.
 */
export interface FFmpegRunOptions {
  args: string[];
  /** If provided, parse stderr for progress and call this callback */
  onProgress?: (percent: number) => void;
  /** Total input duration in milliseconds — enables percentage-based progress */
  totalDurationMs?: number;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
  /** Path to ffmpeg binary (default: 'ffmpeg' from PATH) */
  ffmpegPath?: string;
}

export interface FFmpegRunResult {
  exitCode: number;
  stderr: string;
}

export async function runFFmpeg(
  options: FFmpegRunOptions,
): Promise<FFmpegRunResult> {
  const {
    args,
    timeoutMs = 5 * 60 * 1000,
    ffmpegPath = 'ffmpeg',
  } = options;

  return new Promise((resolve, reject) => {
    const proc = execFile(
      ffmpegPath,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error && 'killed' in error && error.killed) {
          reject(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
          return;
        }
        resolve({
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
          stderr: stderr ?? '',
        });
      },
    );

    if (options.onProgress && proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString();
        const match = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match) {
          const hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const seconds = parseFloat(match[3]);
          const elapsedMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

          if (options.totalDurationMs && options.totalDurationMs > 0) {
            const percent = Math.min(99, Math.round((elapsedMs / options.totalDurationMs) * 100));
            options.onProgress?.(percent);
          } else {
            const roughPercent = Math.min(99, Math.round(elapsedMs / 1000));
            options.onProgress?.(roughPercent);
          }
        }
      });
    }
  });
}

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

const execFileAsync = promisify(execFile);

export interface SpeedRampCapabilityInput {
  inputPath: string;
  outputPath?: string;
  speed: number;
}

export interface SpeedRampCapabilityData {
  outputPath: string;
  newDurationSec: number;
}

function bad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

function buildAtempoChain(speed: number): string {
  const parts: string[] = [];
  let p = 1;
  while (speed / p > 2 + 1e-9) {
    parts.push('atempo=2');
    p *= 2;
  }
  while (speed / p < 0.5 - 1e-9) {
    parts.push('atempo=0.5');
    p *= 0.5;
  }
  const rest = speed / p;
  if (Math.abs(rest - 1) > 1e-6) parts.push(`atempo=${rest}`);
  return parts.join(',');
}

async function probeFormat(path: string): Promise<{ durationSec: number; hasAudio: boolean }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-show_streams', '-of', 'json', path,
  ]);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const d = parseFloat(j.format?.duration ?? '');
  const durationSec = Number.isFinite(d) ? d : 0;
  const hasAudio = j.streams?.some((s) => s.codec_type === 'audio') ?? false;
  return { durationSec, hasAudio };
}

/** 变速 — `setpts=PTS/speed` + `atempo` 链（0.25–4.0）。 */
export async function speedRampCapability(
  input: SpeedRampCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<SpeedRampCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const speed = input.speed;
  if (speed < 0.25 || speed > 4.0) throw new Error('speed must be between 0.25 and 4.0');
  const outputPath = input.outputPath ?? join(ctx.outputDir, `speed_${Date.now()}.mp4`);
  const { durationSec, hasAudio } = await probeFormat(input.inputPath);
  const newDurationSec = durationSec > 0 ? durationSec / speed : 0;

  if (Math.abs(speed - 1) < 1e-6) {
    const r = await runFFmpeg({ args: ['-y', '-i', input.inputPath, '-c', 'copy', outputPath] });
    bad(r.exitCode, r.stderr);
  } else {
    const args = ['-y', '-i', input.inputPath, '-vf', `setpts=PTS/${speed}`];
    if (hasAudio) {
      const af = buildAtempoChain(speed);
      if (af) args.push('-af', af);
      else args.push('-c:a', 'copy');
    } else args.push('-an');
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
    const r = await runFFmpeg({ args });
    bad(r.exitCode, r.stderr);
  }

  return {
    localPath: outputPath,
    data: { outputPath, newDurationSec },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.ffmpeg.speed-ramp', { ...input }, startTime),
  };
}

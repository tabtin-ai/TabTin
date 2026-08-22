import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

const execFileAsync = promisify(execFile);

export interface ReverseCapabilityInput {
  inputPath: string;
  outputPath?: string;
}

export interface ReverseCapabilityData {
  outputPath: string;
}

async function hasAudioStream(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', path,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function throwIfBad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

/** 视频（及可选音轨）倒放 — `-vf reverse` / `-af areverse`。 */
export async function reverseCapability(
  input: ReverseCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<ReverseCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const outputPath =
    input.outputPath ?? join(ctx.outputDir, `reverse_${Date.now()}.mp4`);
  const withAudio = await hasAudioStream(input.inputPath);
  const args = ['-y', '-i', input.inputPath, '-vf', 'reverse'];
  if (withAudio) args.push('-af', 'areverse');
  else args.push('-an');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputPath);
  const { exitCode, stderr } = await runFFmpeg({ args });
  throwIfBad(exitCode, stderr);
  return {
    localPath: outputPath,
    data: { outputPath },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.ffmpeg.reverse', { ...input }, startTime),
  };
}

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface StabilizeCapabilityInput {
  inputPath: string;
  outputPath?: string;
  shakiness?: number;
}

export interface StabilizeCapabilityData {
  outputPath: string;
}

function throwIfBad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

/** 视频防抖 — `vidstabdetect` + `vidstabtransform` 两遍。 */
export async function stabilizeCapability(
  input: StabilizeCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<StabilizeCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const shakiness = input.shakiness ?? 5;
  const trfPath = join(ctx.outputDir, `vidstab_${Date.now()}.trf`);
  const outputPath =
    input.outputPath ?? join(ctx.outputDir, `stabilized_${Date.now()}.mp4`);
  try {
    const pass1 = await runFFmpeg({
      args: [
        '-y', '-i', input.inputPath,
        '-vf', `vidstabdetect=shakiness=${shakiness}:result=${trfPath}`,
        '-f', 'null', '-',
      ],
    });
    throwIfBad(pass1.exitCode, pass1.stderr);
    ctx.signal?.throwIfAborted();
    const pass2 = await runFFmpeg({
      args: [
        '-y', '-i', input.inputPath,
        '-vf', `vidstabtransform=input=${trfPath}:smoothing=30`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath,
      ],
    });
    throwIfBad(pass2.exitCode, pass2.stderr);
  } finally {
    try {
      unlinkSync(trfPath);
    } catch {
      /* ignore */
    }
  }
  return {
    localPath: outputPath,
    data: { outputPath },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.ffmpeg.stabilize', { ...input }, startTime),
  };
}

import { join } from 'node:path';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface DenoiseCapabilityInput {
  inputPath: string;
  outputPath?: string;
  strength?: 'light' | 'medium' | 'heavy';
}

export interface DenoiseCapabilityData {
  outputPath: string;
}

const HQDN3D: Record<NonNullable<DenoiseCapabilityInput['strength']>, string> = {
  light: 'hqdn3d=4:3:6:4.5',
  medium: 'hqdn3d=6:4.5:9:6',
  heavy: 'hqdn3d=10:7:15:10',
};

function throwIfBad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

/** 视频降噪 — `hqdn3d` filter。 */
export async function denoiseCapability(
  input: DenoiseCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<DenoiseCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const strength = input.strength ?? 'medium';
  const vf = HQDN3D[strength];
  const outputPath =
    input.outputPath ?? join(ctx.outputDir, `denoised_${Date.now()}.mp4`);
  const { exitCode, stderr } = await runFFmpeg({
    args: [
      '-y', '-i', input.inputPath, '-vf', vf,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath,
    ],
  });
  throwIfBad(exitCode, stderr);
  return {
    localPath: outputPath,
    data: { outputPath },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.ffmpeg.denoise', { ...input }, startTime),
  };
}

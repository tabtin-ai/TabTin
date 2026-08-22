import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface ShiftPitchInput {
  inputPath: string;
  outputPath?: string;
  /** 1.0 不变，>1 升调，<1 降调 */
  pitchFactor: number;
}

export interface ShiftPitchData {
  outputPath: string;
}

function resolveOutputPath(ctx: ExecutionContext, input: ShiftPitchInput): string {
  if (input.outputPath) return input.outputPath;
  const stem = path.basename(input.inputPath, path.extname(input.inputPath));
  const ext = path.extname(input.inputPath) || '.m4a';
  const id = randomUUID().slice(0, 8);
  return path.join(ctx.outputDir, `${stem}-pitch-${id}${ext}`);
}

/**
 * 使用 FFmpeg `rubberband` 滤镜变调（需构建包含 librubberband 的 FFmpeg）。
 */
export async function shiftPitch(
  input: ShiftPitchInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<ShiftPitchData>> {
  ctx.signal?.throwIfAborted();
  if (!Number.isFinite(input.pitchFactor) || input.pitchFactor <= 0) {
    throw new Error('pitchFactor must be a finite number > 0');
  }

  const startTime = Date.now();
  const out = resolveOutputPath(ctx, input);
  const { exitCode, stderr } = await runFFmpeg({
    args: [
      '-y',
      '-i',
      input.inputPath,
      '-filter_complex',
      `[0:a]rubberband=pitch=${input.pitchFactor}[aout]`,
      '-map',
      '[aout]',
      '-map',
      '0:v?',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      out,
    ],
  });

  if (exitCode !== 0) {
    throw new Error(
      `FFmpeg rubberband failed (${exitCode}): ${stderr.slice(-800)}`,
    );
  }

  return {
    localPath: out,
    data: { outputPath: out },
    provenance: createProvenance(
      'audio.ffmpeg.pitch',
      { ...input, specificationVersion },
      startTime,
    ),
  };
}

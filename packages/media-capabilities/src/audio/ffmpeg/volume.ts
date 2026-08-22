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

export interface AdjustVolumeInput {
  inputPath: string;
  outputPath?: string;
  /** 线性增益，1.0 不变，范围建议 0.0–5.0 */
  factor: number;
}

export interface AdjustVolumeData {
  outputPath: string;
}

const FACTOR_MIN = 0;
const FACTOR_MAX = 5;

function resolveOutputPath(ctx: ExecutionContext, input: AdjustVolumeInput): string {
  if (input.outputPath) return input.outputPath;
  const stem = path.basename(input.inputPath, path.extname(input.inputPath));
  const ext = path.extname(input.inputPath) || '.m4a';
  const id = randomUUID().slice(0, 8);
  return path.join(ctx.outputDir, `${stem}-volume-${id}${ext}`);
}

/**
 * 使用 FFmpeg `volume` 滤镜调整音量（会重编码音频轨）。
 */
export async function adjustVolume(
  input: AdjustVolumeInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<AdjustVolumeData>> {
  ctx.signal?.throwIfAborted();
  if (
    !Number.isFinite(input.factor) ||
    input.factor < FACTOR_MIN ||
    input.factor > FACTOR_MAX
  ) {
    throw new Error(`factor must be between ${FACTOR_MIN} and ${FACTOR_MAX}`);
  }

  const startTime = Date.now();
  const out = resolveOutputPath(ctx, input);
  const { exitCode, stderr } = await runFFmpeg({
    args: [
      '-y',
      '-i',
      input.inputPath,
      '-filter_complex',
      `[0:a]volume=${input.factor}[aout]`,
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
      `FFmpeg volume failed (${exitCode}): ${stderr.slice(-800)}`,
    );
  }

  return {
    localPath: out,
    data: { outputPath: out },
    provenance: createProvenance(
      'audio.ffmpeg.volume',
      { ...input, specificationVersion },
      startTime,
    ),
  };
}

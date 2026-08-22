import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

const execFileAsync = promisify(execFile);

export interface AudioFadeInput {
  inputPath: string;
  outputPath?: string;
  fadeIn?: number;
  fadeOut?: number;
}

export interface AudioFadeData {
  outputPath: string;
}

async function probeDurationSec(mediaPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      mediaPath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const sec = parseFloat(String(stdout).trim());
  if (!Number.isFinite(sec) || sec <= 0) {
    throw new Error('ffprobe could not read media duration for fade-out');
  }
  return sec;
}

function resolveOutputPath(ctx: ExecutionContext, input: AudioFadeInput): string {
  if (input.outputPath) return input.outputPath;
  const stem = path.basename(input.inputPath, path.extname(input.inputPath));
  const ext = path.extname(input.inputPath) || '.m4a';
  const id = randomUUID().slice(0, 8);
  return path.join(ctx.outputDir, `${stem}-fade-${id}${ext}`);
}

/**
 * 音频淡入 / 淡出（afade）。淡出结束时间依赖媒体总时长，必要时调用 ffprobe。
 */
export async function fadeAudio(
  input: AudioFadeInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<AudioFadeData>> {
  ctx.signal?.throwIfAborted();
  const fi = input.fadeIn ?? 0;
  const fo = input.fadeOut ?? 0;
  if (fi <= 0 && fo <= 0) {
    throw new Error('At least one of fadeIn or fadeOut must be > 0');
  }

  const filters: string[] = [];
  if (fi > 0) filters.push(`afade=t=in:d=${fi}`);
  if (fo > 0) {
    const duration = await probeDurationSec(input.inputPath);
    const st = Math.max(0, duration - fo);
    filters.push(`afade=t=out:st=${st}:d=${fo}`);
  }

  const startTime = Date.now();
  const out = resolveOutputPath(ctx, input);
  const chain = filters.join(',');
  const { exitCode, stderr } = await runFFmpeg({
    args: [
      '-y',
      '-i',
      input.inputPath,
      '-filter_complex',
      `[0:a]${chain}[aout]`,
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
    throw new Error(`FFmpeg afade failed (${exitCode}): ${stderr.slice(-800)}`);
  }

  return {
    localPath: out,
    data: { outputPath: out },
    provenance: createProvenance(
      'audio.ffmpeg.fade',
      { ...input, specificationVersion },
      startTime,
    ),
  };
}

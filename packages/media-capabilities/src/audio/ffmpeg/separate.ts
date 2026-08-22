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

export interface SeparateAvInput {
  inputPath: string;
  outputPath?: string;
  extract: 'audio' | 'video';
}

export interface SeparateAvData {
  outputPath: string;
}

function resolveOutputPath(
  ctx: ExecutionContext,
  input: SeparateAvInput,
): string {
  if (input.outputPath) return input.outputPath;
  const stem = path.basename(input.inputPath, path.extname(input.inputPath));
  const ext = input.extract === 'audio' ? '.m4a' : '.mp4';
  const id = randomUUID().slice(0, 8);
  return path.join(ctx.outputDir, `${stem}-separate-${input.extract}-${id}${ext}`);
}

/**
 * 从容器文件中分离纯音频（-vn）或纯视频（-an），尽量流拷贝。
 */
export async function separateAudioVideo(
  input: SeparateAvInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<SeparateAvData>> {
  ctx.signal?.throwIfAborted();
  const startTime = Date.now();
  const out = resolveOutputPath(ctx, input);

  const baseArgs = ['-y', '-i', input.inputPath];
  const tail =
    input.extract === 'audio'
      ? ['-vn', '-c:a', 'copy', out]
      : ['-an', '-c:v', 'copy', out];

  const { exitCode, stderr } = await runFFmpeg({ args: [...baseArgs, ...tail] });
  if (exitCode !== 0) {
    throw new Error(
      `FFmpeg separate failed (${exitCode}): ${stderr.slice(-800)}`,
    );
  }

  return {
    localPath: out,
    data: { outputPath: out },
    provenance: createProvenance(
      'audio.ffmpeg.separate',
      { ...input, specificationVersion },
      startTime,
    ),
  };
}

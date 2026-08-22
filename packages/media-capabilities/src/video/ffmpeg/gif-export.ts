import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface GifExportCapabilityInput {
  inputPath: string;
  outputPath?: string;
  startSec?: number;
  durationSec?: number;
  width?: number;
  fps?: number;
}

export interface GifExportCapabilityData {
  outputPath: string;
  fileSizeBytes: number;
}

function bad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

/** GIF 导出 — `palettegen` + `paletteuse` 两遍。 */
export async function gifExportCapability(
  input: GifExportCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<GifExportCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const w = input.width ?? 480;
  const fps = input.fps ?? 10;
  const palettePath = join(ctx.outputDir, `gifpal_${Date.now()}.png`);
  const outputPath = input.outputPath ?? join(ctx.outputDir, `export_${Date.now()}.gif`);
  const beforeIn: string[] = [];
  if (input.startSec != null) beforeIn.push('-ss', String(input.startSec));
  beforeIn.push('-i', input.inputPath);
  const afterIn = input.durationSec != null ? ['-t', String(input.durationSec)] : [];

  try {
    const p1 = await runFFmpeg({
      args: [
        '-y', ...beforeIn, ...afterIn,
        '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,palettegen=stats_mode=diff`,
        palettePath,
      ],
    });
    bad(p1.exitCode, p1.stderr);
    ctx.signal?.throwIfAborted();
    const lavfi =
      `[0:v]fps=${fps},scale=${w}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`;
    const p2 = await runFFmpeg({
      args: ['-y', ...beforeIn, ...afterIn, '-i', palettePath, '-lavfi', lavfi, outputPath],
    });
    bad(p2.exitCode, p2.stderr);
  } finally {
    try {
      unlinkSync(palettePath);
    } catch {
      /* ignore */
    }
  }
  const fileSizeBytes = statSync(outputPath).size;
  return {
    localPath: outputPath,
    data: { outputPath, fileSizeBytes },
    mimeType: 'image/gif',
    fileSize: fileSizeBytes,
    provenance: createProvenance('video.ffmpeg.gif-export', { ...input }, startTime),
  };
}

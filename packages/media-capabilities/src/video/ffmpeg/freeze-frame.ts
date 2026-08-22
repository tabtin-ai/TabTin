import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityResult, ExecutionContext, SpecificationVersion } from '../../types.js';
import { runFFmpeg } from '../../infra/ffmpeg-runner.js';
import { createProvenance } from '../../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface FreezeFrameCapabilityInput {
  inputPath: string;
  outputPath?: string;
  timestampSec: number;
  freezeDurationSec: number;
}

export interface FreezeFrameCapabilityData {
  outputPath: string;
}

function bad(exitCode: number, stderr: string): void {
  if (exitCode !== 0) throw new Error(`FFmpeg failed: ${stderr.slice(-1500)}`);
}

const fline = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;

/** 在 `timestampSec` 处定格 `freezeDurationSec` 秒 — 抽帧 + loop + concat。 */
export async function freezeFrameCapability(
  input: FreezeFrameCapabilityInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<FreezeFrameCapabilityData>> {
  const startTime = Date.now();
  ctx.signal?.throwIfAborted();
  const ts = Date.now();
  const T = input.timestampSec;
  const D = input.freezeDurationSec;
  const framePng = join(ctx.outputDir, `ff_frame_${ts}.png`);
  const freezeMp4 = join(ctx.outputDir, `ff_freeze_${ts}.mp4`);
  const headMp4 = join(ctx.outputDir, `ff_head_${ts}.mp4`);
  const tailMp4 = join(ctx.outputDir, `ff_tail_${ts}.mp4`);
  const listPath = join(ctx.outputDir, `ff_concat_${ts}.txt`);
  const outputPath = input.outputPath ?? join(ctx.outputDir, `freeze_${ts}.mp4`);
  const rm = () => {
    for (const p of [framePng, freezeMp4, headMp4, tailMp4, listPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  };
  try {
    let r = await runFFmpeg({
      args: ['-y', '-ss', String(T), '-i', input.inputPath, '-frames:v', '1', framePng],
    });
    bad(r.exitCode, r.stderr);
    ctx.signal?.throwIfAborted();
    r = await runFFmpeg({
      args: [
        '-y', '-loop', '1', '-t', String(D), '-i', framePng, '-i', input.inputPath,
        '-filter_complex',
        '[0:v][1:v]scale2ref=iw:ih:flags=bicubic[s][r];[s]fps=30,format=yuv420p,setsar=1[v]',
        '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', freezeMp4,
      ],
    });
    bad(r.exitCode, r.stderr);
    ctx.signal?.throwIfAborted();
    if (T > 0) {
      r = await runFFmpeg({
        args: [
          '-y', '-to', String(T), '-i', input.inputPath,
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', headMp4,
        ],
      });
      bad(r.exitCode, r.stderr);
    }
    ctx.signal?.throwIfAborted();
    r = await runFFmpeg({
      args: [
        '-y', '-ss', String(T), '-i', input.inputPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', tailMp4,
      ],
    });
    bad(r.exitCode, r.stderr);
    ctx.signal?.throwIfAborted();
    const lines = T > 0 ? [fline(headMp4), fline(freezeMp4), fline(tailMp4)] : [fline(freezeMp4), fline(tailMp4)];
    writeFileSync(listPath, `${lines.join('\n')}\n`, 'utf8');
    r = await runFFmpeg({
      args: [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath,
      ],
    });
    bad(r.exitCode, r.stderr);
  } finally {
    rm();
  }
  return {
    localPath: outputPath,
    data: { outputPath },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.ffmpeg.freeze-frame', { ...input }, startTime),
  };
}

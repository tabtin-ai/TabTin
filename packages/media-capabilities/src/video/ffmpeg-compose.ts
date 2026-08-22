/**
 * FFmpeg 多轨合成 — Phase 1 核心模块
 *
 * 将 MG 视频片段 + TTS 旁白音频 + BGM + 字幕合成为最终 MP4。
 *
 * 合成策略（两步）：
 *   1. concat 拼接 MG 视频片段 → 无声视频
 *   2. filter_complex 混合音频（narration adelay + BGM ducking）+ 字幕烧录 → 最终 MP4
 */

import { join, dirname } from 'node:path';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { runFFmpeg } from '../infra/ffmpeg-runner.js';
import { buildAudioMixFilter } from './audio-filter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VideoClipEntry {
  path: string;
  durationSec: number;
}

export interface NarrationEntry {
  path: string;
  /** 在时间线上的起始秒 */
  startSec: number;
  durationSec?: number;
  volume?: number;
}

export interface BgmEntry {
  path: string;
  /** 基础音量 (0-1)，无 ducking 时使用 */
  volume: number;
  /** ducking 包络：语音时压低，静默时恢复 */
  duckingEnvelope?: Array<{ startSec: number; endSec: number; volume: number }>;
  fadeOutSec?: number;
}

export interface SubtitleCueInput {
  text: string;
  startSec: number;
  endSec: number;
}

export interface ComposeInput {
  videoClips: VideoClipEntry[];
  narrations: NarrationEntry[];
  bgm?: BgmEntry;
  subtitles?: SubtitleCueInput[];
  output: {
    path: string;
    width: number;
    height: number;
    fps: number;
    quality?: 'low' | 'medium' | 'high' | 'very_high';
    codec?: 'h264' | 'h265' | 'vp8' | 'vp9';
    format?: 'mp4' | 'webm';
    videoBitrate?: string;
    audioBitrate?: string;
    timeoutMs?: number;
  };
  /** 总时长（秒），用于进度计算；不传时自动取视频轨总长 */
  totalDurationSec?: number;
  onProgress?: (percent: number) => void;
}

export interface ComposeResult {
  outputPath: string;
  durationSec: number;
  fileSizeBytes: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function secToAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function generateAssSubtitles(
  cues: SubtitleCueInput[],
  width: number,
  height: number,
): string {
  const fontSize = Math.round(height * 0.04);
  const marginV = Math.round(height * 0.06);

  const lines = [
    '[Script Info]',
    'Title: TabVideo Subtitles',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans SC,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of cues) {
    const start = secToAssTime(cue.startSec);
    const end = secToAssTime(cue.endSec);
    const escaped = cue.text
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N');
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${escaped}`);
  }

  return lines.join('\n');
}

function resolveVideoCodec(codec: ComposeInput['output']['codec'] | undefined): string {
  switch (codec) {
    case 'h265':
      return 'libx265';
    case 'vp8':
      return 'libvpx';
    case 'vp9':
      return 'libvpx-vp9';
    case 'h264':
    default:
      return 'libx264';
  }
}

function resolveQualityCrf(
  quality: ComposeInput['output']['quality'] | undefined,
  codec: ComposeInput['output']['codec'] | undefined,
): string {
  if (codec === 'vp8' || codec === 'vp9') {
    return {
      low: '36',
      medium: '32',
      high: '28',
      very_high: '24',
    }[quality ?? 'high'];
  }
  return {
    low: '28',
    medium: '23',
    high: '18',
    very_high: '15',
  }[quality ?? 'high'];
}

function pushVideoEncodeArgs(ffArgs: string[], output: ComposeInput['output']): void {
  const codec = output.codec ?? (output.format === 'webm' ? 'vp9' : 'h264');
  ffArgs.push(
    '-c:v', resolveVideoCodec(codec),
    '-crf', resolveQualityCrf(output.quality, codec),
  );

  if (codec === 'vp8' || codec === 'vp9') {
    ffArgs.push('-b:v', output.videoBitrate ?? '0');
  } else {
    ffArgs.push('-preset', output.quality === 'low' ? 'veryfast' : 'slow', '-pix_fmt', 'yuv420p');
    if (output.videoBitrate) {
      ffArgs.push('-b:v', output.videoBitrate);
    }
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 将多轨素材合成为最终 MP4。
 *
 * Pass 1: concat 拼接视频
 * Pass 2: audio mix + subtitle burn + mux → 输出
 */
export async function composeVideo(input: ComposeInput): Promise<ComposeResult> {
  const { videoClips, narrations, bgm, subtitles, output } = input;
  const resolvedTimeoutMs = typeof output.timeoutMs === 'number'
    && Number.isFinite(output.timeoutMs)
    && output.timeoutMs > 0
    ? output.timeoutMs
    : 10 * 60 * 1000;

  if (videoClips.length === 0) {
    throw new Error('composeVideo: 至少需要一个视频片段');
  }

  const workDir = join(dirname(output.path), `.compose-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(output.path), { recursive: true });

  const totalDurationSec = input.totalDurationSec
    ?? videoClips.reduce((sum, c) => sum + c.durationSec, 0);

  try {
    // ── Pass 1: Concat 视频片段 ──────────────────────────────────
    input.onProgress?.(5);

    let concatVideoPath: string;

    if (videoClips.length === 1) {
      concatVideoPath = videoClips[0].path;
    } else {
      concatVideoPath = join(workDir, 'concat_video.mp4');
      const concatListPath = join(workDir, 'concat_list.txt');
      const concatContent = videoClips
        .map(c => `file '${c.path.replace(/'/g, "'\\''")}'`)
        .join('\n');
      writeFileSync(concatListPath, concatContent);

      const concatResult = await runFFmpeg({
        args: [
          '-y', '-f', 'concat', '-safe', '0',
          '-i', concatListPath,
          '-c', 'copy', '-an',
          concatVideoPath,
        ],
        timeoutMs: resolvedTimeoutMs,
      });

      if (concatResult.exitCode !== 0) {
        throw new Error(`视频拼接失败: ${concatResult.stderr.slice(-500)}`);
      }
    }

    input.onProgress?.(20);

    // ── 无音频、无字幕的快速路径 ──────────────────────────────────
    const hasAudio = narrations.length > 0 || bgm;
    const hasSubs = subtitles && subtitles.length > 0;
    const needsTranscode = Boolean(
      output.quality
      || output.codec
      || output.format
      || output.videoBitrate
      || output.audioBitrate,
    );

    if (!hasAudio && !hasSubs && !needsTranscode) {
      if (concatVideoPath !== output.path) {
        const cpResult = await runFFmpeg({
          args: ['-y', '-i', concatVideoPath, '-c', 'copy', output.path],
          timeoutMs: resolvedTimeoutMs,
        });
        if (cpResult.exitCode !== 0) {
          throw new Error(`视频复制失败: ${cpResult.stderr.slice(-500)}`);
        }
      }
      input.onProgress?.(100);
      const stat = statSync(output.path);
      return { outputPath: output.path, durationSec: totalDurationSec, fileSizeBytes: stat.size };
    }

    // ── Pass 2: Audio mix + subtitle burn ─────────────────────────
    const audioMix = buildAudioMixFilter({
      narrations,
      bgm,
      totalDurationSec,
      firstInputIndex: 1,
    });
    const inputs: string[] = ['-y', '-i', concatVideoPath];
    for (const p of audioMix.inputPaths) {
      inputs.push('-i', p);
    }
    const filterParts: string[] = [...audioMix.filterParts];
    const finalAudioLabel = audioMix.finalAudioLabel;

    // ── 字幕处理 ─────────────────────────────────────────────────
    let videoMapLabel = 'vout';
    const videoFilters = [
      `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
      `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${output.fps}`,
      'setsar=1',
    ];
    if (hasSubs) {
      const assPath = join(workDir, 'subtitles.ass');
      const assContent = generateAssSubtitles(subtitles!, output.width, output.height);
      writeFileSync(assPath, assContent);
      const escaped = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "'\\''");
      videoFilters.push(`ass='${escaped}'`);
    }
    filterParts.push(`[0:v]${videoFilters.join(',')}[vout]`);

    // ── 构建 FFmpeg 命令 ─────────────────────────────────────────
    const filterComplex = filterParts.join(';\n');
    const ffArgs = [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', `[${videoMapLabel}]`,
    ];

    if (finalAudioLabel) {
      ffArgs.push('-map', `[${finalAudioLabel}]`);
    }

    pushVideoEncodeArgs(ffArgs, output);

    const outputFormat = output.format ?? (output.codec === 'vp8' || output.codec === 'vp9' ? 'webm' : 'mp4');
    if (finalAudioLabel) {
      if (outputFormat === 'webm') {
        ffArgs.push('-c:a', 'libopus', '-b:a', output.audioBitrate ?? '160k');
      } else {
        ffArgs.push('-c:a', 'aac', '-b:a', output.audioBitrate ?? '192k', '-ac', '2', '-ar', '48000');
      }
    }
    if (outputFormat === 'mp4') {
      ffArgs.push('-movflags', '+faststart');
    }
    ffArgs.push('-shortest', output.path);

    input.onProgress?.(30);

    const result = await runFFmpeg({
      args: ffArgs,
      timeoutMs: resolvedTimeoutMs,
      totalDurationMs: totalDurationSec * 1000,
      onProgress: (pct) => {
        input.onProgress?.(30 + Math.round(pct * 0.65));
      },
    });

    if (result.exitCode !== 0) {
      throw new Error(`FFmpeg 合成失败: ${result.stderr.slice(-800)}`);
    }

    input.onProgress?.(98);

    const stat = statSync(output.path);
    input.onProgress?.(100);

    return {
      outputPath: output.path,
      durationSec: totalDurationSec,
      fileSizeBytes: stat.size,
    };
  } finally {
    try {
      const { rm } = await import('node:fs/promises');
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

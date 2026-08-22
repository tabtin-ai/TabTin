/**
 * 独立 BGM 生成端点
 *
 * 通过 Django MiniMax API 生成背景音乐。
 */

import { join, dirname } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { CapabilityResult, ExecutionContext } from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export interface BgmStandaloneInput {
  style: string;
  durationSec?: number;
  outputPath?: string;
  organizationId?: string;
}

export interface BgmStandaloneData {
  audioPath: string;
  duration: number;
  style: string;
}

export async function bgmStandalone(
  input: BgmStandaloneInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<BgmStandaloneData>> {
  const startTime = Date.now();
  const durationSec = input.durationSec ?? 30;

  ctx.publishProgress?.({ phase: 'bgm', percent: 10, detail: '生成背景音乐...' });

  const knownPresets = ['tech', 'data', 'narrative', 'energetic', 'calm', 'corporate'];
  const isPreset = knownPresets.includes(input.style.toLowerCase());

  const response = await ctx.djangoRequest('POST', '/api/services/music/generate/', {
    prompt: isPreset ? '' : input.style,
    style: isPreset ? input.style.toLowerCase() : '',
    target_duration: durationSec,
    provider: 'minimax',
    organization_id: input.organizationId ?? '',
  }, { timeout: 180_000 });

  if (response.status >= 400) {
    const body = response.data as Record<string, unknown> | undefined;
    const msg = (body as any)?.message ?? (body as any)?.detail ?? 'BGM 生成失败';
    throw new Error(`BGM 生成失败 (HTTP ${response.status}): ${msg}`);
  }

  const result = (response.data as any)?.data ?? response.data;
  if (!result?.audioData) {
    throw new Error('BGM 返回无音频数据');
  }

  const audioBytes = Buffer.from(result.audioData, 'base64');
  if (audioBytes.length === 0) {
    throw new Error('BGM 返回空音频数据');
  }

  const outputPath = input.outputPath ?? join(ctx.outputDir ?? '/tmp', `bgm-${Date.now()}.wav`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, audioBytes);

  const duration = result.measuredDuration ?? durationSec;

  ctx.publishProgress?.({ phase: 'bgm', percent: 100, detail: 'BGM 生成完成' });

  return {
    localPath: outputPath,
    data: { audioPath: outputPath, duration, style: input.style },
    provenance: createProvenance('video.bgm', { style: input.style, durationSec }, startTime),
  };
}

import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface GenerateMusicInput {
  prompt?: string;
  /** @deprecated Use `style` instead */
  mood?: string;
  /** Target duration in seconds */
  duration?: number;
  /** Style preset key (tech / data / narrative / energetic / calm) or free-form description */
  style?: string;
  /** Target BPM (optional) */
  bpm?: number;
  /** Provider name (default: minimax) */
  provider?: string;
  /** Organization ID for billing */
  organizationId?: string;
}

export interface GenerateMusicData {
  /** Base64-encoded WAV audio data */
  audioData: string;
  /** Measured duration in seconds (ffprobe) */
  durationSec: number;
  /** Detected BPM (0 if unknown) */
  bpm: number;
  /** Music sections metadata */
  sections: Array<{ type: string; start: number; end: number; energy: number }>;
}

/** @internal */
function unwrapDjango(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (rec.success === false) {
      const msg = typeof rec.message === 'string' ? rec.message : '音乐生成请求失败';
      throw new Error(msg);
    }
    if (rec.success === true && rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
      return rec.data as Record<string, unknown>;
    }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

/**
 * BGM / 音乐生成（云端）。
 *
 * 调用 Django `POST /api/services/music/generate/`，返回 base64 编码的 WAV 音频 + 元数据。
 * 后端通过 MiniMax music-2.5 同步生成，耗时 30-120 秒。
 */
export async function generateMusic(
  input: GenerateMusicInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<GenerateMusicData>> {
  const startTime = Date.now();

  const response = await ctx.djangoRequest<Record<string, unknown>>(
    'POST',
    '/api/services/music/generate/',
    {
      prompt: input.prompt ?? '',
      style: input.style ?? input.mood ?? '',
      target_duration: input.duration ?? 60,
      bpm: input.bpm ?? null,
      provider: input.provider ?? 'minimax',
      organization_id: input.organizationId ?? '',
    },
    { timeout: 180_000 },
  );

  if (response.status >= 400) {
    const body = response.data as Record<string, unknown> | undefined;
    const msg = (body as any)?.message ?? (body as any)?.detail ?? JSON.stringify(body).slice(0, 200);
    throw new Error(`音乐生成失败 (HTTP ${response.status}): ${msg}`);
  }

  const payload = unwrapDjango(response.data);

  const audioData = payload.audioData;
  if (typeof audioData !== 'string' || !audioData) {
    throw new Error('音乐生成响应缺少 audioData 字段');
  }

  const durRaw = payload.measuredDuration ?? payload.duration;
  const durationSec =
    typeof durRaw === 'number' && Number.isFinite(durRaw) ? durRaw :
    typeof durRaw === 'string' ? Number.parseFloat(durRaw) : 0;

  const bpm = typeof payload.bpm === 'number' ? payload.bpm : 0;
  const sections = Array.isArray(payload.sections) ? payload.sections as GenerateMusicData['sections'] : [];

  return {
    data: { audioData, durationSec, bpm, sections },
    provenance: createProvenance('audio.music.generate', { ...input }, startTime, {
      prompt: input.prompt,
    }),
    providerMetadata: {},
  };
}

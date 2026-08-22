import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface RecognizeSpeechInput {
  audioUrl?: string;
  audioData?: string;
  language?: string;
  provider?: string;
  mode?: 'flash' | 'standard';
  enableSpeaker?: boolean;
}

export interface RecognizeSpeechData {
  text: string;
  segments?: Array<{ startMs: number; endMs: number; text: string; speaker?: string }>;
  language?: string;
}

export interface SubmitASRInput {
  audioUrl: string;
  language?: string;
  provider?: string;
  audioFormat?: string;
  callbackUrl?: string;
  callbackData?: string;
}

/** @internal */
function assertDjangoSuccess(raw: unknown): void {
  if (raw && typeof raw === 'object' && 'success' in raw && (raw as { success?: boolean }).success === false) {
    const rec = raw as Record<string, unknown>;
    const msg = typeof rec.message === 'string' ? rec.message : '语音识别请求失败';
    throw new Error(msg);
  }
}

/** @internal 兼容 `{ success, data }` 与扁平 JSON */
function unwrapDjangoData<T extends Record<string, unknown>>(raw: unknown): T {
  assertDjangoSuccess(raw);
  if (
    raw &&
    typeof raw === 'object' &&
    'success' in raw &&
    (raw as { success?: boolean }).success === true &&
    'data' in raw
  ) {
    const inner = (raw as { data: unknown }).data;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner as T;
    }
  }
  return raw as T;
}

/** @internal 将 Django ASR utterance（camelCase）映射为能力层 segments */
function mapUtterancesToSegments(
  utterances: unknown,
): RecognizeSpeechData['segments'] | undefined {
  if (!Array.isArray(utterances) || utterances.length === 0) return undefined;
  const segments: NonNullable<RecognizeSpeechData['segments']> = [];
  for (const u of utterances) {
    if (!u || typeof u !== 'object') continue;
    const o = u as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text : '';
    const startMs = typeof o.startTime === 'number' ? o.startTime : Number(o.startTime);
    const endMs = typeof o.endTime === 'number' ? o.endTime : Number(o.endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    let speaker: string | undefined;
    if (o.speakerId !== undefined && o.speakerId !== null) {
      speaker = String(o.speakerId);
    } else if (typeof o.speaker === 'string') {
      speaker = o.speaker;
    }
    segments.push({ startMs, endMs, text, speaker });
  }
  return segments.length ? segments : undefined;
}

function mapAsrResultPayload(payload: Record<string, unknown>): RecognizeSpeechData {
  const text = typeof payload.text === 'string' ? payload.text : '';
  const language = typeof payload.language === 'string' ? payload.language : undefined;
  return {
    text,
    language,
    segments: mapUtterancesToSegments(payload.utterances),
  };
}

/**
 * 同步语音识别（极速版 flash / 标准版由 `mode` 决定）— Django `speech` ASR。
 *
 * Cloud capability — `POST /api/services/speech/recognize/`
 */
export async function recognizeSpeech(
  input: RecognizeSpeechInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<RecognizeSpeechData>> {
  const startTime = Date.now();

  const response = await ctx.djangoRequest<Record<string, unknown>>(
    'POST',
    '/api/services/speech/recognize/',
    {
      audio_url: input.audioUrl,
      audio_data: input.audioData,
      language: input.language ?? '',
      provider: input.provider ?? 'bytedance',
      mode: input.mode ?? 'flash',
      enable_speaker_info: input.enableSpeaker,
      /** Django Schema 必填；空字符串时 ServiceGuard / 计费部分检查跳过，宿主宜在代理层注入真实 team */
      organization_id: '',
    },
  );

  const payload = unwrapDjangoData<Record<string, unknown>>(response.data);
  const data = mapAsrResultPayload(payload);

  return {
    data,
    provenance: createProvenance('audio.asr.recognize', { ...input }, startTime, {
      prompt: data.text.slice(0, 500),
    }),
    providerMetadata: {
      bytedance: { mode: input.mode ?? 'flash' },
    },
  };
}

/**
 * 异步提交长音频识别（标准版）— Django `speech` ASR。
 *
 * Cloud capability — `POST /api/services/speech/submit/`
 */
export async function submitASR(
  input: SubmitASRInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<{ taskId: string }>> {
  const startTime = Date.now();

  const response = await ctx.djangoRequest<Record<string, unknown>>(
    'POST',
    '/api/services/speech/submit/',
    {
      audio_url: input.audioUrl,
      language: input.language ?? '',
      audio_format: input.audioFormat ?? 'mp3',
      provider: input.provider ?? 'bytedance',
      callback_url: input.callbackUrl,
      callback_data: input.callbackData,
      organization_id: '',
    },
  );

  const payload = unwrapDjangoData<Record<string, unknown>>(response.data);
  const taskIdRaw = payload.taskId ?? payload.task_id;
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw : String(taskIdRaw ?? '');
  if (!taskId) {
    throw new Error('ASR submit 响应缺少 taskId');
  }

  return {
    data: { taskId },
    provenance: createProvenance('audio.asr.submit', { ...input }, startTime, {
      taskId,
    }),
    providerMetadata: {
      bytedance: { taskId },
    },
  };
}

/**
 * 查询异步 ASR 任务结果（标准版）。
 *
 * Cloud capability — `POST /api/services/speech/query/`
 */
export async function queryASR(
  input: { taskId: string; provider?: string },
  ctx: ExecutionContext,
): Promise<CapabilityResult<RecognizeSpeechData>> {
  const startTime = Date.now();

  const response = await ctx.djangoRequest<Record<string, unknown>>(
    'POST',
    '/api/services/speech/query/',
    {
      task_id: input.taskId,
      provider: input.provider ?? 'bytedance',
      organization_id: '',
    },
  );

  const payload = unwrapDjangoData<Record<string, unknown>>(response.data);
  const status = typeof payload.status === 'string' ? payload.status : '';

  if (status === 'completed' && payload.result && typeof payload.result === 'object') {
    const data = mapAsrResultPayload(payload.result as Record<string, unknown>);
    return {
      data,
      provenance: createProvenance(
        'audio.asr.query',
        { taskId: input.taskId, provider: input.provider },
        startTime,
        {
          taskId: input.taskId,
          prompt: data.text.slice(0, 500),
        },
      ),
      providerMetadata: {
        bytedance: { taskId: input.taskId, status },
      },
    };
  }

  if (status === 'failed' || status === 'silent') {
    const err =
      typeof payload.errorMessage === 'string'
        ? payload.errorMessage
        : typeof payload.error_message === 'string'
          ? payload.error_message
          : `ASR 任务 ${status}`;
    throw new Error(err);
  }

  throw new Error(
    `ASR 任务尚未完成（status=${status || 'unknown'}），请稍后重试 query`,
  );
}

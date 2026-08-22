import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface TranslateSubtitleInput {
  subtitles: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  targetLanguage: string;
  sourceLanguage?: string;
}

export interface TranslateSubtitleData {
  translatedSubtitles: Array<{
    id: string;
    startMs: number;
    endMs: number;
    originalText: string;
    translatedText: string;
  }>;
}

/**
 * Batch subtitle translation via Django LLM translate API.
 *
 * Cloud capability — delegates to ctx.djangoRequest().
 * Timestamps and cue ids are preserved; only line text is translated.
 *
 * @remarks
 * POST `/api/services/llm/translate` — **路径与响应字段待后端确认**（当前仓库 `apps/services/llm` 下无 `translate` 路由）。
 * 请求体：`{ texts, target_language, source_language? }`（snake_case 与 Django 惯例一致）。
 * 期望响应：`{ translated_texts: string[] }`（与 `texts` 等长）；若后端使用其它字段名，需与此处解析逻辑对齐。
 */
export async function translateSubtitle(
  input: TranslateSubtitleInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<TranslateSubtitleData>> {
  const startTime = Date.now();

  if (input.subtitles.length === 0) {
    return {
      data: { translatedSubtitles: [] },
      provenance: createProvenance('subtitle.translate', { ...input }, startTime),
    };
  }

  const texts = input.subtitles.map((s) => s.text);

  const response = await ctx.djangoRequest<{
    translated_texts?: string[];
    /** 若后端与 `translated_texts` 命名不一致，可在此扩展 */
    texts?: string[];
  }>(
    'POST',
    // 路径待确认：对齐 Django 实际挂载的 LLM 翻译端点后更新注释/路径
    '/api/services/llm/translate',
    {
      texts,
      target_language: input.targetLanguage,
      source_language: input.sourceLanguage,
    },
  );

  const body = response.data;
  const translated = body.translated_texts ?? body.texts;

  if (!Array.isArray(translated) || translated.length !== texts.length) {
    throw new Error(
      `字幕翻译响应格式异常：期望 ${texts.length} 条译文，实际为 ${
        Array.isArray(translated) ? `${translated.length} 条` : '非数组'
      }`,
    );
  }

  const translatedSubtitles = input.subtitles.map((sub, i) => ({
    id: sub.id,
    startMs: sub.startMs,
    endMs: sub.endMs,
    originalText: sub.text,
    translatedText: translated[i] ?? '',
  }));

  const promptPreview = texts.join('\n').slice(0, 500);

  return {
    data: { translatedSubtitles },
    provenance: createProvenance('subtitle.translate', { ...input }, startTime, {
      prompt: promptPreview.length > 0 ? promptPreview : undefined,
    }),
  };
}

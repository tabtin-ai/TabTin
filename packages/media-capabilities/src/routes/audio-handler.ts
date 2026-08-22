/**
 * Audio/Speech 共享路由 handler。
 *
 * TTS 通过 synthesizeSpeech 能力函数调用，确保 middleware 链生效。
 * ASR / providers / voices 直接代理到 Django。
 *
 * 端点：
 *   POST /(speech|audio)/tts/synthesize  → TTS（通过能力函数）
 *   GET  /(speech|audio)/tts/voices      → 音色列表（Django 代理）
 *   GET  /(speech|audio)/tts/providers   → TTS 提供商（Django 代理）
 *   POST /(speech|audio)/recognize       → 同步 ASR（Django 代理）
 *   POST /(speech|audio)/submit          → 异步 ASR 提交（Django 代理）
 *   POST /(speech|audio)/query           → 异步 ASR 查询（Django 代理）
 *   GET  /(speech|audio)/providers       → ASR 提供商（Django 代理）
 *
 * 同时支持 /speech/* 和 /audio/* 前缀，为 CLI 命名空间迁移做准备。
 */

import { synthesizeSpeech, type SynthesizeSpeechInput } from '../audio/tts.js';
import type { ExecutionContext } from '../types.js';
import { errorResponse } from './error.js';
import type { RouteHandler, DjangoRequestFn } from './types.js';

const DJANGO_PREFIX = '/api/services/speech';

const ALLOWED_ROUTES = new Set([
  '/recognize',
  '/submit',
  '/query',
  '/providers',
  '/tts/synthesize',
  '/tts/providers',
  '/tts/voices',
]);

function normalizeRoute(raw: string): string {
  const stripped = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  return stripped || '/';
}

function wrapDjangoResponse(djangoData: any): any {
  if (!djangoData || typeof djangoData !== 'object') return djangoData;
  if (djangoData.success === false) return djangoData;
  if (djangoData.success === true) {
    if (djangoData.data !== undefined && typeof djangoData.data === 'object' && !Array.isArray(djangoData.data)) {
      return djangoData;
    }
    const { success, ...rest } = djangoData;
    return { success: true, data: rest };
  }
  return { success: true, data: djangoData };
}

export interface AudioHandlerDeps {
  djangoRequest: DjangoRequestFn;
  logTag?: string;
}

export function createAudioHandler(deps: AudioHandlerDeps): RouteHandler {
  const { djangoRequest } = deps;
  const logTag = deps.logTag ?? '[CLI Audio]';

  function buildCtx(): ExecutionContext {
    return {
      djangoRequest: async (method, path, body) => {
        const result = await djangoRequest(method, path, body, { logTag });
        return { status: result.status, data: result.data };
      },
      outputDir: '/tmp',
    };
  }

  return async (url, method, body, res, sendJSON) => {
    const route = normalizeRoute(
      url.replace(/^\/(speech|audio)/, '').split('?')[0],
    );

    if (!ALLOWED_ROUTES.has(route)) {
      sendJSON(res, 404, errorResponse('NOT_FOUND', `未知的语音路由: ${url}`, {
        suggestions: ['使用 tabtin speech --help 查看可用命令'],
      }));
      return;
    }

    // ── TTS: 通过 synthesizeSpeech 能力函数 ──────────────────────
    if (route === '/tts/synthesize' && method === 'POST') {
      if (!body?.text) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 text 参数', {
          suggestions: ['tabtin speech tts "要合成的文本"'],
        }));
        return;
      }

      try {
        const ctx = buildCtx();
        const input: SynthesizeSpeechInput = {
          text: body.text,
          speaker: body.speaker,
          language: body.language,
          format: body.format,
          organizationId: body.organization_id,
        };

        const capResult = await synthesizeSpeech(input, ctx);

        sendJSON(res, 200, {
          success: true,
          data: {
            audio_path: capResult.data?.audioPath,
            duration: capResult.data?.durationSec,
            word_timestamps: capResult.data?.wordTimestamps?.map((wt) => ({
              word: wt.word,
              start_ms: wt.startMs,
              end_ms: wt.endMs,
            })),
            provenance: capResult.provenance,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        sendJSON(res, 500, errorResponse('BACKEND_ERROR', `TTS 合成失败: ${message}`));
      }
      return;
    }

    // ── 其他路由: Django 代理 ────────────────────────────────────
    const qs = url.includes('?') ? url.split('?')[1] : '';
    const djangoRoute = `${route}/`;
    const djangoPath = `${DJANGO_PREFIX}${djangoRoute}`;
    const fullPath = qs ? `${djangoPath}?${qs}` : djangoPath;

    const result = await djangoRequest(
      method,
      fullPath,
      method === 'GET' ? undefined : body,
      { logTag },
    );
    sendJSON(res, result.status, wrapDjangoResponse(result.data));
  };
}

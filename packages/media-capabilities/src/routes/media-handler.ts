/**
 * 媒体生成共享路由 handler。
 *
 * POST /media/generate/image 和 /media/generate/video 通过能力层调用，
 * 确保 middleware 链（计费/审计/重试）生效、provenance 自动生成。
 * 任务查询/取消/列表/模型目录仍直接代理到 Django。
 *
 * 端点：
 *   POST /media/generate/image   → 图片生成（异步任务模式）
 *   POST /media/generate/video   → 视频生成（异步任务模式）
 *   GET  /media/tasks/:id        → 任务详情（本地优先，回退 Django）
 *   POST /media/tasks/:id/cancel → 取消任务
 *   GET  /media/tasks            → 任务列表
 *   GET  /media/catalog          → 模型目录
 */

import { randomUUID } from 'node:crypto';
import { TaskManager, type Task } from '../infra/task-manager.js';
import { toErrorMessage } from '../infra/helpers.js';
import {
  MediaSubmitError,
  submitImage,
  type GenerateImageInput,
} from '../image/generate.js';
import { generateVideo, type GenerateVideoInput } from '../video/generate.js';
import type { ExecutionContext } from '../types.js';
import { errorResponse } from './error.js';
import type { RouteHandler, DjangoRequestFn, EventPublisher } from './types.js';

/**
 * 将 Django 代理响应统一为 `{ success, data }` 格式。
 * - success=false 的错误响应原样透传
 * - 已有 data 对象包裹的响应原样透传
 * - 扁平的 success=true 响应提取到 data 中
 */
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
  return djangoData;
}

export interface MediaHandlerDeps {
  djangoRequest: DjangoRequestFn;
  publishEvent?: EventPublisher | null;
  logTag?: string;
  outputDir?: string;
}

export function createMediaHandler(deps: MediaHandlerDeps): RouteHandler {
  const { djangoRequest } = deps;
  const logTag = deps.logTag ?? '[CLI Media]';
  const outputDir = deps.outputDir ?? '/tmp';
  const publishEvent = deps.publishEvent ?? null;
  const DJANGO_PREFIX = '/api/services/media';
  const taskManager = new TaskManager({ processingTimeoutMs: 15 * 60 * 1000 });

  function emitProgress(task: Task, phase: string, percent: number, detail?: string): void {
    taskManager.updateProgress(task.id, phase, percent, detail);
    publishEvent?.('media.generation.progress', {
      task_id: task.id,
      task_type: task.type,
      phase,
      percent,
      ...(detail ? { detail } : {}),
    });
  }

  function emitComplete(task: Task, result: unknown): void {
    taskManager.complete(task.id, result);
    publishEvent?.('media.generation.complete', {
      task_id: task.id,
      task_type: task.type,
      result: result as Record<string, unknown>,
    });
  }

  function emitFailed(task: Task, error: string): void {
    taskManager.fail(task.id, error);
    publishEvent?.('media.generation.failed', {
      task_id: task.id,
      task_type: task.type,
      error,
    });
  }

  function buildCtx(task?: Task): ExecutionContext {
    const context: ExecutionContext = {
      djangoRequest: async (method, path, body, opts) => {
        const result = await djangoRequest(method, path, body, {
          logTag,
          timeout: opts?.timeout,
        });
        return { status: result.status, data: result.data };
      },
      outputDir,
    };
    if (task) {
      context.publishProgress = (info) => {
        emitProgress(task, info.phase, info.percent, info.detail);
      };
    }
    return context;
  }

  return async (url, method, body, res, sendJSON) => {
    // Go CLI 会给 GET 自动附加 organization_id / space_id；路由匹配只看 pathname，
    // 否则 `/tasks/<id>?organization_id=...` 会错落到任务列表分支。
    const pathname = url.split('?', 1)[0];
    const route = pathname.replace(/^\/media/, '');

    // POST /media/generate/image — 通过 generateImage 能力函数
    if (route === '/generate/image' && method === 'POST') {
      if (!body?.prompt) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 prompt 参数', {
          suggestions: ['tabtin media image generate --prompt "描述你要生成的图片"'],
        }));
        return;
      }

      try {
        const input: GenerateImageInput = {
          prompt: body.prompt,
          model: body.model,
          organizationId: typeof body.organization_id === 'string' ? body.organization_id : undefined,
          size: body.size,
          negativePrompt: body.negative_prompt,
          n: body.n,
          seed: body.seed,
        };
        const submitted = await submitImage(input, buildCtx());
        sendJSON(res, 202, {
          success: true,
          data: {
            task_id: submitted.taskId,
            status: submitted.status,
          },
        });
      } catch (err: unknown) {
        const status = err instanceof MediaSubmitError ? err.status : 500;
        sendJSON(res, status, errorResponse('MEDIA_SUBMIT_FAILED', toErrorMessage(err)));
      }
      return;
    }

    // POST /media/generate/video — 通过 generateVideo 能力函数
    if (route === '/generate/video' && method === 'POST') {
      if (!body?.prompt) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 prompt 参数', {
          suggestions: ['tabtin media generate-video --prompt "描述你要生成的视频"'],
        }));
        return;
      }

      const taskId = randomUUID();
      const task = taskManager.create(taskId, 'video_generate');
      sendJSON(res, 202, { success: true, data: { task_id: taskId, status: 'processing' } });

      void (async () => {
        try {
          const ctx = buildCtx(task);
          const input: GenerateVideoInput = {
            prompt: body.prompt,
            model: body.model,
            size: body.size,
            duration: body.duration,
            imageUrl: body.image_url ?? body.image,
            audioUrl: body.audio_url ?? body.audio,
            negativePrompt: body.negative_prompt ?? body.negative,
            seed: body.seed,
            promptExtend: body.prompt_extend,
          };

          const capResult = await generateVideo(input, ctx);
          emitComplete(task, {
            video_url: capResult.data?.videoUrl ?? '',
            provenance: capResult.provenance,
          });
        } catch (err: unknown) {
          emitFailed(task, toErrorMessage(err));
        }
      })();
      return;
    }

    // GET /media/tasks/<task_id> — 先查本地 TaskManager，回退 Django
    const taskDetailMatch = route.match(/^\/tasks\/([a-f0-9-]+)$/);
    if (taskDetailMatch && method === 'GET') {
      const queriedId = taskDetailMatch[1];
      const localTask = taskManager.get(queriedId);
      if (localTask) {
        sendJSON(res, 200, { success: true, data: TaskManager.formatResult(localTask) });
        return;
      }
      const result = await djangoRequest('GET', `${DJANGO_PREFIX}/tasks/${queriedId}`, undefined, { logTag });
      sendJSON(res, result.status, wrapDjangoResponse(result.data));
      return;
    }

    // POST /media/tasks/<task_id>/cancel
    const cancelMatch = route.match(/^\/tasks\/([a-f0-9-]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const cancelId = cancelMatch[1];
      const result = await djangoRequest('POST', `${DJANGO_PREFIX}/tasks/${cancelId}/cancel`, undefined, { logTag });
      sendJSON(res, result.status, wrapDjangoResponse(result.data));
      return;
    }

    // GET /media/tasks?task_type=...&status=...&limit=...
    if (route.startsWith('/tasks') && method === 'GET') {
      const qs = url.includes('?') ? url.split('?')[1] : '';
      const result = await djangoRequest('GET', `${DJANGO_PREFIX}/tasks${qs ? '?' + qs : ''}`, undefined, { logTag });
      sendJSON(res, result.status, wrapDjangoResponse(result.data));
      return;
    }

    // GET /media/catalog?task_type=...
    if (route.startsWith('/catalog') && method === 'GET') {
      const qs = url.includes('?') ? url.split('?')[1] : '';
      const result = await djangoRequest('GET', `${DJANGO_PREFIX}/catalog${qs ? '?' + qs : ''}`, undefined, { logTag });
      sendJSON(res, result.status, wrapDjangoResponse(result.data));
      return;
    }

    sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的媒体路由: ${url}`, {
      suggestions: ['请检查命令拼写', '使用 tabtin media --help 查看可用命令'],
    }));
  };
}

/**
 * Cloud-only video routes. Local tabvideo-engine endpoints were removed.
 *
 *   POST /video/generate         — 云端视频生成（异步）
 *   GET  /video/tasks/{task_id}  — 查询异步任务状态
 *   POST /video/bgm              — Django BGM 生成（同步）
 */

import { randomUUID } from 'node:crypto';
import { TaskManager, type Task } from '../infra/task-manager.js';
import { toErrorMessage } from '../infra/helpers.js';
import { generateVideo, type GenerateVideoInput } from '../video/generate.js';
import type { ExecutionContext, DjangoResponse } from '../types.js';
import { errorResponse } from './error.js';
import type { RouteHandler, EventPublisher, DjangoRequestFn } from './types.js';

function unsupportedDjangoRequest(): Promise<DjangoResponse> {
  throw new Error('djangoRequest 未注入，无法调用云端视频能力');
}

export interface VideoHandlerDeps {
  publishEvent?: EventPublisher | null;
  djangoRequest?: DjangoRequestFn;
  outputDir?: string;
}

export interface VideoHandlerInstance {
  handler: RouteHandler;
  setPublishEvent: (pub: EventPublisher) => void;
  getActiveTaskCount: () => number;
  shutdown: () => void;
}

export function createVideoHandler(deps: VideoHandlerDeps = {}): VideoHandlerInstance {
  const taskManager = new TaskManager({ processingTimeoutMs: 10 * 60 * 1000 });
  let publishEvent: EventPublisher | null = deps.publishEvent ?? null;
  const outputDir = deps.outputDir ?? '/tmp';

  function emitProgress(task: Task, phase: string, percent: number, detail?: string): void {
    taskManager.updateProgress(task.id, phase, percent, detail);
    publishEvent?.('media.pipeline.progress', {
      task_id: task.id,
      task_type: task.type,
      phase,
      percent,
      ...(detail ? { detail } : {}),
      ...(task.meta?.thread_id ? { thread_id: task.meta.thread_id as string } : {}),
    });
  }

  function emitComplete(task: Task, result: unknown): void {
    taskManager.complete(task.id, result);
    publishEvent?.('media.pipeline.complete', {
      task_id: task.id,
      task_type: task.type,
      result: result as Record<string, unknown>,
      ...(task.meta?.thread_id ? { thread_id: task.meta.thread_id as string } : {}),
    });
  }

  function emitFailed(task: Task, error: string): void {
    taskManager.fail(task.id, error);
    publishEvent?.('media.pipeline.failed', {
      task_id: task.id,
      task_type: task.type,
      error,
      ...(task.meta?.thread_id ? { thread_id: task.meta.thread_id as string } : {}),
    });
  }

  function buildCtx(task: Task): ExecutionContext {
    return {
      djangoRequest: deps.djangoRequest ?? unsupportedDjangoRequest,
      outputDir,
      publishProgress: (info) => {
        emitProgress(task, info.phase, info.percent, info.detail);
      },
    };
  }

  const handler: RouteHandler = async (url, method, body, res, sendJSON) => {
    const [urlPath, queryString] = url.split('?');
    const route = urlPath.replace(/^\/video/, '');
    const queryParams = new URLSearchParams(queryString ?? '');

    if (route === '/generate' && method === 'POST') {
      if (!body?.prompt || typeof body.prompt !== 'string') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 prompt 参数', {
          suggestions: ['POST /video/generate { "prompt": "..." }'],
        }));
        return;
      }

      const taskId = randomUUID();
      const meta = body.thread_id ? { thread_id: body.thread_id } : undefined;
      const task = taskManager.create(taskId, 'generate', meta);
      sendJSON(res, 202, { success: true, data: { task_id: taskId, status: 'processing' } });

      void (async () => {
        try {
          const input: GenerateVideoInput = {
            prompt: body.prompt,
            model: typeof body.model === 'string' ? body.model : undefined,
            size: typeof body.size === 'string' ? body.size : undefined,
            duration: typeof body.duration === 'number' ? body.duration : undefined,
            imageUrl: typeof body.image_url === 'string' ? body.image_url : body.imageUrl,
            audioUrl: typeof body.audio_url === 'string' ? body.audio_url : body.audioUrl,
            negativePrompt: typeof body.negative_prompt === 'string' ? body.negative_prompt : body.negativePrompt,
            seed: typeof body.seed === 'number' ? body.seed : undefined,
            promptExtend: body.prompt_extend === true || body.promptExtend === true,
          };
          const capResult = await generateVideo(input, buildCtx(task));
          emitComplete(task, capResult.data);
        } catch (err: unknown) {
          emitFailed(task, toErrorMessage(err));
        }
      })();
      return;
    }

    const tasksMatch = route.match(/^\/tasks\/([^/]+)$/);
    const tasksQueryId = route === '/tasks' && method === 'GET'
      ? (body?.id as string | undefined) ?? (body?.task_id as string | undefined)
        ?? queryParams.get('id') ?? queryParams.get('task_id')
      : undefined;
    const resolvedTaskId = tasksMatch?.[1] ?? tasksQueryId ?? undefined;
    if (resolvedTaskId && method === 'GET') {
      const task = taskManager.get(resolvedTaskId);
      if (!task) {
        sendJSON(res, 404, errorResponse('NOT_FOUND', `任务 ${resolvedTaskId} 不存在或已过期`));
        return;
      }
      sendJSON(res, 200, { success: true, data: TaskManager.formatResult(task) });
      return;
    }

    if (route === '/bgm' && method === 'POST') {
      const style = body?.style as string | undefined;
      if (!style || typeof style !== 'string') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 style 参数', {
          suggestions: ['tabtin video bgm --style tech --duration 30'],
        }));
        return;
      }

      try {
        const { bgmStandalone } = await import('../video/bgm-standalone.js');
        const ctx: ExecutionContext = {
          djangoRequest: deps.djangoRequest ?? unsupportedDjangoRequest,
          outputDir,
        };
        const result = await bgmStandalone({
          style,
          durationSec: typeof body.duration === 'number' ? body.duration
            : typeof body.duration_sec === 'number' ? body.duration_sec : undefined,
          outputPath: typeof body.output_path === 'string' ? body.output_path
            : typeof body.output === 'string' ? body.output : undefined,
          organizationId: typeof body.organization_id === 'string' ? body.organization_id : undefined,
        }, ctx);
        sendJSON(res, 200, { success: true, data: result.data });
      } catch (err: unknown) {
        sendJSON(res, 500, errorResponse('BGM_ERROR', `BGM 生成失败: ${toErrorMessage(err)}`));
      }
      return;
    }

    sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的视频路由: ${url}`, {
      suggestions: ['请检查命令拼写', '使用 tabtin video --help 查看可用命令'],
    }));
  };

  return {
    handler,
    setPublishEvent: (pub: EventPublisher) => { publishEvent = pub; },
    getActiveTaskCount: () => taskManager.getActiveCount(),
    shutdown: () => {
      taskManager.shutdown((task) => {
        publishEvent?.('media.pipeline.failed', {
          task_id: task.id,
          task_type: task.type,
          error: task.error ?? '进程关闭，任务被中断',
          ...(task.meta?.thread_id ? { thread_id: task.meta.thread_id as string } : {}),
        });
      });
    },
  };
}

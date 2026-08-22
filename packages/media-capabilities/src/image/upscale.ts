import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance, pollDjangoTask, type DjangoTaskResult } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface UpscaleImageInput {
  imageUrl: string;
  scale?: 2 | 4;
}

export interface UpscaleImageData {
  imageUrl: string;
  width: number;
  height: number;
}

const UPSCALE_PATH = '/api/services/media/upscale/image';
// TODO: Django 端点路径待确认（与后端 media 服务对齐）

function pickImageUrlFromTask(tr: DjangoTaskResult): string {
  const urls = tr.result_urls ?? (tr.result_url ? [tr.result_url] : []);
  return urls[0] ?? '';
}

function pickDimensions(tr: Record<string, unknown>): { width: number; height: number } {
  const nested = tr.result && typeof tr.result === 'object' ? (tr.result as Record<string, unknown>) : undefined;
  const w = tr.width ?? tr.result_width ?? nested?.width;
  const h = tr.height ?? tr.result_height ?? nested?.height;
  const width = typeof w === 'number' ? w : Number(w) || 0;
  const height = typeof h === 'number' ? h : Number(h) || 0;
  return { width, height };
}

function parseSyncUpscalePayload(data: Record<string, unknown>): UpscaleImageData | null {
  const imageUrl =
    (typeof data.image_url === 'string' && data.image_url) ||
    (typeof data.result_url === 'string' && data.result_url) ||
    (Array.isArray(data.result_urls) && typeof data.result_urls[0] === 'string'
      ? (data.result_urls[0] as string)
      : '');
  if (!imageUrl) return null;
  const { width, height } = pickDimensions(data);
  return { imageUrl, width, height };
}

/**
 * 图片超分辨率（云端）。
 *
 * 提交后若返回 `task_id` 则轮询 `/api/services/media/tasks/:id` 直至完成。
 * 若 Django 同步返回结果 URL 与尺寸，则直接解析（无需轮询）。
 *
 * 路径待后端对齐 — 实现以 `generateImage` 为参照。
 */
export async function upscaleImage(
  input: UpscaleImageInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<UpscaleImageData>> {
  const startTime = Date.now();

  ctx.publishProgress?.({ phase: 'submitting', percent: 5, detail: '提交图片超分任务...' });

  const submitRes = await ctx.djangoRequest<Record<string, unknown>>('POST', UPSCALE_PATH, {
    image_url: input.imageUrl,
    scale: input.scale ?? 2,
  });

  const raw = submitRes.data;
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;

  if (taskId) {
    ctx.publishProgress?.({ phase: 'polling', percent: 10, detail: `任务已提交 (${taskId})` });

    const taskResult = await pollDjangoTask(ctx, taskId, {
      onProgress: (info) => ctx.publishProgress?.(info),
    });

    const imageUrl = pickImageUrlFromTask(taskResult);
    const { width, height } = pickDimensions(taskResult as Record<string, unknown>);

    const params = taskResult.parameters as Record<string, unknown> | undefined;
    const providerName =
      (typeof params?._llm_provider_name === 'string' && params._llm_provider_name) || 'dashscope';

    return {
      url: imageUrl,
      data: { imageUrl, width, height },
      width: width || undefined,
      height: height || undefined,
      provenance: createProvenance('image.upscale', { ...input }, startTime, {
        taskId,
      }),
      providerMetadata: {
        [providerName]: { taskId },
      },
    };
  }

  const sync = parseSyncUpscalePayload(raw);
  if (!sync) {
    throw new Error('超分接口未返回 task_id 或可解析的同步结果');
  }

  return {
    url: sync.imageUrl,
    data: sync,
    width: sync.width || undefined,
    height: sync.height || undefined,
    provenance: createProvenance('image.upscale', { ...input }, startTime, {}),
  };
}

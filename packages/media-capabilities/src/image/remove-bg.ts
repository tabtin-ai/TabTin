import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance, pollDjangoTask, type DjangoTaskResult } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface RemoveBackgroundInput {
  imageUrl: string;
}

export interface RemoveBackgroundData {
  imageUrl: string;
  hasMatte: boolean;
}

const REMOVE_BG_PATH = '/api/services/media/remove-background';
// TODO: Django 端点路径待确认（与后端 media 服务对齐）

function pickImageUrlFromTask(tr: DjangoTaskResult): string {
  const urls = tr.result_urls ?? (tr.result_url ? [tr.result_url] : []);
  return urls[0] ?? '';
}

function pickHasMatte(data: Record<string, unknown>): boolean {
  if (typeof data.has_matte === 'boolean') return data.has_matte;
  if (typeof data.hasMatte === 'boolean') return data.hasMatte;
  return false;
}

function parseSyncRemoveBgPayload(data: Record<string, unknown>): RemoveBackgroundData | null {
  const imageUrl =
    (typeof data.image_url === 'string' && data.image_url) ||
    (typeof data.result_url === 'string' && data.result_url) ||
    (Array.isArray(data.result_urls) && typeof data.result_urls[0] === 'string'
      ? (data.result_urls[0] as string)
      : '');
  if (!imageUrl) return null;
  return { imageUrl, hasMatte: pickHasMatte(data) };
}

/**
 * 图片去背景（云端）。
 *
 * 异步时轮询 Django 任务；同步时解析 `image_url` 与 `has_matte` / `hasMatte`。
 */
export async function removeBackground(
  input: RemoveBackgroundInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<RemoveBackgroundData>> {
  const startTime = Date.now();

  ctx.publishProgress?.({ phase: 'submitting', percent: 5, detail: '提交去背景任务...' });

  const submitRes = await ctx.djangoRequest<Record<string, unknown>>('POST', REMOVE_BG_PATH, {
    image_url: input.imageUrl,
  });

  const raw = submitRes.data;
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;

  if (taskId) {
    ctx.publishProgress?.({ phase: 'polling', percent: 10, detail: `任务已提交 (${taskId})` });

    const taskResult = await pollDjangoTask(ctx, taskId, {
      onProgress: (info) => ctx.publishProgress?.(info),
    });

    const imageUrl = pickImageUrlFromTask(taskResult);
    const hasMatte = pickHasMatte(taskResult as Record<string, unknown>);

    const params = taskResult.parameters as Record<string, unknown> | undefined;
    const providerName =
      (typeof params?._llm_provider_name === 'string' && params._llm_provider_name) || 'dashscope';

    return {
      url: imageUrl,
      data: { imageUrl, hasMatte },
      mimeType: 'image/png',
      provenance: createProvenance('image.removeBackground', { ...input }, startTime, {
        taskId,
      }),
      providerMetadata: {
        [providerName]: { taskId },
      },
    };
  }

  const sync = parseSyncRemoveBgPayload(raw);
  if (!sync) {
    throw new Error('去背景接口未返回 task_id 或可解析的同步结果');
  }

  return {
    url: sync.imageUrl,
    data: sync,
    mimeType: 'image/png',
    provenance: createProvenance('image.removeBackground', { ...input }, startTime, {}),
  };
}

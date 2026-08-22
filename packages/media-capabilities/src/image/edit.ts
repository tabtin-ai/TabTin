import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance, pollDjangoTask, type DjangoTaskResult } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface EditImageInput {
  imageUrl: string;
  prompt: string;
  editType?: 'inpaint' | 'outpaint' | 'style_transfer';
  mask?: string;
}

export interface EditImageData {
  imageUrl: string;
}

const EDIT_PATH = '/api/services/media/edit/image';
// TODO: Django 端点路径待确认（与后端 media 服务对齐）

function pickImageUrlFromTask(tr: DjangoTaskResult): string {
  const urls = tr.result_urls ?? (tr.result_url ? [tr.result_url] : []);
  return urls[0] ?? '';
}

function parseSyncEditPayload(data: Record<string, unknown>): string | null {
  if (typeof data.image_url === 'string' && data.image_url) return data.image_url;
  if (typeof data.result_url === 'string' && data.result_url) return data.result_url;
  if (Array.isArray(data.result_urls) && typeof data.result_urls[0] === 'string') {
    return data.result_urls[0] as string;
  }
  return null;
}

/**
 * 图片编辑（inpaint / outpaint / style_transfer 等，云端）。
 *
 * 异步时轮询 Django 任务；同步时直接取 `image_url` / `result_url(s)`。
 */
export async function editImage(
  input: EditImageInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<EditImageData>> {
  const startTime = Date.now();

  ctx.publishProgress?.({ phase: 'submitting', percent: 5, detail: '提交图片编辑任务...' });

  const submitRes = await ctx.djangoRequest<Record<string, unknown>>('POST', EDIT_PATH, {
    image_url: input.imageUrl,
    prompt: input.prompt,
    edit_type: input.editType,
    ...(input.mask != null && input.mask !== '' ? { mask_url: input.mask } : {}),
  });

  const raw = submitRes.data;
  const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;

  if (taskId) {
    ctx.publishProgress?.({ phase: 'polling', percent: 10, detail: `任务已提交 (${taskId})` });

    const taskResult = await pollDjangoTask(ctx, taskId, {
      onProgress: (info) => ctx.publishProgress?.(info),
    });

    const imageUrl = pickImageUrlFromTask(taskResult);

    const params = taskResult.parameters as Record<string, unknown> | undefined;
    const providerName =
      (typeof params?._llm_provider_name === 'string' && params._llm_provider_name) || 'dashscope';

    return {
      url: imageUrl,
      data: { imageUrl },
      provenance: createProvenance('image.edit', { ...input }, startTime, {
        prompt: input.prompt,
        taskId,
      }),
      providerMetadata: {
        [providerName]: { taskId },
      },
    };
  }

  const imageUrl = parseSyncEditPayload(raw);
  if (!imageUrl) {
    throw new Error('图片编辑接口未返回 task_id 或可解析的同步结果');
  }

  return {
    url: imageUrl,
    data: { imageUrl },
    provenance: createProvenance('image.edit', { ...input }, startTime, {
      prompt: input.prompt,
    }),
  };
}

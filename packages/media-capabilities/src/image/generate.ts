import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance, pollDjangoTask } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface GenerateImageInput {
  prompt: string;
  model?: string;
  organizationId?: string;
  size?: string;
  negativePrompt?: string;
  n?: number;
  seed?: number;
}

export interface SubmitImageData {
  taskId: string;
  status: string;
}

export class MediaSubmitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MediaSubmitError';
  }
}

export interface GenerateImageData {
  imageUrls: string[];
  taskId: string;
}

/** catalog 的 `id`（LLMModel UUID）与 `model_name` 都会进 `--model`；按形态拆到 Django 字段。 */
const LLM_MODEL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveMediaModelFields(model?: string): {
  model_id?: string;
  model_name?: string;
} {
  if (!model) return {};
  const trimmed = model.trim();
  if (!trimmed) return {};
  if (LLM_MODEL_UUID_RE.test(trimmed)) {
    return { model_id: trimmed };
  }
  return { model_name: trimmed };
}

/** 把 Django / 网关各种 detail 形态收成可读字符串，避免只剩「未返回媒体任务 ID」。 */
export function extractMediaSubmitDetail(data: unknown): string {
  if (!data || typeof data !== 'object') {
    return '后端未返回媒体任务 ID';
  }
  const record = data as Record<string, unknown>;

  if (typeof record.detail === 'string' && record.detail.trim()) {
    return record.detail;
  }
  if (Array.isArray(record.detail)) {
    const parts = record.detail
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const msg = (item as { msg?: unknown }).msg;
          if (typeof msg === 'string' && msg.trim()) return msg;
        }
        return null;
      })
      .filter((part): part is string => Boolean(part));
    if (parts.length > 0) return parts.join('; ');
  }
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message;
  }
  const err = record.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return '后端未返回媒体任务 ID';
  }
}

/**
 * 提交图片生成任务，不等待媒体处理完成。
 *
 * CLI Server 用这条函数将 Django 的真实 task_id 原样返回给 Go CLI；
 * 后者再经 ``WaitTaskPath`` 轮询，避免本地 UUID 与媒体任务脱节。
 */
export async function submitImage(
  input: GenerateImageInput,
  ctx: ExecutionContext,
): Promise<SubmitImageData> {
  ctx.publishProgress?.({ phase: 'submitting', percent: 5, detail: '提交图片生成任务...' });

  const modelFields = resolveMediaModelFields(input.model);
  const submitRes = await ctx.djangoRequest<{ task_id?: string; status?: string; detail?: unknown }>(
    'POST',
    '/api/services/media/generate/image',
    {
      prompt: input.prompt,
      ...modelFields,
      organization_id: input.organizationId,
      size: input.size,
      negative_prompt: input.negativePrompt,
      n: input.n ?? 1,
      seed: input.seed,
    },
    { timeout: 120_000 },
  );

  if (submitRes.status >= 400 || !submitRes.data.task_id) {
    const detail = extractMediaSubmitDetail(submitRes.data);
    throw new MediaSubmitError(
      `图片生成任务提交失败: ${detail}`,
      submitRes.status >= 400 ? submitRes.status : 502,
    );
  }

  return {
    taskId: submitRes.data.task_id,
    status: submitRes.data.status ?? 'running',
  };
}

/**
 * 通过 Django media_generation API 生成图片。
 *
 * 云端能力 — 提交任务后轮询 Django 异步任务直到完成。
 * 认证由 ctx.djangoRequest() 注入（Electron 用 JWT，Daemon 用设备凭证）。
 */
export async function generateImage(
  input: GenerateImageInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<GenerateImageData>> {
  const startTime = Date.now();

  const { taskId } = await submitImage(input, ctx);

  ctx.publishProgress?.({ phase: 'polling', percent: 10, detail: `任务已提交 (${taskId})` });

  const taskResult = await pollDjangoTask(ctx, taskId, {
    onProgress: (info) => ctx.publishProgress?.(info),
  });

  const resultUrls: string[] =
    taskResult.result_urls ?? (taskResult.result_url ? [taskResult.result_url] : []);

  const params = taskResult.parameters as Record<string, unknown> | undefined;
  const providerName =
    (typeof params?._llm_provider_name === 'string' && params._llm_provider_name) || 'dashscope';

  return {
    url: resultUrls[0],
    data: { imageUrls: resultUrls, taskId },
    provenance: createProvenance('image.generate', { ...input }, startTime, {
      model: input.model,
      prompt: input.prompt,
      taskId,
    }),
    providerMetadata: {
      [providerName]: { taskId },
    },
  };
}

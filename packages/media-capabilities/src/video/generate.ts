import type {
  CapabilityResult,
  ExecutionContext,
  SpecificationVersion,
} from '../types.js';
import { createProvenance, pollDjangoTask } from '../infra/helpers.js';

export const specificationVersion: SpecificationVersion = 'v1';

export interface GenerateVideoInput {
  prompt: string;
  model?: string;
  size?: string;
  duration?: number;
  imageUrl?: string;
  audioUrl?: string;
  negativePrompt?: string;
  seed?: number;
  promptExtend?: boolean;
}

export interface GenerateVideoData {
  videoUrl: string;
  taskId: string;
}

/**
 * 通过 Django media_generation API 生成视频。
 *
 * 云端能力 — 提交任务后轮询 Django 异步任务直到完成。
 * 视频生成通常需要 1–10 分钟。
 */
export async function generateVideo(
  input: GenerateVideoInput,
  ctx: ExecutionContext,
): Promise<CapabilityResult<GenerateVideoData>> {
  const startTime = Date.now();

  ctx.publishProgress?.({ phase: 'submitting', percent: 5, detail: '提交视频生成任务...' });

  const submitRes = await ctx.djangoRequest<{ task_id: string; status: string }>(
    'POST',
    '/api/services/media/generate/video',
    {
      prompt: input.prompt,
      model: input.model,
      size: input.size,
      duration: input.duration,
      image_url: input.imageUrl,
      audio_url: input.audioUrl,
      negative_prompt: input.negativePrompt,
      seed: input.seed,
      prompt_extend: input.promptExtend,
    },
  );

  const taskId = submitRes.data.task_id;

  ctx.publishProgress?.({ phase: 'polling', percent: 10, detail: `任务已提交 (${taskId})` });

  const taskResult = await pollDjangoTask(ctx, taskId, {
    initialIntervalMs: 5000,
    onProgress: (info) => ctx.publishProgress?.(info),
  });

  const videoUrl = taskResult.result_url ?? taskResult.result_urls?.[0] ?? '';

  const params = taskResult.parameters as Record<string, unknown> | undefined;
  const providerName =
    (typeof params?._llm_provider_name === 'string' && params._llm_provider_name) || 'kling';

  return {
    url: videoUrl,
    data: { videoUrl, taskId },
    mimeType: 'video/mp4',
    provenance: createProvenance('video.generate', { ...input }, startTime, {
      model: input.model,
      prompt: input.prompt,
      taskId,
    }),
    providerMetadata: {
      [providerName]: { taskId },
    },
  };
}

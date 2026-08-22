/**
 * Core types for the unified media capability layer.
 *
 * Design principles:
 * - ExecutionContext is injected by the host (Electron/Daemon), capabilities never handle auth directly
 * - CapabilityResult carries provenance for full traceability across product boundaries
 * - specificationVersion enables smooth protocol evolution without breaking consumers
 */

// ---------------------------------------------------------------------------
// Execution Context — injected by the host runtime
// ---------------------------------------------------------------------------

export interface DjangoResponse<T = unknown> {
  status: number;
  data: T;
  headers?: Record<string, string>;
}

/**
 * Injected by the runtime host (Electron or Daemon) before invoking any capability.
 *
 * Electron provides JWT-based auth via TokenManager;
 * Daemon provides device-credential auth.
 * Capabilities never know which host they run in.
 */
export interface DjangoRequestOptions {
  /** Override default timeout (ms). Useful for long-running operations like BGM generation. */
  timeout?: number;
}

export interface ExecutionContext {
  /** Proxy call to Django backend — host injects auth headers. */
  djangoRequest<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: DjangoRequestOptions,
  ): Promise<DjangoResponse<T>>;

  /** Optional progress reporting for long-running tasks. */
  publishProgress?(info: {
    phase: string;
    percent: number;
    detail?: string;
  }): void;

  /**
   * Output directory for generated files.
   * Points to `agent-spaces/{spaceId}/media/` when running in a Space context,
   * or falls back to a temp directory for standalone CLI calls.
   */
  outputDir: string;

  /** 用于取消正在进行的引擎调用或 Django 轮询 */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Capability Result — unified return type with provenance
// ---------------------------------------------------------------------------

/**
 * Core provenance metadata attached to every capability result.
 * Product layers can persist this alongside their own data models
 * to maintain full traceability (e.g., VideoClip.generation_params).
 */
export interface Provenance {
  /** Capability identifier, e.g. "image.generate", "video.analyze" */
  capability: string;
  /** AI model used (if applicable), e.g. "wan2.6-t2i" */
  model?: string;
  /** Original prompt (if applicable) */
  prompt?: string;
  /** All input parameters for reproducibility */
  params?: Record<string, unknown>;
  /** Cloud-side task ID for async operations */
  taskId?: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** Wall-clock execution time in milliseconds */
  durationMs?: number;
}

/**
 * Vendor-specific metadata that doesn't belong in the core Provenance type.
 * Keyed by provider name to avoid polluting the typed interface.
 *
 * Inspired by Vercel AI SDK's providerMetadata pattern — new providers
 * can add their fields here without changing the CapabilityResult interface.
 */
export type ProviderMetadata = {
  dashscope?: Record<string, unknown>;
  kling?: Record<string, unknown>;
  bytedance?: Record<string, unknown>;
  minimax?: Record<string, unknown>;
  elevenlabs?: Record<string, unknown>;
  freesound?: Record<string, unknown>;
  [provider: string]: Record<string, unknown> | undefined;
};

/**
 * Unified result type for all atomic capabilities.
 *
 * Cloud capabilities typically return `url`;
 * local engine capabilities return `localPath`;
 * analysis capabilities return structured `data`.
 * A single result may contain multiple of these.
 */
export interface CapabilityResult<TData = unknown> {
  /** Remote URL (OSS / CDN), set by cloud capabilities */
  url?: string;
  /** Local file path, set by local engine / FFmpeg capabilities */
  localPath?: string;
  /** Structured output data (e.g., SegmentationResult, ReframeAnalysis) */
  data?: TData;

  /** 输出媒体的宽度（像素） */
  width?: number;
  /** 输出媒体的高度（像素） */
  height?: number;
  /** MIME 类型，如 "image/png"、"video/mp4" */
  mimeType?: string;
  /** 文件大小（字节） */
  fileSize?: number;

  /** Core provenance — always present */
  provenance: Provenance;
  /** Vendor-specific metadata — present when relevant */
  providerMetadata?: ProviderMetadata;
}

// ---------------------------------------------------------------------------
// Task Query Result — 统一的任务查询 HTTP 响应格式
// ---------------------------------------------------------------------------

/**
 * 本地 TaskManager 和 Django 回退路径统一映射到此结构，
 * 作为 `{ success: true, data: TaskQueryResult }` 返回给 CLI。
 *
 * 状态约定：processing / succeeded / failed / cancelled
 * （本地 TaskManager 的 completed 映射为 succeeded）
 */
export interface TaskQueryResult {
  task_id: string;
  status: 'processing' | 'succeeded' | 'failed' | 'cancelled';
  task_type?: string;
  progress?: {
    phase: string;
    percent: number;
    detail?: string;
  };
  /** 提取自 result 的媒体 URL 列表（图片/视频生成任务） */
  result_urls?: string[];
  error_message?: string;
  provenance?: Provenance;
  /** 保留完整的原始结果，供需要结构化数据的消费者使用 */
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Specification Version — for protocol evolution
// ---------------------------------------------------------------------------

/**
 * Current specification version for capability interfaces.
 * All capability implementations must declare this version.
 *
 * When the interface needs breaking changes:
 * 1. Define a new version (e.g., 'v2') with updated types
 * 2. Write an adapter: asCapabilityV2(v1Impl) that wraps v1 into v2
 * 3. Consumers can gradually migrate; v1 implementations keep working
 */
export type SpecificationVersion = 'v1';

export const CURRENT_SPECIFICATION_VERSION: SpecificationVersion = 'v1';

// ---------------------------------------------------------------------------
// Capability function signature
// ---------------------------------------------------------------------------

/**
 * Generic type for any capability function.
 * All capabilities follow this shape: (input, context) => Promise<result>.
 */
export type CapabilityFn<TInput = unknown, TData = unknown> = (
  input: TInput,
  ctx: ExecutionContext,
) => Promise<CapabilityResult<TData>>;

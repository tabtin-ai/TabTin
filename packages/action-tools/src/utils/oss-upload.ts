/**
 * 视频/文件 OSS 上传共享工具
 *
 * 两条上传路径（按优先级）：
 * 1. 宿主注入的 uploadToOSS 函数（Electron 环境）
 * 2. @tabtin/oss-client 直接上传（Daemon 环境）
 *
 * 消费方：show_widget 烤图链路等需要把本地产物上传 OSS 的工具。
 *
 * **错误透传约束**（dogfood widget baking_error 复盘）：
 *
 * 历史上 `uploadFileToOSS` 返回 `Promise<string | null>`，所有错误（context_id
 * 校验失败 / token 过期 / 配额超限 / 网络抖动 / OSS 服务异常）都被压成 `null`。
 * 调用方拿到 null 之后只能编一个像 "OSS upload returned null URL" 这种**毫无
 * 信息量的兜底文案**塞给 LLM，最终 LLM 把"小问题"误判成"渲染整体失败"。
 *
 * 现在改成 `Promise<UploadOutcome>` —— 永远返回结构化结果，调用方按需投影：
 *   - 拿 url   → `result.url`（与旧 `string | null` 语义一致）
 *   - 拿原因   → `result.error`（精确错误信息，可以原样塞给 LLM 决策）
 *   - 拿分类   → `result.errorCode`（用于 retry / fallback 路由判断）
 */

import { promises as fsPromises } from 'node:fs';
import { basename } from 'node:path';

export interface OSSUploadOptions {
  folder?: string;
  module?: string;
  contextType?: string;
  /**
   * 业务上下文 ID。Django `confirm-upload` 强制要求 `context_id` 非空（
   * `apps/tabtin_django/apps/services/oss/api.py:2308`），缺失会返回
   * `VALIDATION_ERROR`。调用方**必须**根据自己的业务语义提供：
   *   - widget 烤图 → widget_id
   *   - 临时 / 一次性产物 → 自己造一个 stable id（譬如 `tmp-${nanoid()}`）
   */
  contextId?: string;
  mimeType?: string;
  /**
   * 当前请求归属的 organizationId（per-request 优先）。
   *
   * **优先级**：per-request `opts.organizationId` > daemon `globalThis.tabtin.organizationId` > undefined
   * （Django `_oss_resolve_organization` 退到用户 default organization）。
   *
   * **后两种 fallback 都不可靠**——仅在 daemon 内部任务且能保证
   * "daemon organization = 资源 organization" 时安全（如纯 daemon-internal 烤图任务）。
   * 其他场景（Electron main 跑 ActionTool、cli-server 接 CLI 请求、跨 organization 上传）
   * 必须显式传 per-request organizationId，否则会触发 C9 类 `file_not_in_organization` bug。
   *
   * 历史背景：cli-routes `/oss/upload` body 的 `organization_id` 来自 CLI Go
   * `pipeline.go:1463` 注入（与 CLI `ResolveOrganizationID` 一致），与 daemon 启动时
   * 绑定的 organization 可能不一致（多 profile 切换不重启 daemon 场景）。后端在
   * `exchange_service.py:62-69` 校验 doc import file 时要求 FileRecord 与 import
   * 操作的 organization 一致，不一致会报 `file_not_in_organization` 403。
   *
   * **对于 agent-runtime ActionTool**：params 同时收 `organization_id`（backend SSE payload）
   * 和 `_organization_id`（agent-runtime adapter 从 `ToolContext.organizationId` 注入），透传时用
   * `params.organization_id || params._organization_id || undefined`。
   *
   * **对于 agent-runtime 内部工具**（如 show-widget bake-upload）：直接从
   * `ToolContext.organizationId` 拿，通过函数参数显式传入 `uploadFileToOSS`。
   *
   * **dev mode 诊断**：调用方未传 organizationId 时本函数会 `console.warn` 一次，方便
   * 开发期发现 C9 类隐患（见函数实现内 dev warning）。
   */
  organizationId?: string;
  /** Whether the uploaded object is public-read. TabDoc HTML  must pass false. */
  isPublic?: boolean;
  /** Cancels local file reading, presign, PUT, and confirm. */
  signal?: AbortSignal;
}

/**
 * 上传结果。永远 resolve，不 reject —— 错误体现在 `error` / `errorCode` 字段。
 * 这样调用方写 `if (!result.url) report(result.error)` 就能拿精确原因。
 */
export interface UploadOutcome {
  /** 成功时是 OSS access URL；失败时为 null */
  url: string | null;
  /**
   * 成功时是 OSS FileRecord 主键（= Django `to_response_dict()` 的 `file_id`，
   * `apps/tabtin_django/apps/services/oss/models.py`）。需要回引该文件的调用方
   * （如 `doc import file --file-record-id`）拿这个值。注入路径 / 失败时 undefined。
   */
  fileId?: string;
  /** 成功时是 OSS object key；注入路径 / 失败时 undefined。 */
  fileKey?: string;
  /** 成功时是 CDN URL（可能为空串）；注入路径 / 失败时 undefined。 */
  cdnUrl?: string;
  /** 失败时的人类可读说明（适合塞给 LLM 看）；成功时 undefined */
  error?: string;
  /**
   * 失败原因分类，用于调用方做 retry / fallback 决策：
   *   - `'no-api-base'`           globalThis.tabtin.apiBaseUrl 未注入（Daemon 启动顺序问题）
   *   - `'no-auth'`               无 access token / auth bridge
   *   - `'context-id-required'`   missing contextId（调用方传参 bug）
   *   - `'auth-expired'`          token 401，需要重登
   *   - `'permission-denied'`     权限 403
   *   - `'rate-limit'`            限流 429
   *   - `'quota-exceeded'`        STORAGE_QUOTA_EXCEEDED
   *   - `'billing-blocked'`       BILLING_BLOCKED
   *   - `'oss-put-failed'`        OSS 直传 PUT 失败
   *   - `'confirm-failed'`        confirm-upload 后端校验失败（含 context_id missing 等）
   *   - `'access-url-empty'`      后端成功但 access_url 字段为空（罕见，需排查后端配置）
   *   - `'unknown'`               其它未分类异常
   */
  errorCode?:
    | 'no-api-base'
    | 'no-auth'
    | 'context-id-required'
    | 'auth-expired'
    | 'permission-denied'
    | 'rate-limit'
    | 'quota-exceeded'
    | 'billing-blocked'
    | 'oss-put-failed'
    | 'confirm-failed'
    | 'access-url-empty'
    | 'unknown';
}

const DEFAULTS: Required<Pick<OSSUploadOptions, 'folder' | 'module' | 'contextType' | 'mimeType'>> = {
  folder: 'uploads',
  module: 'oss',
  contextType: 'upload',
  mimeType: 'application/octet-stream',
};

/**
 * 上传文件到 OSS，永远返回结构化 outcome（不抛、不返 null）。
 *
 * **调用方迁移指引**：
 *   旧：`const url = await uploadFileToOSS(path, opts); if (!url) ...`
 *   新：`const r = await uploadFileToOSS(path, opts); if (!r.url) report(r.error)`
 *
 * 旧形态请用 `uploadFileToOSSLegacy` 兼容包装（仅过渡期使用，鼓励迁移到新 API）。
 */
export async function uploadFileToOSS(
  filePath: string,
  options?: OSSUploadOptions,
): Promise<UploadOutcome> {
  const opts = { ...DEFAULTS, ...options };

  try {
    const g = globalThis as any;

    const apiBase = g?.tabtin?.apiBaseUrl;
    if (!apiBase) {
      return {
        url: null,
        error: 'globalThis.tabtin.apiBaseUrl is not injected (host bridge not initialized)',
        errorCode: 'no-api-base',
      };
    }

    const getAccessToken = g?.tabtin?.auth?.getAccessToken;
    if (typeof getAccessToken !== 'function') {
      return {
        url: null,
        error: 'globalThis.tabtin.auth.getAccessToken unavailable',
        errorCode: 'no-auth',
      };
    }

    // **早期校验 contextId 必填**（dogfood baking_error 复盘）：Django
    // confirm-upload 在服务端校验 context_id 非空。提前在 client 端校验
    // 拿到精确的 errorCode='context-id-required'，避免错误信息绕道
    // "context_id is required and cannot be empty" → throw → catch → null
    // 一路被吞成无意义的 'unknown' 错。
    if (!opts.contextId || !opts.contextId.trim()) {
      return {
        url: null,
        error:
          'contextId is required (Django confirm-upload enforces non-empty context_id; ' +
          'caller must pass a stable business id, e.g. widgetId / projectId)',
        errorCode: 'context-id-required',
      };
    }

    const { createOSSClient } = await import('@tabtin/oss-client');
    const client = createOSSClient({
      apiBaseUrl: apiBase,
      getToken: async () => {
        const token = await getAccessToken();
        if (!token) throw new Error('No access token available');
        return token;
      },
    });

    const fileBuffer = await fsPromises.readFile(filePath, { signal: opts.signal });
    const fileName = basename(filePath);
    const blob = new Blob([fileBuffer], { type: opts.mimeType });

    // per-request organizationId 优先于 daemon 全局——修复 daemon organization 与
    // 请求归属 organization 分裂时 FileRecord 错写的 bug（详见 OSSUploadOptions
    // 字段 JSDoc）。空串 / 未传时退到 daemon `globalThis.tabtin.organizationId`，
    // 仍空则交给 Django `_oss_resolve_organization` 退到用户 default organization。
    const resolvedOrganizationId = opts.organizationId || g?.tabtin?.organizationId || undefined;

    if (!resolvedOrganizationId && process.env.NODE_ENV !== 'production') {
      // Dev-mode diagnostic：让所有不传 organizationId 的调用方在开发期就能被发现。
      // 防 C9 类 `file_not_in_organization` bug 再发——Electron main 端
      // `globalThis.tabtin.organizationId` 永远 undefined（daemon 才注入），
      // 而 Django `_oss_resolve_organization` 退到用户 default organization 与 active
      // organization 可能不同，FileRecord 会错写到非预期 organization。
      console.warn(
        '[oss-upload] uploadFileToOSS called without organizationId; ' +
          'fell through to daemon globalThis.tabtin.organizationId (may be undefined). ' +
          'Caller should pass per-request organizationId for multi-organization safety. ' +
          'See packages/action-tools/src/utils/oss-upload.ts JSDoc.',
      );
    }

    const result = await client.upload(blob, fileName, {
      folder: opts.folder,
      module: opts.module,
      contextType: opts.contextType,
      contextId: opts.contextId,
      maxRetries: 1,
      organizationId: resolvedOrganizationId,
      isPublic: opts.isPublic,
      signal: opts.signal,
    });

    if (!result.accessUrl) {
      return {
        url: null,
        error: 'Backend confirm-upload returned empty access_url (check OSS bucket config)',
        errorCode: 'access-url-empty',
      };
    }

    return {
      url: result.accessUrl,
      fileId: result.fileId,
      fileKey: result.fileKey,
      cdnUrl: result.cdnUrl,
    };
  } catch (err) {
    return classifyUploadError(err);
  }
}

/**
 * 兼容旧 `Promise<string | null>` 形态。仅供过渡期未迁移调用方使用。
 *
 * @deprecated 请改用 `uploadFileToOSS` 拿到结构化 outcome，便于错误透传。
 */
export async function uploadFileToOSSLegacy(
  filePath: string,
  options?: OSSUploadOptions,
): Promise<string | null> {
  const result = await uploadFileToOSS(filePath, options);
  if (!result.url) {
    console.warn('[oss-upload] 上传失败:', result.errorCode, result.error);
  }
  return result.url;
}

/**
 * 把 catch 到的 unknown error 分类成 UploadOutcome。
 *
 * **匹配策略**：用 oss-client 抛错时的 message / class name 串模式匹配。
 * 不直接 import oss-client 错误类（headless 环境下 oss-client 是动态 import 的，
 * 静态 import 会引入循环依赖 / esm 解析问题）。
 */
function classifyUploadError(err: unknown): UploadOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  if (name === 'AuthExpiredError' || /401|auth.*expired|access token/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'auth-expired' };
  }
  if (name === 'PermissionDeniedError' || /403|permission.*denied/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'permission-denied' };
  }
  if (name === 'RateLimitError' || /429|rate limit/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'rate-limit' };
  }
  if (name === 'StorageQuotaExceededError' || /storage.*quota.*exceeded/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'quota-exceeded' };
  }
  if (name === 'BillingBlockedError' || /billing.*blocked/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'billing-blocked' };
  }
  if (/OSS PUT failed/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'oss-put-failed' };
  }
  // confirm 阶段服务端校验失败（含 context_id missing / file_not_on_oss /
  // dangerous mime 等），oss-client `confirm` 函数 throw `Error(json.message)`。
  if (/Confirm request failed|context_id|file_not_on_oss|dangerous|VALIDATION_ERROR/i.test(msg)) {
    return { url: null, error: msg, errorCode: 'confirm-failed' };
  }
  return { url: null, error: msg, errorCode: 'unknown' };
}

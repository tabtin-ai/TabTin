/**
 * Django API 客户端
 *
 * collab-live 通过 HTTP 调用 Django 后端 API。
 * 所有内部调用都携带 X-Live-Secret 头。
 *
 * === 统一 Collab API ===
 * 所有模块统一使用 /api/collab/v1/ 端点：
 *   - fetchCollabSnapshot(resourceType, resourceId)
 *   - persistCollabChanges(resourceType, resourceId, body)
 *   - verifyCollabAccess(resourceType, resourceId, token)
 */

import { joinApiPath } from "@tabtin/config";

import { env } from "../env.js";

const COLLAB_BASE_URL = `${env.DJANGO_API_URL}/api/collab/v1`;
const TABDOC_BASE_URL = `${env.DJANGO_API_URL}/api/tabdoc`;

const FETCH_TIMEOUT_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;

interface DjangoApiResponse {
  status?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseErrorBody(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function reasonFromErrorBody(body: Record<string, unknown> | null): string {
  const message = body?.message;
  if (typeof message === "string" && message.trim()) return message;

  const detail = body?.detail;
  if (typeof detail === "string" && detail.trim()) return detail;

  const code = body?.code;
  if (typeof code === "string" && code.trim()) return code;

  return "";
}

async function fetchJSON(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<DjangoApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Live-Secret": env.LIVE_SECRET,
      ...((options.headers as Record<string, string>) || {}),
    };

    const res = await fetch(url, { ...options, headers, signal: controller.signal });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Django API error ${res.status}: ${text}`);
    }

    return await (res.json() as Promise<DjangoApiResponse>);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Django API timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// decodeUserIdFromJWT removed (CO-3): parsing JWT payload without signature
// verification allowed identity spoofing. user_id must come from Django auth
// response exclusively.

// ================================================================
// 统一 Collab API（/api/collab/v1/）
// ================================================================

/**
 * 统一获取资源协作快照
 */
export async function fetchCollabSnapshot(
  resourceType: string,
  resourceId: string,
): Promise<Record<string, unknown>> {
  const result = await fetchJSON(
    joinApiPath(COLLAB_BASE_URL, `/${resourceType}/${resourceId}/snapshot`)
  );
  if (!result.data || typeof result.data !== "object") {
    throw new Error(
      `fetchCollabSnapshot(${resourceType}, ${resourceId}): ` +
      `expected data object but got ${result.data === null ? "null" : typeof result.data}`,
    );
  }
  return result.data;
}

/**
 * 统一持久化资源协作变更
 *
 * changes 的内部结构由各模块 adapter 定义。
 */
export async function persistCollabChanges(
  resourceType: string,
  resourceId: string,
  body: {
    changes: Record<string, unknown>;
    op_id?: string;
    editor_type?: string;
    editor_id?: string;
    editor_name?: string;
    agent_run_id?: string;
    system_policy?: string;
    skip_version_history?: boolean;
  },
  parentDocumentId?: string,
): Promise<Record<string, unknown>> {
  const result = await fetchJSON(
    joinApiPath(COLLAB_BASE_URL, `/${resourceType}/${resourceId}/persist`),
    {
      method: "POST",
      headers: parentDocumentId
        ? { "X-TabTin-Parent-Document-Id": parentDocumentId }
        : undefined,
      body: JSON.stringify(body),
    }
  );

  const data = result.data;
  if (
    result.status !== "ok"
    || !data
    || typeof data !== "object"
    || Array.isArray(data)
    || data.error
    || data.status === "error"
  ) {
    throw new Error(
      `Django API error 422: invalid persist success response for ` +
      `${resourceType}/${resourceId}`,
    );
  }

  // E2E-038 + E2E-020: VH 写入失败时 Django 仍返回 200（persist 已提交），
  // 不应触发 withRetry 重试（数据已持久化），改为 warn 日志供监控告警。
  if (data.version_history_error) {
    console.warn(
      `[DjangoAPI] persistCollabChanges(${resourceType}, ${resourceId}): ` +
      `version history write failed on server side, persist succeeded — ` +
      `VH will be missing for this version`,
    );
  }

  return data;
}

/**
 * 统一验证用户对资源的访问权限
 */
export async function verifyCollabAccess(
  resourceType: string,
  resourceId: string,
  jwtToken: string,
  parentDocumentId?: string,
): Promise<{ authorized: boolean; user_id: string; user_name?: string; permission?: string; reason?: string }> {
  const url = joinApiPath(COLLAB_BASE_URL, `/${resourceType}/${resourceId}/auth`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwtToken}`,
        ...(parentDocumentId
          ? { "X-TabTin-Parent-Document-Id": parentDocumentId }
          : {}),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const errorBody = parseErrorBody(text);
      const serverReason = reasonFromErrorBody(errorBody);
      const accessVerificationUnavailable =
        res.headers?.get?.("x-tabtin-embedded-access-unavailable") === "1";
      const reason =
        res.status === 404 ? `endpoint not found: ${url}` :
        res.status === 401 ? "JWT token invalid or expired" :
        res.status === 403 && accessVerificationUnavailable ? "access_verification_unavailable" :
        res.status === 403 ? (serverReason || "permission denied") :
        `HTTP ${res.status}`;
      console.error(`[CollabAuth] ${resourceType} auth failed: ${reason} (id=${resourceId})`, text.slice(0, 200));
      return { authorized: false, user_id: "", reason };
    }

    let body: Record<string, unknown> | null = null;
    try {
      body = await res.json();
    } catch {
      console.error(`[CollabAuth] ${resourceType} auth returned non-JSON (id=${resourceId})`);
      return { authorized: false, user_id: "", reason: "non-JSON response" };
    }

    const data = body?.data as Record<string, unknown> | undefined;
    const authorized = body?.status === "ok" && data?.authorized === true;
    if (!authorized) {
      // 优先透传后端降级原因（如 field_visibility_restricted / rest_projection）
      const reason = String(
        data?.reason || body?.message || body?.code || "authorization denied",
      );
      console.error(`[CollabAuth] ${resourceType} auth denied: ${reason} (id=${resourceId})`, {
        collab_mode: data?.collab_mode,
        visible_field_count: data?.visible_field_count,
        total_field_count: data?.total_field_count,
      });
      return { authorized: false, user_id: "", reason };
    }

    const userId = String(data?.user_id || "");
    if (!userId) {
      console.error(
        `[CollabAuth] ${resourceType} auth returned authorized=true but no user_id (id=${resourceId})`
      );
      return { authorized: false, user_id: "", reason: "missing user_id in auth response" };
    }
    const userName = String(data?.user_name || "");
    const permission = String(data?.permission || "edit");
    return { authorized: true, user_id: userId, user_name: userName, permission };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const reason = isTimeout
      ? `timeout after ${AUTH_TIMEOUT_MS}ms`
      : `network error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[CollabAuth] ${resourceType} auth error: ${reason} (id=${resourceId}, url=${url})`);
    return { authorized: false, user_id: "", reason };
  } finally {
    clearTimeout(timer);
  }
}

// ================================================================
// TabDoc API（保留独立端点——Y.js binary 需要特殊处理）
// ================================================================

/**
 * 获取文档 Y.js binary（Base64 编码）
 *
 * TabDoc 的 binary fetch 走独立端点，因为 Y.js binary 的编码格式特殊。
 */
export async function fetchDocumentBinary(
  documentId: string
): Promise<{
  binary_b64: string;
  has_binary: boolean;
  description_markdown?: string;
  description_json?: Record<string, unknown> | null;
}> {
  const result = await fetchJSON(joinApiPath(TABDOC_BASE_URL, `/documents/${documentId}/binary`));
  return result.data as {
    binary_b64: string;
    has_binary: boolean;
    description_markdown?: string;
    description_json?: Record<string, unknown> | null;
  };
}

/**
 * 存储 Y.js state + 格式转换结果
 *
 * 通过统一 collab API persist 端点，确保 ChangeLog 和 VersionHistory 被写入。
 */
export async function storeDocumentUpdate(
  documentId: string,
  updateBlobB64: string,
  editorType: string = "user",
  editorId: string = "",
  formats?: {
    description_html?: string;
    description_json?: Record<string, unknown>;
  },
  agentRunId?: string,
  editorName?: string,
  opId?: string,
  systemPolicy?: string,
): Promise<Record<string, unknown>> {
  return persistCollabChanges("docs", documentId, {
    changes: {
      update_blob_b64: updateBlobB64,
      ...(formats || {}),
    },
    op_id: opId,
    editor_type: editorType,
    editor_id: editorId,
    editor_name: editorName || "",
    ...(agentRunId ? { agent_run_id: agentRunId } : {}),
    ...(systemPolicy ? { system_policy: systemPolicy } : {}),
  });
}

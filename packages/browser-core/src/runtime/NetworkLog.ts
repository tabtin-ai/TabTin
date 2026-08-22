/**
 * NetworkLog —— 常驻网络请求历史缓冲（BR-8 WS-B）。
 *
 * 消费 CDP `Network.*` 事件，按 requestId 关联 request/response/finished，
 * 沉淀成一条条历史日志（按 tabId 分桶、环形容量上限防内存涨）。两端的
 * `BrowserContext.onCDPEvent` 都往这里喂 → `network` 命令返回的是**历史日志**
 * 而非窗口快照。
 *
 * 形状对齐 Electron 经 action-tools 暴露的 `NetworkLogEntry`，让双端 `network`
 * 输出结构一致（BR-12 探针可由 expected-diff 收成 match）。
 */

import type { CDPLogEvent, RuntimeLogContext } from './types';

export interface NetworkLogEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  mimeType?: string;
  size?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBase64Encoded?: boolean;
  /** 请求体或响应体因超长被截断。 */
  bodyTruncated?: boolean;
  /** 响应体抓取失败 / 加载失败时的原因（如 binary skipped、loading failed）。 */
  responseBodyError?: string;
  timestamp: number;
  runId?: string;
}

export interface NetworkLogQuery {
  /** url/method/resourceType/mimeType/status 上的大小写不敏感正则过滤。 */
  filter?: string;
  runId?: string;
  /** 仅返回最近 N 条（保持时间序）。 */
  limit?: number;
  includeRequestHeaders?: boolean;
  includeRequestBody?: boolean;
  includeResponseHeaders?: boolean;
  includeResponseBody?: boolean;
  /**
   * 是否对响应体做敏感字段脱敏。**默认 true**（保持 agent-facing 日志脱敏口径不变）。
   * 仅供**可信内部消费方**（如 platform-reach 提取内容 URL 里的签名 token）显式传 false
   * 取原始响应体——脱敏正则会把 `xsec_token` 一类内容寻址签名误判为敏感字段打码，
   * 破坏「先 search 拿签名 URL 再 read」的两跳。切勿在 agent / 导出日志路径传 false。
   */
  redactResponseBody?: boolean;
}

/** recordBody 的入参：异步 Network.getResponseBody 拿到响应体后回填。 */
export interface NetworkResponseBodyPatch {
  responseBody?: string;
  responseBodyBase64Encoded?: boolean;
  bodyTruncated?: boolean;
  responseBodyError?: string;
  size?: number;
}

interface TabBuffer {
  /** 按首次出现的时间序排列；超容量时从头淘汰。 */
  order: NetworkLogEntry[];
  /** requestId → entry 索引，供 response/finished 事件 O(1) 关联。 */
  byId: Map<string, NetworkLogEntry>;
}

const DEFAULT_CAPACITY = 1000;

// 请求体（postData）入缓冲前的截断上限，与 Electron CDPNetworkBridge 旧口径一致。
const MAX_REQUEST_BODY_CHARS = 64 * 1024;

// 随 include-* 暴露请求/响应头前打码，避免把 Cookie / 鉴权头泄露给日志消费方
// （与 Electron 经 action-tools projectNetworkLog 的脱敏口径一致）。
const SENSITIVE_HEADER_RE =
  /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|proxy-authorization)$/i;
const SENSITIVE_QUERY_RE =
  /(?:^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|api[_-]?key|auth|authorization|session|csrf|xsrf)(?:$|[_-])/i;
// 请求/响应体（JSON 或表单）里按 key 命中的敏感字段值打码。
const SENSITIVE_BODY_KEY_RE =
  /(?:^|[_-])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|cookie|session|csrf|xsrf|credential)(?:$|[_-])/i;

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[redacted]' : String(v);
  }
  return out;
}

function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_RE.test(key)) u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function redactStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructuredValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_BODY_KEY_RE.test(key) ? '[redacted]' : redactStructuredValue(child);
    }
    return out;
  }
  return value;
}

/** 对 JSON / 表单体里命中敏感 key 的值打码；非结构化体原样返回。 */
function redactBody(body?: string): string | undefined {
  if (typeof body !== 'string') return undefined;
  const trimmed = body.trim();
  if (!trimmed) return body;
  try {
    const parsed = JSON.parse(trimmed);
    return JSON.stringify(redactStructuredValue(parsed));
  } catch {
    if (trimmed.includes('=')) {
      try {
        const params = new URLSearchParams(trimmed);
        let changed = false;
        for (const key of Array.from(params.keys())) {
          if (SENSITIVE_BODY_KEY_RE.test(key)) {
            params.set(key, '[redacted]');
            changed = true;
          }
        }
        if (changed) return params.toString();
      } catch {
        /* fall through */
      }
    }
  }
  return body;
}

/** CDP headers 是 `{ [name]: string }`；做一次防御性归一（剔除非字符串/空值）。 */
function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined && v !== null) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class NetworkLog {
  private readonly tabs = new Map<string, TabBuffer>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /**
   * 喂一个 CDP 事件。识别 Network.requestWillBeSent / responseReceived /
   * loadingFinished，按 requestId 关联进同一条 entry；其余事件忽略。
   */
  record(tabId: string, event: CDPLogEvent, ctx?: RuntimeLogContext): void {
    if (!tabId || !event || typeof event.method !== 'string') return;
    const p = (event.params ?? {}) as Record<string, unknown>;
    switch (event.method) {
      case 'Network.requestWillBeSent':
        this.onRequest(tabId, p, ctx?.runId);
        return;
      case 'Network.responseReceived':
        this.onResponse(tabId, p);
        return;
      case 'Network.loadingFinished':
        this.onFinished(tabId, p);
        return;
      case 'Network.loadingFailed':
        this.onFailed(tabId, p);
        return;
      default:
        return;
    }
  }

  /**
   * 回填响应体（异步 Network.getResponseBody 拿到后调用）。
   * entry 可能已被环形淘汰 → 静默忽略，绝不复活。
   */
  recordBody(tabId: string, requestId: string, patch: NetworkResponseBodyPatch): void {
    if (!tabId || !requestId) return;
    const entry = this.tabs.get(tabId)?.byId.get(requestId);
    if (!entry) return;
    if (patch.responseBody !== undefined) entry.responseBody = patch.responseBody;
    if (patch.responseBodyBase64Encoded !== undefined) {
      entry.responseBodyBase64Encoded = patch.responseBodyBase64Encoded;
    }
    if (patch.bodyTruncated) entry.bodyTruncated = true;
    if (patch.responseBodyError !== undefined) entry.responseBodyError = patch.responseBodyError;
    if (patch.size !== undefined) entry.size = patch.size;
  }

  query(tabId: string, q: NetworkLogQuery = {}): NetworkLogEntry[] {
    const buf = this.tabs.get(tabId);
    if (!buf) return [];

    let entries = buf.order;
    if (q.runId) entries = entries.filter((e) => e.runId === q.runId);

    if (q.filter) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(q.filter, 'i');
      } catch {
        re = null; // 非法正则 → 不过滤（调用方应在入口校验并报错）
      }
      if (re) {
        const matcher = re;
        entries = entries.filter((e) =>
          matcher.test(
            [e.url, e.method, e.resourceType, e.mimeType, e.status !== undefined ? String(e.status) : '']
              .filter(Boolean)
              .join(' '),
          ),
        );
      }
    }

    if (q.limit && q.limit > 0 && entries.length > q.limit) {
      entries = entries.slice(entries.length - q.limit);
    }

    return entries.map((e) => this.project(e, q));
  }

  clear(tabId: string): void {
    this.tabs.delete(tabId);
  }

  clearAll(): void {
    this.tabs.clear();
  }

  /** 当前缓冲条数（主要给单测/可观测用）。 */
  size(tabId: string): number {
    return this.tabs.get(tabId)?.order.length ?? 0;
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private ensureTab(tabId: string): TabBuffer {
    let buf = this.tabs.get(tabId);
    if (!buf) {
      buf = { order: [], byId: new Map() };
      this.tabs.set(tabId, buf);
    }
    return buf;
  }

  private onRequest(tabId: string, p: Record<string, unknown>, runId?: string): void {
    const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
    const request = p.request as Record<string, unknown> | undefined;
    const url = typeof request?.url === 'string' ? request.url : undefined;
    if (!requestId || !url) return;

    const method = typeof request?.method === 'string' ? request.method : 'GET';
    const resourceType = typeof p.type === 'string' ? p.type : undefined;
    const requestHeaders = asStringRecord(request?.headers);
    const { body: requestBody, truncated } = this.captureRequestBody(request?.postData);

    const buf = this.ensureTab(tabId);
    const existing = buf.byId.get(requestId);
    if (existing) {
      // 重定向：同 requestId 再次 requestWillBeSent，更新到最终请求。
      existing.url = url;
      existing.method = method;
      if (resourceType) existing.resourceType = resourceType;
      if (requestHeaders) existing.requestHeaders = requestHeaders;
      if (requestBody !== undefined) existing.requestBody = requestBody;
      if (truncated) existing.bodyTruncated = true;
      return;
    }

    const entry: NetworkLogEntry = {
      requestId,
      url,
      method,
      ...(resourceType ? { resourceType } : {}),
      ...(requestHeaders ? { requestHeaders } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      ...(truncated ? { bodyTruncated: true } : {}),
      timestamp: Date.now(),
      ...(runId ? { runId } : {}),
    };
    buf.order.push(entry);
    buf.byId.set(requestId, entry);
    this.trim(buf);
  }

  private captureRequestBody(postData: unknown): { body?: string; truncated: boolean } {
    if (typeof postData !== 'string' || postData.length === 0) return { truncated: false };
    if (postData.length <= MAX_REQUEST_BODY_CHARS) return { body: postData, truncated: false };
    return { body: postData.slice(0, MAX_REQUEST_BODY_CHARS), truncated: true };
  }

  private onResponse(tabId: string, p: Record<string, unknown>): void {
    const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
    if (!requestId) return;
    const entry = this.tabs.get(tabId)?.byId.get(requestId);
    if (!entry) return;

    const response = p.response as Record<string, unknown> | undefined;
    if (typeof response?.status === 'number') entry.status = response.status;
    if (typeof response?.mimeType === 'string') entry.mimeType = response.mimeType;

    const responseHeaders = asStringRecord(response?.headers);
    if (responseHeaders) entry.responseHeaders = responseHeaders;

    if (entry.size === undefined && responseHeaders) {
      const cl = responseHeaders['content-length'] ?? responseHeaders['Content-Length'];
      if (cl) {
        const n = parseInt(cl, 10);
        if (Number.isFinite(n)) entry.size = n;
      }
    }
    if (typeof p.type === 'string' && !entry.resourceType) entry.resourceType = p.type;
  }

  private onFinished(tabId: string, p: Record<string, unknown>): void {
    const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
    if (!requestId) return;
    const entry = this.tabs.get(tabId)?.byId.get(requestId);
    if (!entry) return;
    // encodedDataLength 是实际传输字节数，比 content-length 头更准。
    if (typeof p.encodedDataLength === 'number' && p.encodedDataLength > 0) {
      entry.size = p.encodedDataLength;
    }
  }

  private onFailed(tabId: string, p: Record<string, unknown>): void {
    const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
    if (!requestId) return;
    const entry = this.tabs.get(tabId)?.byId.get(requestId);
    if (!entry) return;
    if (!entry.responseBodyError) {
      entry.responseBodyError = typeof p.errorText === 'string' ? p.errorText : 'loading failed';
    }
  }

  private trim(buf: TabBuffer): void {
    while (buf.order.length > this.capacity) {
      const removed = buf.order.shift();
      if (removed) buf.byId.delete(removed.requestId);
    }
  }

  private project(entry: NetworkLogEntry, q: NetworkLogQuery): NetworkLogEntry {
    const out: NetworkLogEntry = {
      requestId: entry.requestId,
      url: redactUrl(entry.url),
      method: entry.method,
      timestamp: entry.timestamp,
    };
    if (entry.status !== undefined) out.status = entry.status;
    if (entry.resourceType !== undefined) out.resourceType = entry.resourceType;
    if (entry.mimeType !== undefined) out.mimeType = entry.mimeType;
    if (entry.size !== undefined) out.size = entry.size;
    if (entry.runId !== undefined) out.runId = entry.runId;
    // bodyTruncated / responseBodyError 是非敏感元信息，不受 include-* 门控，始终透传。
    if (entry.bodyTruncated !== undefined) out.bodyTruncated = entry.bodyTruncated;
    if (entry.responseBodyError !== undefined) out.responseBodyError = entry.responseBodyError;
    if (q.includeRequestHeaders) {
      const h = redactHeaders(entry.requestHeaders);
      if (h) out.requestHeaders = h;
    }
    if (q.includeRequestBody) {
      const b = redactBody(entry.requestBody);
      if (b !== undefined) out.requestBody = b;
    }
    if (q.includeResponseHeaders) {
      const h = redactHeaders(entry.responseHeaders);
      if (h) out.responseHeaders = h;
    }
    if (q.includeResponseBody) {
      // 默认脱敏；可信内部消费方显式 redactResponseBody:false 时取原始体。
      const b =
        q.redactResponseBody === false
          ? entry.responseBody
          : redactBody(entry.responseBody);
      if (b !== undefined) out.responseBody = b;
      if (entry.responseBodyBase64Encoded !== undefined) {
        out.responseBodyBase64Encoded = entry.responseBodyBase64Encoded;
      }
    }
    return out;
  }
}

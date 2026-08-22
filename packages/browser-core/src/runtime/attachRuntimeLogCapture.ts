/**
 * attachRuntimeLogCapture —— 双端共享的 network/console 历史捕获挂载（BR-8 WS-B / P3b）。
 *
 * 经 `BrowserContext` 的统一 CDP 入口（`onCDPEvent` + `sendCDP`）把 Network / Runtime /
 * Log 域事件喂进 browser-core 的常驻 `NetworkLog` / `ConsoleLog`。Electron（WebContents
 * debugger）与 Daemon（Playwright CDPSession）调**同一份**此函数 → 两端「写入」零分叉。
 *
 * **导航前调用并 await**：确保对应 CDP domain 在首屏请求/控制台前启用，缓冲拿到的是
 * 历史日志而非窗口快照。CDP 不可用时静默降级（缓冲为空），绝不阻断开 tab。
 *
 * `captureBodies`：可选抓响应体（需 `Network.getResponseBody`，仅小型文本/JSON）。
 * Electron 开（保留旧 CDPNetworkBridge 行为），Daemon 默认关（流式缓冲不留响应体）。
 */

import type { BrowserContext } from '../context/BrowserContext';
import type { NetworkLog } from './NetworkLog';
import type { ConsoleLog } from './ConsoleLog';

export interface RuntimeLogCaptureOptions {
  networkLog?: NetworkLog;
  consoleLog?: ConsoleLog;
  /** 关联的 run 会话 id，落进每条 entry 供按 run 过滤。 */
  runId?: string;
  /** 抓响应体（仅命中的小型文本/JSON）。默认关。 */
  captureBodies?: boolean;
}

// 响应体抓取的体量门控（与 Electron CDPNetworkBridge 旧口径一致）。
// 问财 stream-query 等 SSE 常 200KB+，且关键字段（subjects）在尾部——过小会截断丢股名片。
const MAX_CAPTURED_BODY_CHARS = 512 * 1024;
const MAX_BODY_ENCODED_LENGTH = 512 * 1024;
const BODY_RESOURCE_TYPES = new Set(['XHR', 'Fetch', 'Document']);
const BODY_MIME_RE = /(?:json|text|xml|javascript|x-www-form-urlencoded)/i;
/** JSONP 常以 `<script>` / Script 资源加载（东方财富 search 等），URL 带 jsonp/cb= 才抓，避免吞整站 JS bundle。 */
const JSONP_URL_RE = /jsonp|[?&]callback=|[?&]cb=/i;

/** @internal 导出供单测；生产路径经 attachRuntimeLogCapture 调用。 */
export function shouldCaptureResponseBody(
  resourceType: string | undefined,
  mimeType: string | undefined,
  encodedDataLength: number | undefined,
  url?: string,
): boolean {
  if (typeof encodedDataLength === 'number' && encodedDataLength > MAX_BODY_ENCODED_LENGTH) {
    return false;
  }
  const mimeOk = BODY_MIME_RE.test(mimeType ?? '');
  if (BODY_RESOURCE_TYPES.has(resourceType ?? '') && mimeOk) return true;
  // Script + JSONP URL：mime 常为 application/javascript；无 mime 时仍按 URL 放行（体量已门控）。
  if (resourceType === 'Script' && typeof url === 'string' && JSONP_URL_RE.test(url)) {
    return mimeOk || !mimeType;
  }
  return false;
}

/**
 * 给某个 tab 的 `BrowserContext` 挂常驻 network/console 捕获。
 *
 * @returns 取消订阅函数（移除 onCDPEvent 监听）；缓冲条目本身由调用方按 tab 清理。
 */
export async function attachRuntimeLogCapture(
  ctx: BrowserContext,
  tabId: string,
  options: RuntimeLogCaptureOptions,
): Promise<() => void> {
  const { networkLog, consoleLog, runId, captureBodies } = options;
  if (!networkLog && !consoleLog) return () => {};

  const logCtx = runId ? { runId } : undefined;
  // 命中响应体抓取条件的 requestId → 其 resourceType/mime/url，留待 loadingFinished 决策。
  const bodyCandidates =
    captureBodies && networkLog
      ? new Map<string, { resourceType?: string; mimeType?: string; url?: string }>()
      : null;

  const dispose = ctx.onCDPEvent((ev) => {
    networkLog?.record(tabId, ev, logCtx);
    consoleLog?.record(tabId, ev, logCtx);

    if (!bodyCandidates || !networkLog) return;
    const p = ev.params as Record<string, unknown>;
    if (ev.method === 'Network.responseReceived') {
      const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
      if (!requestId) return;
      const response = p.response as Record<string, unknown> | undefined;
      bodyCandidates.set(requestId, {
        resourceType: typeof p.type === 'string' ? p.type : undefined,
        mimeType: typeof response?.mimeType === 'string' ? response.mimeType : undefined,
        url: typeof response?.url === 'string' ? response.url : undefined,
      });
    } else if (ev.method === 'Network.loadingFinished') {
      const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
      if (!requestId) return;
      const meta = bodyCandidates.get(requestId);
      bodyCandidates.delete(requestId);
      const encodedDataLength = typeof p.encodedDataLength === 'number' ? p.encodedDataLength : undefined;
      if (
        !shouldCaptureResponseBody(
          meta?.resourceType,
          meta?.mimeType,
          encodedDataLength,
          meta?.url,
        )
      ) {
        return;
      }
      void fetchResponseBody(ctx, tabId, requestId, networkLog);
    } else if (ev.method === 'Network.loadingFailed') {
      const requestId = typeof p.requestId === 'string' ? p.requestId : undefined;
      if (requestId) bodyCandidates.delete(requestId);
    }
  });

  try {
    // Network.enable → requestWillBeSent/responseReceived/loadingFinished/loadingFailed；
    // Runtime.enable → consoleAPICalled；Log.enable → entryAdded（网络错误/CSP 等）。
    await Promise.all([
      ctx.sendCDP('Network.enable'),
      ctx.sendCDP('Runtime.enable'),
      ctx.sendCDP('Log.enable'),
    ]);
  } catch {
    // CDP 会话不可用 → 缓冲收不到事件，降级为空历史，不抛。
  }

  return dispose;
}

async function fetchResponseBody(
  ctx: BrowserContext,
  tabId: string,
  requestId: string,
  networkLog: NetworkLog,
): Promise<void> {
  try {
    const result = await ctx.sendCDP<{ body?: string; base64Encoded?: boolean }>(
      'Network.getResponseBody',
      { requestId },
    );
    if (typeof result?.body !== 'string') return;
    if (result.base64Encoded) {
      networkLog.recordBody(tabId, requestId, { responseBodyError: 'binary response body skipped' });
      return;
    }
    let body = result.body;
    let truncated = false;
    if (body.length > MAX_CAPTURED_BODY_CHARS) {
      body = body.slice(0, MAX_CAPTURED_BODY_CHARS);
      truncated = true;
    }
    networkLog.recordBody(tabId, requestId, {
      responseBody: body,
      responseBodyBase64Encoded: false,
      bodyTruncated: truncated,
    });
  } catch (err) {
    networkLog.recordBody(tabId, requestId, {
      responseBodyError: err instanceof Error ? err.message : String(err),
    });
  }
}

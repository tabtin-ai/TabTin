/**
 * Agent Push 通用直连包装
 *
 * 封装 Hocuspocus openDirectConnection + handler + disconnect 样板，
 * 供 server.ts 中 9 个 Agent Push 端点消费。
 */

import type { Hocuspocus } from "@hocuspocus/server";

/** openDirectConnection 的实际返回类型（包含 document、transact、disconnect 等） */
type DirectConn = Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;

const DEFAULT_DIRECT_CONN_TIMEOUT_MS = parseInt(
  process.env.DIRECT_CONN_TIMEOUT_MS || "30000",
  10,
);

export interface DirectConnectionOptions {
  timeoutMs?: number;
  /** Preserve legacy best-effort behavior by default; strict maintenance calls opt in. */
  propagateDisconnectError?: boolean;
}

/**
 * 打开 Hocuspocus 直连，执行 handler，并确保 disconnect。
 *
 * handler 接收 DirectConnection 对象，可调用 doc.transact()、
 * doc.document?.awareness 等方法。返回值会透传给调用方。
 *
 * 异常由调用方处理（用于 metrics 记录和 HTTP 响应），
 * 本函数仅保证 finally 中 disconnect。
 *
 * CI-015: handler 挂起时通过 timeout 自动 reject + 关闭连接，防止连接泄漏。
 */
export async function withDirectConnection<T>(
  hocuspocus: Hocuspocus,
  documentName: string,
  context: {
    editorType?: string;
    editorId?: string;
    editorName?: string;
    source?: string;
    agentRunId?: string;
    systemPolicy?: string;
  },
  handler: (doc: DirectConn) => Promise<T> | T,
  options?: DirectConnectionOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DIRECT_CONN_TIMEOUT_MS;
  let doc: DirectConn | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let handlerFailed = false;

  try {
    doc = await hocuspocus.openDirectConnection(documentName, context);

    const result = await Promise.race([
      Promise.resolve(handler(doc)),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(
            `[DirectConnection] timed out after ${timeoutMs}ms for ${documentName}`,
          ));
        }, timeoutMs);
      }),
    ]);

    return result;
  } catch (error) {
    handlerFailed = true;
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (doc) {
      try {
        await doc.disconnect();
      } catch (disconnectError: unknown) {
        const msg = disconnectError instanceof Error ? disconnectError.message : String(disconnectError);
        console.error(
          `[DirectConnection] disconnect error for ${documentName}:`,
          msg,
        );
        if (options?.propagateDisconnectError === true && !handlerFailed) {
          throw disconnectError;
        }
      }
    }
  }
}

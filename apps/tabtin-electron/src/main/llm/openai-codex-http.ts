import { net } from 'electron';

import { createLogger } from '../logger.js';

const log = createLogger('OpenAICodex');

export type OpenAICodexFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Codex 出网必须走 Chromium 网络栈，才能和浏览器登录一样认系统代理。
 * OAuth 换票与本机提问共用这一条通道。
 */
export async function openAICodexFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const endpoint = new URL(input).pathname;
  const startedAt = Date.now();
  log.info(`HTTP request started: ${endpoint}`);

  try {
    const response = await net.fetch(input, init);
    log.info(
      `HTTP request completed: ${endpoint} status=${response.status} durationMs=${Date.now() - startedAt}`,
    );
    return response;
  } catch (error) {
    log.warn(
      `HTTP request failed: ${endpoint} durationMs=${Date.now() - startedAt} error=${describeNetworkError(error)}`,
    );
    throw error;
  }
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== 'object') return error.message;

  const causeRecord = cause as Record<string, unknown>;
  const code = typeof causeRecord.code === 'string' ? causeRecord.code : null;
  const message =
    typeof causeRecord.message === 'string' ? causeRecord.message : null;
  const details = [code, message].filter(Boolean).join(': ');
  return details ? `${error.message}; cause=${details}` : error.message;
}

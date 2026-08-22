/**
 * safe-fetch — unified HTTP primitives for Daemon stream modules.
 *
 * All HTTP requests in ResourceTracker / m3u8-parser / mpd-parser /
 * stream-downloader MUST go through these helpers to guarantee:
 * - Timeout via AbortController (default 30 s)
 * - Streaming max-size guard for text responses (default 10 MB)
 * - Standard browser User-Agent + auto Referer
 * - Uniform error surface for callers
 */

import { validateUrl } from '@tabtin/security-policy';

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_SEGMENT_TIMEOUT = 60_000;
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_BUFFER_SIZE = 50 * 1024 * 1024; // 50 MB

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function readResponseBody(response: Response, maxSize: number, signal?: AbortSignal): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxSize) {
    throw new Error(`Response too large: ${contentLength} bytes (limit ${maxSize})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw signal.reason instanceof Error ? signal.reason : new Error('Fetch aborted');
    }
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxSize) {
      reader.cancel().catch(() => {});
      throw new Error(`Response body exceeds ${maxSize} bytes limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function deriveReferer(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export async function safeFetch(
  url: string,
  opts?: {
    headers?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  validateUrl(url);
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Fetch timeout after ${timeout}ms: ${url}`)),
    timeout,
  );
  try {
    const referer = deriveReferer(url);
    const signal = opts?.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
    const response = await fetch(url, {
      headers: {
        'Referer': referer,
        'User-Agent': BROWSER_UA,
        ...(opts?.headers ?? {}),
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch URL as text with streaming size guard.
 * Reads body incrementally — never buffers more than `maxSize` bytes,
 * even when the server omits Content-Length.
 */
export async function safeFetchText(
  url: string,
  opts?: {
    headers?: Record<string, string>;
    timeout?: number;
    maxSize?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const response = await safeFetch(url, opts);
  const maxSize = opts?.maxSize ?? MAX_MANIFEST_SIZE;

  return (await readResponseBody(response, maxSize, opts?.signal)).toString('utf-8');
}

/**
 * Fetch URL as Buffer with streaming size guard.
 * Reads body incrementally — never buffers more than `maxSize` bytes,
 * even when the server omits Content-Length.
 */
export async function safeFetchBuffer(
  url: string,
  opts?: {
    headers?: Record<string, string>;
    timeout?: number;
    maxSize?: number;
    signal?: AbortSignal;
  },
): Promise<Buffer> {
  const response = await safeFetch(url, {
    ...opts,
    timeout: opts?.timeout ?? DEFAULT_SEGMENT_TIMEOUT,
  });
  const maxSize = opts?.maxSize ?? MAX_BUFFER_SIZE;

  return readResponseBody(response, maxSize, opts?.signal);
}

export { DEFAULT_TIMEOUT, DEFAULT_SEGMENT_TIMEOUT, MAX_MANIFEST_SIZE, MAX_BUFFER_SIZE, BROWSER_UA };

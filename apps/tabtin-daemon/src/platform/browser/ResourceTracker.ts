/**
 * ResourceTracker — CDP-based page resource tracking for Daemon.
 *
 * Uses Chrome DevTools Protocol (Network Domain) to track all resources
 * loaded by a page, enabling inspect/capture/download operations.
 */

import type { Page, CDPSession } from 'patchright-core';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths';

export interface ResourceEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  contentLength?: number;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timing?: {
    requestTime?: number;
    receiveHeadersEnd?: number;
    duration?: number;
  };
  captured: boolean;
  loadingState?: 'loading' | 'finished' | 'failed';
  errorText?: string;
}

export class ResourceTracker {
  private static readonly MAX_RESOURCES = 5000;
  private client: CDPSession | null = null;
  private resources = new Map<string, ResourceEntry>();
  private enabled = false;

  async attach(page: Page): Promise<void> {
    if (this.enabled) return;

    try {
      this.client = await page.context().newCDPSession(page);
      await this.client.send('Network.enable', {
        maxTotalBufferSize: 50 * 1024 * 1024,
        maxResourceBufferSize: 10 * 1024 * 1024,
      });
      this.enabled = true;

      this.client.on('Network.requestWillBeSent', (params: any) => {
        if (this.resources.size >= ResourceTracker.MAX_RESOURCES) {
          const deleteCount = Math.ceil(ResourceTracker.MAX_RESOURCES * 0.1);
          const iterator = this.resources.keys();
          for (let i = 0; i < deleteCount; i++) {
            const key = iterator.next().value;
            if (key) this.resources.delete(key);
          }
        }
        this.resources.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          resourceType: params.type || 'Other',
          headers: params.request.headers,
          captured: false,
          loadingState: 'loading',
        });
      });

      this.client.on('Network.responseReceived', (params: any) => {
        const entry = this.resources.get(params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.statusText = params.response.statusText;
          entry.mimeType = params.response.mimeType;
          entry.contentLength = params.response.headers?.['content-length']
            ? parseInt(params.response.headers['content-length'], 10)
            : undefined;
          entry.responseHeaders = params.response.headers;
          if (params.response.timing) {
            entry.timing = {
              requestTime: params.response.timing.requestTime,
              receiveHeadersEnd: params.response.timing.receiveHeadersEnd,
              duration: params.response.timing.receiveHeadersEnd
                ? Math.round(params.response.timing.receiveHeadersEnd)
                : undefined,
            };
          }
        }
      });

      this.client.on('Network.loadingFinished', (params: any) => {
        const entry = this.resources.get(params.requestId);
        if (entry) {
          entry.loadingState = 'finished';
          if (params.encodedDataLength !== undefined) {
            entry.contentLength = params.encodedDataLength;
          }
        }
      });

      this.client.on('Network.loadingFailed', (params: any) => {
        const entry = this.resources.get(params.requestId);
        if (entry) {
          entry.loadingState = 'failed';
          entry.errorText = params.errorText;
        }
      });
    } catch {
      this.enabled = false;
    }
  }

  detach(): void {
    if (this.client) {
      this.client.detach().catch(() => {});
      this.client = null;
    }
    this.enabled = false;
    this.resources.clear();
  }

  list(opts?: { category?: string; limit?: number }): ResourceEntry[] {
    let entries = [...this.resources.values()];

    if (opts?.category) {
      const cat = opts.category.toLowerCase();
      entries = entries.filter(e => e.resourceType.toLowerCase() === cat);
    }

    if (opts?.limit && opts.limit > 0) {
      entries = entries.slice(0, opts.limit);
    }

    return entries;
  }

  inspect(requestId: string): ResourceEntry | null {
    return this.resources.get(requestId) ?? null;
  }

  async capture(requestId: string): Promise<{ body: string; base64Encoded: boolean } | null> {
    if (!this.client || !this.enabled) return null;

    const entry = this.resources.get(requestId);
    if (!entry) return null;
    if (entry.loadingState === 'failed') return null;

    try {
      const result = await this.client.send('Network.getResponseBody', { requestId });
      entry.captured = true;
      return result as { body: string; base64Encoded: boolean };
    } catch {
      return null;
    }
  }

  async download(requestId: string, savePath?: string): Promise<{ success: boolean; path?: string; size?: number; error?: string }> {
    const content = await this.capture(requestId);
    if (!content) {
      return { success: false, error: `无法获取资源 ${requestId} 的内容` };
    }

    const entry = this.resources.get(requestId)!;
    let filename: string;
    try {
      filename = new URL(entry.url).pathname.split('/').pop() || `resource-${requestId}`;
    } catch {
      filename = `resource-${requestId}`;
    }
    const finalPath = savePath || join(getHomeTabtinPath('downloads'), filename);

    try {
      await mkdir(dirname(finalPath), { recursive: true });

      const buffer = content.base64Encoded
        ? Buffer.from(content.body, 'base64')
        : Buffer.from(content.body, 'utf-8');

      await writeFile(finalPath, buffer);

      return { success: true, path: finalPath, size: buffer.length };
    } catch (err: any) {
      return { success: false, error: err?.message || '写入文件失败' };
    }
  }

  findByUrl(url: string): ResourceEntry | undefined {
    for (const entry of this.resources.values()) {
      if (entry.url === url) return entry;
    }
    return undefined;
  }

  get count(): number {
    return this.resources.size;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * 网络捕获服务（WebRequest 路径）
 *
 * 使用 Electron WebRequest API 全局拦截网络请求/响应
 * 支持跨页面、跨导航的持续捕获，不依赖 CDP 生命周期
 *
 * @deprecated 资源捕获已统一到 CDP 路径，请使用 {@link CDPNetworkCaptureService}。
 * 本服务的 startSession/stopSession 不应再用于新代码。
 * 当前保留的 WebRequest 拦截器仍为 ResourceDetectionService 提供
 * defaultSession 事件桥接（`request-completed` 事件），待后续迁移到
 * 独立的轻量级事件转发服务后可完全移除。
 *
 * @author TabTin Team
 * @date 2025-11-19
 */

import { createLogger } from '../logger';
const log = createLogger('NetworkCapture');

import { session, net, webContents } from 'electron';
import { EventEmitter } from 'events';
import { getResourceHubService } from './ResourceHubService';

/**
 * 网络响应数据结构
 */
export interface NetworkResponse {
  resourceId?: string;
  viewId?: string;
  url: string;
  status: number;
  statusText: string;
  headers?: Record<string, string>;
  size?: number;
  mimeType?: string;
  category?: string;
  captureStatus?: string;
  contentKind?: 'data_url' | 'text' | 'file_path';
  timing?: any;
  body?: string;           // 响应体（文本或 base64 图片）
  bodyPreview?: string;    // 响应体预览
  timestamp: number;
}

/**
 * 捕获会话配置
 */
export interface CaptureSessionConfig {
  resourceTypes?: string[];  // 要捕获的资源类型 ['image', 'media', 'xhr', 'fetch']
  urlPatterns?: RegExp[];    // URL 过滤模式
  maxSize?: number;          // 单个资源最大大小（bytes）
  maxCount?: number;         // 最大捕获数量
  captureBody?: boolean;     // 是否捕获响应体（默认 true）
  viewId?: string;           // 关联的 viewId，用于写入 ResourceHub（RP-001）
}

/**
 * 捕获会话
 */
interface CaptureSession {
  id: string;
  viewId: string;
  startTime: number;
  responses: Map<string, NetworkResponse>;
  config: Required<CaptureSessionConfig>;
  stats: {
    totalRequests: number;
    capturedCount: number;
    skippedCount: number;
    errorCount: number;
  };
}

/**
 * 网络捕获服务（单例）
 * @deprecated 请使用 {@link CDPNetworkCaptureService} 进行网络资源捕获。
 */
const FETCH_CONCURRENCY_LIMIT = 6;

export class NetworkCaptureService extends EventEmitter {
  private sessions = new Map<string, CaptureSession>();
  private pendingCaptures = new Map<string, Set<Promise<void>>>();
  private isInterceptorSetup = false;
  /** RP-008/DI-026 修复：fetchResponseBody 并发控制 */
  private _activeFetches = 0;
  private _fetchQueue: Array<() => void> = [];

  /**
   * 启动网络捕获会话
   * @deprecated 请使用 CDPNetworkCaptureService.startSession() 替代。
   */
  startSession(sessionId: string, config?: CaptureSessionConfig): void {
    log.info(`启动捕获会话: ${sessionId}`);

    // 默认配置
    const defaultConfig: Required<CaptureSessionConfig> = {
      resourceTypes: ['image', 'media'],
      urlPatterns: [],
      maxSize: 500 * 1024,  // 500KB
      maxCount: 1000,
      captureBody: true,
      viewId: config?.viewId || sessionId
    };

    const captureSession: CaptureSession = {
      id: sessionId,
      viewId: config?.viewId || sessionId,
      startTime: Date.now(),
      responses: new Map(),
      config: { ...defaultConfig, ...config } as Required<CaptureSessionConfig>,
      stats: {
        totalRequests: 0,
        capturedCount: 0,
        skippedCount: 0,
        errorCount: 0
      }
    };

    this.sessions.set(sessionId, captureSession);
    this.pendingCaptures.set(sessionId, new Set());

    // 首次启动时设置拦截器（全局只设置一次）
    if (!this.isInterceptorSetup) {
      this.setupInterceptor();
      this.isInterceptorSetup = true;
    }

    log.info('会话已启动，配置:', captureSession.config);
  }

  /**
   * 设置 Electron WebRequest 拦截器（全局）
   */
  private setupInterceptor(): void {
    log.info('设置全局网络拦截器...');

    const { webRequest } = session.defaultSession;

    // 监听响应完成事件
    webRequest.onCompleted(
      { urls: ['<all_urls>'] },
      (details) => {
        // 遍历所有活跃会话，检查是否需要捕获
        for (const [sessionId, captureSession] of this.sessions.entries()) {
          this.handleResponse(captureSession, details);
        }
        // 🆕 广播给 ResourceDetectionService（处理 defaultSession 上的视图）
        this.emit('request-completed', details);
      }
    );

    log.info('全局拦截器已设置');
  }

  /**
   * 处理响应（检查过滤条件并捕获）
   */
  private handleResponse(
    session: CaptureSession,
    details: Electron.OnCompletedListenerDetails
  ): void {
    session.stats.totalRequests++;

    try {
      // 1. 检查资源类型
      if (!session.config.resourceTypes.includes(details.resourceType)) {
        return;
      }

      // 2. 检查 URL 模式（如果配置了）
      if (session.config.urlPatterns.length > 0) {
        const matchesPattern = session.config.urlPatterns.some(
          pattern => pattern.test(details.url)
        );
        if (!matchesPattern) {
          return;
        }
      }

      // 3. 检查状态码（只捕获成功的请求）
      if (details.statusCode < 200 || details.statusCode >= 300) {
        return;
      }

      // 4. 检查大小限制
      const contentLength = this.getContentLength(details.responseHeaders);
      if (contentLength > session.config.maxSize) {
        session.stats.skippedCount++;
        if (session.stats.skippedCount <= 10) {
          log.debug(
            `跳过大文件 (${session.id}): ${details.url.substring(0, 80)} (${this.formatBytes(contentLength)})`
          );
        }
        return;
      }

      // 5. 检查数量限制
      if (session.responses.size >= session.config.maxCount) {
        return;
      }

      // 6. 去重（已捕获的 URL 跳过）
      if (session.responses.has(details.url)) {
        return;
      }

      // 7. 异步捕获响应数据（追踪 pending 以便 stopSession 等待）
      const capturePromise = this.captureResponseAsync(session, details).catch(error => {
        session.stats.errorCount++;
        log.warn(`捕获失败 (${session.id}): ${details.url}`, error);
      });
      const pending = this.pendingCaptures.get(session.id);
      if (pending) {
        pending.add(capturePromise);
        capturePromise.finally(() => pending.delete(capturePromise));
      }

    } catch (error) {
      session.stats.errorCount++;
      log.error(`处理响应异常 (${session.id}):`, error);
    }
  }

  /**
   * 异步捕获响应数据
   */
  private async captureResponseAsync(
    session: CaptureSession,
    details: Electron.OnCompletedListenerDetails
  ): Promise<void> {
    const mimeType = this.getMimeType(details.responseHeaders);
    const contentLength = this.getContentLength(details.responseHeaders);

    // 构建基础响应对象
    const response: NetworkResponse = {
      url: details.url,
      status: details.statusCode,
      statusText: details.statusLine || 'OK',
      headers: this.flattenHeaders(details.responseHeaders),
      mimeType,
      size: contentLength,
      timestamp: Date.now()
    };

    // 如果配置了捕获响应体
    if (session.config.captureBody) {
      // 判断是否需要捕获 body（图片和小文本）
      const shouldCaptureBody =
        mimeType?.startsWith('image/') ||
        mimeType?.includes('json') ||
        mimeType?.includes('javascript') ||
        mimeType?.includes('css') ||
        mimeType?.includes('html');

      if (shouldCaptureBody && contentLength < session.config.maxSize) {
        try {
          await this.acquireFetchSlot();
          let body: string | undefined;
          try {
            body = await this.fetchResponseBody(details.url, mimeType, {
              webContentsId: details.webContentsId,
              referrer: details.referrer
            });
          } finally {
            this.releaseFetchSlot();
          }
          if (body) {
            response.body = body;

            // 生成预览
            if (mimeType?.startsWith('image/')) {
              response.bodyPreview = `(base64 image, ${this.formatBytes(body.length)})`;
            } else {
              response.bodyPreview = body.length > 200 ? body.substring(0, 200) + '...' : body;
            }
          } else {
            log.warn(
              `跳过无 body 的图片响应 (${session.id}): ${details.url.substring(0, 80)}`
            );
            session.stats.skippedCount++;
            return;
          }
        } catch (error: any) {
          if (error?.fetchStatusCode === 403) {
            log.warn(`捕获失败(防盗链) (${session.id}): ${details.url.substring(0, 80)}`);
            response.captureStatus = 'capture_failed_hotlink';
            response.bodyPreview = '(403 防盗链拦截，无法获取内容)';
          } else {
            log.warn(`获取响应体失败 (${session.id}): ${details.url.substring(0, 80)}`, error);
            session.stats.errorCount++;
            return;
          }
        }
      }
    }

    // 保存到会话（只保存有 body 的响应）
    session.responses.set(details.url, response);
    session.stats.capturedCount++;

    // RP-001 修复：同步写入 ResourceHub，消除数据孤岛
    if (response.body && session.viewId) {
      try {
        const isImage = mimeType?.startsWith('image/');
        const contentRef = isImage
          ? { kind: 'data_url' as const, data: response.body, size: response.size || 0, mimeType: mimeType!, capturedAt: Date.now() }
          : { kind: 'text' as const, data: response.body, size: response.size || 0, mimeType: mimeType || 'text/plain', capturedAt: Date.now() };
        getResourceHubService().attachCapturedContent(session.viewId, details.url, {
          mimeType,
          size: response.size,
          category: isImage ? 'image' : undefined,
          source: 'webrequest_capture',
          pageUrl: details.referrer,
          contentRef
        });
      } catch (hubError) {
        log.warn(`写入 ResourceHub 失败 (${session.id}): ${details.url.substring(0, 80)}`, hubError);
      }
    }

    if (session.stats.capturedCount % 10 === 0) {
      const imageCount = Array.from(session.responses.values())
        .filter(r => r.mimeType?.startsWith('image/')).length;

      log.debug(
        `已捕获 ${session.stats.capturedCount} 个资源 (${session.id})`,
        `[图片: ${imageCount}, 总大小: ${this.formatBytes(this.getTotalSize(session))}]`
      );
    }
  }

  /**
   * 获取响应体（二次请求）
   * 使用 Electron net 模块，兼容处理超时
   */
  private async fetchResponseBody(
    url: string,
    mimeType?: string,
    requestContext?: { webContentsId?: number; referrer?: string }
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      try {
        let requestSession: Electron.Session | undefined;
        if (requestContext?.webContentsId) {
          try {
            requestSession = webContents.fromId(requestContext.webContentsId)?.session;
          } catch {
            // webContents may have been destroyed; fall through to no-session request
          }
        }

        const requestOptions: Electron.ClientRequestConstructorOptions = {
          url,
          method: 'GET',
          redirect: 'follow',
          ...(requestSession ? { session: requestSession } : {})
        };

        const request = net.request(requestOptions);

        if (requestContext?.referrer) {
          request.setHeader('Referer', requestContext.referrer);
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;
        const maxSize = 500 * 1024; // 500KB 限制
        let timeoutId: NodeJS.Timeout | null = null;
        let isCompleted = false;

        // 手动实现超时机制（兼容 Electron net.request）
        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          isCompleted = true;
        };

        timeoutId = setTimeout(() => {
          if (!isCompleted) {
            log.warn(`请求超时 (5s): ${url.substring(0, 80)}`);
            try {
              request.abort();
            } catch (e) {
              // 忽略 abort 错误
            }
            cleanup();
            resolve(undefined);
          }
        }, 5000);

        request.on('response', (response) => {
          const statusCode: number = (response as any).statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            try { request.abort(); } catch (e) { /* ignore */ }
            cleanup();
            if (statusCode === 403) {
              log.warn(`二次请求被 403 拒绝(可能防盗链): ${url.substring(0, 80)}`);
              const err = new Error(`fetch_status_403`) as Error & { fetchStatusCode: number };
              err.fetchStatusCode = 403;
              reject(err);
            } else {
              log.warn(`二次请求非 2xx (${statusCode}): ${url.substring(0, 80)}`);
              resolve(undefined);
            }
            return;
          }

          response.on('data', (chunk) => {
            if (isCompleted) return;

            totalSize += chunk.length;

            // 超过大小限制则中断
            if (totalSize > maxSize) {
              log.warn(`资源过大 (${totalSize} bytes): ${url.substring(0, 80)}`);
              try {
                request.abort();
              } catch (e) {
                // 忽略
              }
              cleanup();
              resolve(undefined);
              return;
            }

            chunks.push(chunk);
          });

          response.on('end', () => {
            if (isCompleted) return;
            cleanup();

            try {
              const buffer = Buffer.concat(chunks);

              if (mimeType?.startsWith('image/')) {
                // 图片：转 base64
                const base64 = buffer.toString('base64');
                resolve(`data:${mimeType};base64,${base64}`);
              } else {
                // 文本：直接返回
                resolve(buffer.toString('utf8'));
              }
            } catch (error) {
              log.warn(`转换响应体失败: ${url.substring(0, 80)}`, error);
              resolve(undefined);
            }
          });

          response.on('error', (error) => {
            if (isCompleted) return;
            cleanup();
            log.warn(`响应流错误: ${url.substring(0, 80)}`, error);
            resolve(undefined);
          });
        });

        request.on('error', (error) => {
          if (isCompleted) return;
          cleanup();
          // 只记录非中断错误
          if (error && (error as any).code !== 'ERR_ABORTED') {
            log.warn(`请求错误: ${url.substring(0, 80)}`, error);
          }
          resolve(undefined);
        });

        request.end();

      } catch (error) {
        log.warn(`创建请求异常: ${url.substring(0, 80)}`, error);
        resolve(undefined);
      }
    });
  }

/**
 * 停止捕获会话并获取结果
 * 等待所有飞行中的异步捕获完成后再返回，避免数据丢失
 * @deprecated 请使用 CDPNetworkCaptureService.stopSessionFull() 替代。
 */
async stopSession(sessionId: string): Promise<NetworkResponse[]> {
  const session = this.sessions.get(sessionId);
  if (!session) {
    log.warn(`会话不存在: ${sessionId}`);
    return [];
  }

  // 等待所有飞行中的捕获完成
  const pending = this.pendingCaptures.get(sessionId);
  if (pending && pending.size > 0) {
    log.debug(`等待 ${pending.size} 个飞行中的捕获完成 (${sessionId})`);
    await Promise.allSettled(Array.from(pending));
  }

  const responses = Array.from(session.responses.values());
  const duration = Date.now() - session.startTime;
  const imageCount = responses.filter(r => r.mimeType?.startsWith('image/')).length;
  const totalSize = this.getTotalSize(session);

  log.info(`捕获会话结束: ${sessionId}`, {
    总请求数: session.stats.totalRequests,
    捕获数: session.stats.capturedCount,
    跳过数: session.stats.skippedCount,
    错误数: session.stats.errorCount,
    图片数: imageCount,
    总大小: this.formatBytes(totalSize),
    耗时: `${(duration / 1000).toFixed(1)}s`
  });

  // 清理会话
  this.sessions.delete(sessionId);
  this.pendingCaptures.delete(sessionId);

  return responses;
}

  /**
   * 获取会话实时统计
   */
  getSessionStats(sessionId: string): {
    totalCount: number;
    imageCount: number;
    totalSize: number;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const responses = Array.from(session.responses.values());
    const imageCount = responses.filter(r => r.mimeType?.startsWith('image/')).length;
    const totalSize = this.getTotalSize(session);

    return {
      totalCount: responses.length,
      imageCount,
      totalSize
    };
  }

  /**
   * 检查会话是否存在
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * 辅助方法：获取 Content-Type
   */
  private getMimeType(headers?: Record<string, string[]>): string | undefined {
    if (!headers) return undefined;

    const contentType = headers['content-type']?.[0] || headers['Content-Type']?.[0];
    return contentType?.split(';')[0]?.trim();
  }

  /**
   * 辅助方法：获取 Content-Length
   */
  private getContentLength(headers?: Record<string, string[]>): number {
    if (!headers) return 0;

    const contentLength = headers['content-length']?.[0] || headers['Content-Length']?.[0];
    return parseInt(contentLength || '0', 10);
  }

  /**
   * 辅助方法：扁平化响应头
   */
  private flattenHeaders(headers?: Record<string, string[]>): Record<string, string> {
    if (!headers) return {};

    const result: Record<string, string> = {};
    for (const [key, values] of Object.entries(headers)) {
      result[key] = values.join(', ');
    }
    return result;
  }

  /**
   * 辅助方法：计算会话总大小
   */
  private getTotalSize(session: CaptureSession): number {
    return Array.from(session.responses.values())
      .reduce((sum, r) => sum + (r.size || 0), 0);
  }

  /**
   * 辅助方法：格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }

  private acquireFetchSlot(): Promise<void> {
    if (this._activeFetches < FETCH_CONCURRENCY_LIMIT) {
      this._activeFetches++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this._fetchQueue.push(resolve));
  }

  private releaseFetchSlot(): void {
    const next = this._fetchQueue.shift();
    if (next) {
      next();
    } else {
      this._activeFetches--;
    }
  }

  /**
   * 清理所有会话（用于应用退出时）
   */
  async cleanup(): Promise<void> {
    log.info(`清理所有捕获会话 (${this.sessions.size} 个)`);
    const stopPromises = Array.from(this.sessions.keys()).map(id => this.stopSession(id));
    await Promise.allSettled(stopPromises);
    this.sessions.clear();
    this.pendingCaptures.clear();
  }
}

// 单例导出
export const networkCaptureService = new NetworkCaptureService();

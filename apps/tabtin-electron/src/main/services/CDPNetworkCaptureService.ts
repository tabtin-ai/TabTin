/**
 * CDP 网络捕获服务
 *
 * 在 Puppeteer Page 连接后立即启用 CDP Network domain，
 * 拦截所有 image response，直接写入缓存。
 *
 * 优势：
 * - 100% 捕获所有图片（不依赖 DOM 渲染）
 * - 不需要 WebRequest 二次请求
 * - 不需要 DOM 注入强制触发
 * - 统一的网络层拦截
 *
 * @author TabTin Team
 * @date 2025-11-19
 */

import { createLogger } from '../logger'
const log = createLogger('CDPCapture')

import { formatBytes } from '../utils/file-path'
import { getResourceHubService } from './ResourceHubService'
import { getResourceDetectionService } from './ResourceDetectionService'

// 使用兼容的类型定义，避免直接依赖 puppeteer-core 和 devtools-protocol
type Page = any;
type CDPSession = any;
type Protocol = any;

export interface CapturedImage {
  url: string;
  mimeType: string;
  body: string; // base64 data URL 格式
  size: number;
  timestamp: number;
  requestId: string;
}

/**
 * 捕获的媒体资源（扩展自 CapturedImage，支持视频/音频/m3u8 等）
 */
export interface CapturedMediaResource {
  url: string;
  mimeType: string;
  /** base64 data URL（仅小文件），大文件为 undefined */
  body?: string;
  /** 文本内容（m3u8 playlist 等文本资源） */
  textContent?: string;
  size: number;
  timestamp: number;
  requestId: string;
  /** 资源类别 */
  resourceType: 'image' | 'video' | 'audio' | 'hls' | 'dash' | 'document';
}

const CDP_CAPTURE_CONCURRENCY = 8
const CDP_CAPTURE_MAX_QUEUE = 200

class CaptureSemaphore {
  private running = 0
  private queue: Array<() => void> = []
  private _droppedCount = 0

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number = CDP_CAPTURE_MAX_QUEUE
  ) {}

  /**
   * @returns Promise that resolves when a slot is available, or `null` if queue is full (task dropped).
   */
  acquire(): Promise<void> | null {
    if (this.running < this.limit) {
      this.running++
      return Promise.resolve()
    }
    if (this.queue.length >= this.maxQueue) {
      this._droppedCount++
      return null
    }
    return new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) {
      this.running++
      next()
    }
  }

  get pendingCount(): number {
    return this.running + this.queue.length
  }

  get droppedCount(): number {
    return this._droppedCount
  }

  get queueLength(): number {
    return this.queue.length
  }
}

export interface CDPNetworkCaptureSession {
  id: string;
  /** 关联的 WebContentsView viewId，写入 ResourceHub 时使用此 ID（RP-002 修复） */
  viewId: string;
  page: Page;
  cdpSession: CDPSession;
  images: Map<string, CapturedImage>;
  /** 扩展：所有媒体资源（包括视频/音频/m3u8 等） */
  mediaResources: Map<string, CapturedMediaResource>;
  requestIdMap: Map<string, string>; // requestId -> URL
  /** requestId -> resource type mapping */
  requestTypeMap: Map<string, string>;
  startTime: number;
  pendingCaptures: Set<Promise<void>>;
  stopping: boolean;
  captureSemaphore: CaptureSemaphore;
  diagnosticInterval?: NodeJS.Timeout;
  stats: {
    totalRequests: number;
    imageRequests: number;
    capturedImages: number;
    failedImages: number;
    /** 扩展统计 */
    mediaRequests: number;
    capturedMedia: number;
    failedMedia: number;
  };
}

/**
 * CDP 网络捕获服务（单例）
 */
export class CDPNetworkCaptureService {
  private sessions = new Map<string, CDPNetworkCaptureSession>();
  private aliasToSessionId = new Map<string, string>();

  // ✅ 新增：已完成会话的缓存（用于幂等 stopSession）
  private finishedSessions = new Map<string, { images: CapturedImage[]; media: CapturedMediaResource[] }>();
  private readonly FINISHED_SESSION_TTL = 5 * 60 * 1000; // 5 分钟后自动清理

  /**
   * 启动 CDP 网络捕获会话
   *
   * @param sessionId 会话 ID（通常是 taskId 或 connectionId）
   * @param page Puppeteer Page 实例
   * @param aliases 会话别名列表
   * @param options.viewId 关联的 WebContentsView viewId，用于写入 ResourceHub 时保持与 ResourceDetection 一致
   */
  async startSession(sessionId: string, page: Page, aliases: string[] = [], options?: { viewId?: string }): Promise<void> {
    log.info(`启动 CDP 网络捕获会话: ${sessionId}`);

    // 如果会话已存在，先停止
    if (this.sessions.has(sessionId)) {
      await this.stopSession(sessionId);
    }

    let session: CDPNetworkCaptureSession | null = null;
    try {
      // ✅ 关键修复：使用 page.target() 并验证类型
      const target = page.target();

      // ✅ 强校验：必须确保 target 有效
      if (!target) {
        throw new Error('Page target is null or undefined');
      }

      // ✅ 获取 target 信息（使用安全的方式）
      const targetType = target.type();  // 使用方法而不是私有属性
      const targetUrl = page.url();      // 使用 page.url() 而不是 target._targetInfo.url

      log.debug('目标信息:', {
        type: targetType,
        url: targetUrl?.substring(0, 80) || 'N/A',
        isClosed: page.isClosed()
      });

      // ✅ 强校验：必须是页面类 target
      // : 同时接受 'webview'（<webview> tag 的 guest 页面 target 类型），为 Phase 2 铺路
      if (targetType !== 'page' && targetType !== 'webview') {
        throw new Error(`Target 类型错误: 期望 'page' 或 'webview'，实际 '${targetType}'`);
      }

      // ✅ 强校验：不能是 DevTools、localhost 等内部页面
      const isDevTools = targetUrl.startsWith('devtools://');
      const isLocalhost = targetUrl.includes('localhost:');
      const isChromeExtension = targetUrl.startsWith('chrome-extension://');

      if (isDevTools || isLocalhost || isChromeExtension) {
        throw new Error(
          `❌ 拒绝为内部页面启动 CDP 捕获！\n` +
          `  URL: ${targetUrl}\n` +
          `  这是 DevTools/localhost/extension 页面，不是业务页面。\n` +
          `  请确保 Puppeteer 连接到正确的 Page target。`
        );
      }

      // ✅ 强校验：Page 必须有效且未关闭
      if (page.isClosed()) {
        throw new Error('Page 已关闭，无法启动 CDP 捕获');
      }

      // 1. 创建 CDP Session（绑定到 Page target）
      const cdpSession = await target.createCDPSession();
      log.info(`CDP Session 已创建 (type: ${targetType})`);

      // 2. ✅ 启用 Network domain（必须在正确的 target session 上调用）
      await cdpSession.send('Network.enable', {
        maxResourceBufferSize: 50 * 1024 * 1024, // 50MB 缓冲区
        maxPostDataSize: 0 // 不捕获 POST body
      });
      log.info('Network domain 已启用');

      // 3. ✅ 验证 CDP Session 有效性（发送测试命令）
      try {
        await cdpSession.send('Network.getAllCookies');
        log.info('CDP Session 验证成功（可以发送命令）');
      } catch (error) {
        throw new Error(`CDP Session 无效，无法发送命令: ${error}`);
      }

      // 4. 创建会话对象
      session = {
        id: sessionId,
        viewId: options?.viewId || sessionId,
        page,
        cdpSession,
        images: new Map(),
        mediaResources: new Map(),
        requestIdMap: new Map(),
        requestTypeMap: new Map(),
        startTime: Date.now(),
        pendingCaptures: new Set(),
        stopping: false,
        captureSemaphore: new CaptureSemaphore(CDP_CAPTURE_CONCURRENCY),
        stats: {
          totalRequests: 0,
          imageRequests: 0,
          capturedImages: 0,
          failedImages: 0,
          mediaRequests: 0,
          capturedMedia: 0,
          failedMedia: 0
        }
      };

      // 5. 设置事件监听
      this.setupNetworkListeners(session);

      // 6. 存储会话
      this.sessions.set(sessionId, session);
      this.aliasToSessionId.set(sessionId, sessionId);
      for (const alias of aliases) {
        if (alias && alias !== sessionId) {
          this.aliasToSessionId.set(alias, sessionId);
        }
      }

      log.info(`会话已启动: ${sessionId}，等待网络事件...`);
      log.debug('将在 3 秒后检测事件接收情况');

      // ✅ 添加超时检测：3 秒后如果仍然 0 事件，打印警告（而非致命错误）
      // 因为在翻页场景下，页面可能需要更长时间才开始加载资源
      setTimeout(() => {
        if (!this.sessions.has(sessionId)) return;
        if (session!.stats.totalRequests === 0) {
          log.warn('3 秒内未收到任何 Network 事件');
          log.warn('可能原因: 页面正在空闲中，或正在导航/翻页');
          log.warn('当前状态:', {
            sessionId: session!.id,
            pageUrl: page.url(),
            pageClosed: page.isClosed(),
            targetType,
            totalRequests: session!.stats.totalRequests
          });
          log.warn('继续观察，如果整个会话结束时仍为 0，才是真正的问题');
        }
      }, 3000);

    } catch (error) {
      // RP-012 修复：异常时清理可能已创建的 diagnosticInterval，防止定时器泄漏
      if (session?.diagnosticInterval) {
        clearInterval(session.diagnosticInterval);
        session.diagnosticInterval = undefined;
      }
      log.error(`启动会话失败: ${sessionId}`, error);
      throw error;
    }
  }

  /**
   * 设置网络事件监听
   */
  private setupNetworkListeners(session: CDPNetworkCaptureSession): void {
    const { cdpSession } = session;

    // ✅ 添加诊断：记录事件接收总数
    let eventCounts = {
      requestWillBeSent: 0,
      responseReceived: 0,
      loadingFinished: 0,
      loadingFailed: 0
    };

    // 记录上一次的统计数据，用于检测变化
    let lastLoggedStats = {
      requestWillBeSent: 0,
      responseReceived: 0,
      loadingFinished: 0,
      loadingFailed: 0,
      imageRequests: 0,
      capturedImages: 0
    };

    let zeroWarningCount = 0; // 记录连续0事件的次数

    // 每 5 秒检查统计数据变化
    const diagnosticInterval = setInterval(() => {
      const currentStats = {
        requestWillBeSent: eventCounts.requestWillBeSent,
        responseReceived: eventCounts.responseReceived,
        loadingFinished: eventCounts.loadingFinished,
        loadingFailed: eventCounts.loadingFailed,
        imageRequests: session.stats.imageRequests,
        capturedImages: session.stats.capturedImages
      };

      // 检查数据是否有变化
      const hasChanged =
        currentStats.requestWillBeSent !== lastLoggedStats.requestWillBeSent ||
        currentStats.responseReceived !== lastLoggedStats.responseReceived ||
        currentStats.loadingFinished !== lastLoggedStats.loadingFinished ||
        currentStats.loadingFailed !== lastLoggedStats.loadingFailed ||
        currentStats.imageRequests !== lastLoggedStats.imageRequests ||
        currentStats.capturedImages !== lastLoggedStats.capturedImages;

      // 只在数据变化时输出日志
      if (hasChanged) {
        log.debug(`事件统计 (${session.id}):`, {
          请求发送: currentStats.requestWillBeSent,
          响应接收: currentStats.responseReceived,
          加载完成: currentStats.loadingFinished,
          加载失败: currentStats.loadingFailed,
          图片请求: currentStats.imageRequests,
          已捕获: currentStats.capturedImages
        });

        // 更新上次记录的数据
        lastLoggedStats = { ...currentStats };
        zeroWarningCount = 0; // 重置警告计数
      }

      // ✅ 如果事件全为 0，只在首次时打印警告（避免重复）
      if (eventCounts.requestWillBeSent === 0 && eventCounts.responseReceived === 0) {
        zeroWarningCount++;
        if (zeroWarningCount === 1) {
          log.warn('警告: Network 事件仍为 0，检查 CDP Session 绑定');
        }
      }
    }, 5000);

    // 🔧 将定时器 ID 存储到会话对象中
    session.diagnosticInterval = diagnosticInterval;

    // 会话结束时清理定时器
    cdpSession.once('disconnected', () => {
      clearInterval(diagnosticInterval);
      log.debug(`CDP Session 已断开: ${session.id}`);
    });

    // ✅ 监听请求发送
    cdpSession.on('Network.requestWillBeSent', (params: any) => {
      eventCounts.requestWillBeSent++;
      session.stats.totalRequests++;

      if (eventCounts.requestWillBeSent === 1) {
        log.debug('首次收到 Network.requestWillBeSent 事件');
        log.debug(`第一个请求: ${params.request.url.substring(0, 80)}`);
      }

      session.requestIdMap.set(params.requestId, params.request.url);

      const mediaType = this.classifyMediaRequest(params.request.url, params.type);
      session.requestTypeMap.set(params.requestId, mediaType || '');

      if (mediaType === 'image') {
        session.stats.imageRequests++;
        if (session.stats.imageRequests <= 5) {
          log.debug(`图片请求 (#${session.stats.imageRequests}): ${params.request.url.substring(0, 80)}`);
        }
      } else if (mediaType) {
        session.stats.mediaRequests++;
        log.debug(`媒体请求 [${mediaType}] (#${session.stats.mediaRequests}): ${params.request.url.substring(0, 80)}`);
      }
    });

    cdpSession.on('Network.responseReceived', (params: any) => {
      eventCounts.responseReceived++;

      if (eventCounts.responseReceived === 1) {
        log.debug('首次收到 Network.responseReceived 事件');
      }

      try {
        if (session.stopping) return;

        const url = session.requestIdMap.get(params.requestId);
        if (!url) return;

        const response = params.response;
        const mimeType = response.mimeType;
        if (!mimeType) return;

        if (response.status < 200 || response.status >= 300) return;

        const contentLength = parseInt(response.headers['content-length'] || response.headers['Content-Length'] || '0');
        const mediaType = this.classifyByMimeType(mimeType, url);

        if (!mediaType) return;

        if (mediaType === 'image') {
          if (contentLength > 500 * 1024) {
            session.stats.failedImages++;
            return;
          }
          if (session.images.has(url)) return;
          this.scheduleCapture(session, () =>
            this.captureResponseBody(session, params.requestId, url, mimeType)
          );
        } else {
          if (session.mediaResources.has(url)) return;

          const isTextResource = mediaType === 'hls' || mediaType === 'dash';
          const sizeLimit = isTextResource ? 5 * 1024 * 1024 : 10 * 1024 * 1024;

          if (contentLength > sizeLimit) {
            session.stats.failedMedia++;
            log.debug(`跳过大媒体: ${url.substring(0, 80)} (${formatBytes(contentLength)})`);
            return;
          }

          this.scheduleCapture(session, () =>
            this.captureMediaResponseBody(session, params.requestId, url, mimeType, mediaType, isTextResource)
          );
        }

      } catch (error) {
        log.warn('处理响应失败:', error);
      }
    });

    // 监听加载完成
    cdpSession.on('Network.loadingFinished', (params: any) => {
      eventCounts.loadingFinished++;
      // 可选：记录加载完成事件
    });

    // 监听加载失败
    cdpSession.on('Network.loadingFailed', (params: any) => {
      eventCounts.loadingFailed++;
      const url = session.requestIdMap.get(params.requestId);

      if (url) {
        // ✅ 改进：只记录图片资源的加载失败，且增加错误原因
        const isImageUrl = this.isImageRequest(url, params.type);

        if (isImageUrl) {
          session.stats.failedImages++;

          // 只在失败图片数量较少时输出详细日志（避免刷屏）
          if (session.stats.failedImages <= 5) {
            log.warn(`图片加载失败 (#${session.stats.failedImages}):`, {
              url: url.substring(0, 100),
              reason: params.errorText || '未知原因',
              type: params.type,
              sessionId: session.id
            });
          }
        } else {
          // 非图片资源的失败只在 debug 模式下记录
          if (process.env.DEBUG_CDP === 'true') {
            log.debug(`非图片资源加载失败: ${url.substring(0, 80)}`);
          }
        }
      }
    });
  }

  /**
   * 将捕获任务入队，受 semaphore 并发控制，并跟踪 pending promise
   * 以便 stopSession 时等待所有飞行中请求完成。
   */
  private scheduleCapture(
    session: CDPNetworkCaptureSession,
    fn: () => Promise<void>
  ): void {
    if (session.stopping) return

    const permit = session.captureSemaphore.acquire()
    if (!permit) {
      const dropped = session.captureSemaphore.droppedCount
      if (dropped === 1 || (dropped % 50 === 0 && dropped > 1)) {
        log.warn(`捕获队列已满，丢弃任务 (累计丢弃: ${dropped}, 队列: ${session.captureSemaphore.queueLength})`)
      }
      return
    }

    const task = permit.then(async () => {
      if (session.stopping) {
        session.captureSemaphore.release()
        return
      }
      try {
        await fn()
      } finally {
        session.captureSemaphore.release()
      }
    })

    session.pendingCaptures.add(task)
    task.finally(() => session.pendingCaptures.delete(task))
  }

  /**
   * 捕获响应体（异步）
   */
  private async captureResponseBody(
    session: CDPNetworkCaptureSession,
    requestId: string,
    url: string,
    mimeType: string
  ): Promise<void> {
    try {
      // 获取响应体
      const result = await session.cdpSession.send('Network.getResponseBody', { requestId });

      let base64Data: string;

      if (result.base64Encoded) {
        // 已经是 base64
        base64Data = result.body;
      } else {
        // 文本，需要转换为 base64
        base64Data = Buffer.from(result.body, 'utf8').toString('base64');
      }

      // 构造 data URL
      const dataUrl = `data:${mimeType};base64,${base64Data}`;
      const size = Buffer.byteLength(base64Data, 'base64');

      // 存储到缓存
      const capturedImage: CapturedImage = {
        url,
        mimeType,
        body: dataUrl,  // ✅ 统一使用 body 字段
        size,
        timestamp: Date.now(),
        requestId
      };

      session.images.set(url, capturedImage);
      session.stats.capturedImages++;
      getResourceHubService().attachCapturedContent(session.viewId, url, {
        mimeType,
        size,
        category: 'image',
        source: 'cdp_capture',
        pageUrl: session.page?.url?.(),
        contentRef: {
          kind: 'data_url',
          data: dataUrl,
          size,
          mimeType,
          capturedAt: Date.now()
        }
      });

      // ✅ 改进：只在关键节点输出日志
      if (session.stats.capturedImages === 1) {
        log.info(`首张图片捕获成功: ${url.substring(0, 100)}`);
      } else if (session.stats.capturedImages % 50 === 0) {
        log.info(
          `已捕获 ${session.stats.capturedImages} 张图片` +
          ` (总大小: ${formatBytes(this.getTotalSize(session))})`
        );
      }

    } catch (error: any) {
      session.stats.failedImages++;

      // ✅ 改进：区分错误类型，提供更有用的信息
      const errorMessage = error.message || String(error);

      // 只在前几次失败时输出详细错误（避免刷屏）
      if (session.stats.failedImages <= 5) {
        if (errorMessage.includes('No resource with given identifier found')) {
          // 常见错误：资源已被清理（正常情况，不需要警告）
          if (process.env.DEBUG_CDP === 'true') {
            log.debug(`资源已清理: ${url.substring(0, 80)}`);
          }
        } else if (errorMessage.includes('Could not parse CSS')) {
          // JSDOM 解析错误（不影响功能，可忽略）
          if (process.env.DEBUG_CDP === 'true') {
            log.debug(`CSS 解析警告 (可忽略): ${errorMessage.substring(0, 100)}`);
          }
        } else {
          // 其他错误：输出警告
          log.warn(`捕获响应体失败 (#${session.stats.failedImages}):`, {
            url: url.substring(0, 100),
            error: errorMessage.substring(0, 200),
            sessionId: session.id
          });
        }
      } else if (session.stats.failedImages === 6) {
        // 失败次数过多时，只输出一次汇总警告
        log.warn(`多个图片捕获失败 (${session.id})，后续错误将不再输出详细日志`);
      }
    }
  }

  /**
   * 捕获媒体资源响应体（视频/音频/m3u8 等）
   */
  private async captureMediaResponseBody(
    session: CDPNetworkCaptureSession,
    requestId: string,
    url: string,
    mimeType: string,
    resourceType: CapturedMediaResource['resourceType'],
    isTextResource: boolean
  ): Promise<void> {
    try {
      const result = await session.cdpSession.send('Network.getResponseBody', { requestId });

      const resource: CapturedMediaResource = {
        url,
        mimeType,
        size: 0,
        timestamp: Date.now(),
        requestId,
        resourceType
      };

      if (isTextResource) {
        const text = result.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf8')
          : result.body;
        resource.textContent = text;
        resource.size = Buffer.byteLength(text, 'utf8');
      } else {
        const base64Data = result.base64Encoded
          ? result.body
          : Buffer.from(result.body, 'utf8').toString('base64');
        resource.body = `data:${mimeType};base64,${base64Data}`;
        resource.size = Buffer.byteLength(base64Data, 'base64');
      }

      session.mediaResources.set(url, resource);
      session.stats.capturedMedia++;
      const contentRef = resource.textContent != null
        ? {
            kind: 'text' as const,
            data: resource.textContent,
            size: resource.size,
            mimeType,
            capturedAt: Date.now()
          }
        : resource.body
          ? {
              kind: 'data_url' as const,
              data: resource.body,
              size: resource.size,
              mimeType,
              capturedAt: Date.now()
            }
          : undefined;

      if (contentRef) {
        getResourceHubService().attachCapturedContent(session.viewId, url, {
          mimeType,
          size: resource.size,
          category: resourceType === 'document' ? 'document' : resourceType,
          source: 'cdp_capture',
          pageUrl: session.page?.url?.(),
          contentRef
        });
      } else {
        log.warn(`媒体资源无可用内容，跳过写入 ResourceHub: ${url.substring(0, 80)} [${resourceType}]`);
      }

      if (session.stats.capturedMedia <= 10) {
        log.info(
          `媒体捕获 [${resourceType}]: ${url.substring(0, 100)} (${formatBytes(resource.size)})`
        );
      }
    } catch (error: any) {
      session.stats.failedMedia++;
      if (session.stats.failedMedia <= 5) {
        const msg = error.message || String(error);
        if (!msg.includes('No resource with given identifier found')) {
          log.warn(`媒体捕获失败 [${resourceType}]: ${url.substring(0, 80)}`, msg.substring(0, 100));
        }
      }
    }
  }

  /**
   * 分类网络请求的媒体类型
   */
  private classifyMediaRequest(url: string, resourceType?: string): CapturedMediaResource['resourceType'] | null {
    if (resourceType === 'Image') return 'image';
    if (resourceType === 'Media') {
      const urlLower = url.toLowerCase();
      if (urlLower.includes('.m3u8') || urlLower.includes('mpegurl')) return 'hls';
      if (urlLower.includes('.mpd') || urlLower.includes('dash')) return 'dash';
      if (/\.(mp3|aac|ogg|wav|flac|m4a|opus)/i.test(urlLower)) return 'audio';
      return 'video';
    }

    const urlLower = url.toLowerCase();
    if (/\.(m3u8)(\?|#|$)/.test(urlLower)) return 'hls';
    if (/\.(mpd)(\?|#|$)/.test(urlLower)) return 'dash';
    if (/\.(mp4|webm|flv|mov|avi|mkv|ts)(\?|#|$)/.test(urlLower)) return 'video';
    if (/\.(mp3|aac|ogg|wav|flac|m4a|opus)(\?|#|$)/.test(urlLower)) return 'audio';
    if (/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif)(\?|#|$)/.test(urlLower)) return 'image';

    return null;
  }

  /**
   * 根据 MIME 类型分类
   */
  private classifyByMimeType(mimeType: string, url: string): CapturedMediaResource['resourceType'] | null {
    const mime = mimeType.toLowerCase();

    if (mime.startsWith('image/')) return 'image';
    if (mime.includes('mpegurl') || mime.includes('x-mpegurl')) return 'hls';
    if (mime.includes('dash+xml')) return 'dash';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf' || mime.includes('msword') || mime.includes('officedocument')) return 'document';

    return this.classifyMediaRequest(url);
  }

  /**
   * 判断是否为图片请求（向后兼容）
   */
  private isImageRequest(url: string, resourceType?: any): boolean {
    return this.classifyMediaRequest(url, resourceType) === 'image';
  }


  /**
   * 确保指定数量的图片已被捕获
   *
   * 业务场景：翻页前确保第一页海报已被 CDP 捕获。
   * 如果当前捕获数量不足，则触发页面 reload 来补抓资源。
   *
   * @param options 配置选项
   * @param options.sessionId 会话 ID
   * @param options.page Puppeteer Page 实例
   * @param options.url 当前页面 URL（用于 reload）
   * @param options.minImages 最少期望图片数量（默认 25）
   * @param options.timeoutMs 页面加载超时（默认 8000ms）
   */
  async ensureImagesCaptured(options: {
    sessionId: string;
    page: Page;
    url: string;
    minImages?: number;
    timeoutMs?: number;
  }): Promise<void> {
    const { sessionId, page, url, minImages = 25, timeoutMs = 8000 } = options;

    // 1. 获取当前捕获统计
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.warn(
        `会话不存在: ${sessionId}，无法确保图片捕获`
      );
      return;
    }

    const currentCaptured = session.stats.capturedImages;

    // 2. 如果已经捕获足够，直接返回
    if (currentCaptured >= minImages) {
      log.info(
        '已捕获足够图片，无需 reload',
        {
          sessionId,
          currentCaptured,
          minImages,
          url: url.substring(0, 80)
        }
      );
      return;
    }

    // 3. 图片不足，触发 reload
    log.info(
      '图片捕获不足，触发 reload 捕获第一页资源',
      {
        sessionId,
        currentCaptured,
        minImages,
        url: url.substring(0, 80)
      }
    );

    // 4. Reload 前：抑制 ResourceDetectionService 的导航清理，防止已检测的非图片资源丢失
    const detectionService = getResourceDetectionService()
    const viewIdsToSuppress = this.collectRelatedViewIds(sessionId, detectionService)
    for (const vid of viewIdsToSuppress) {
      detectionService.suppressNavigationClear(vid)
    }
    log.debug(`已抑制导航清理 (viewIds: ${viewIdsToSuppress.join(', ') || 'none'})`)

    try {
      log.debug('发送 Page.reload 命令 (ignoreCache: true)');

      await session.cdpSession.send('Page.reload', { ignoreCache: true });

      await page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: timeoutMs
      }).catch((err: Error) => {
        log.warn(
          'waitForNavigation 超时（可能页面已加载完成）:',
          err.message
        );
      });

      // 5. reload 后再等待一小段时间收集 Network 事件
      log.debug('reload 完成，等待 1 秒收集网络事件');
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 6. 统计 reload 后的捕获情况
      const afterCaptured = session.stats.capturedImages;

      log.info(
        'reload 后图片捕获统计',
        {
          sessionId,
          捕获前: currentCaptured,
          捕获后: afterCaptured,
          新增: afterCaptured - currentCaptured,
          期望: minImages
        }
      );

      // 7. 如果还是不够，打印警告（但不再循环 reload，避免死循环）
      if (afterCaptured < minImages) {
        log.warn(
          'reload 后图片仍不足',
          {
            sessionId,
            afterCaptured,
            minImages,
            可能原因: [
              '页面结构变化（图片数量确实少于预期）',
              '图片过滤规则过于严格',
              '网络延迟导致部分图片未加载完成'
            ]
          }
        );
      } else {
        log.info(
          `reload 成功，图片捕获达标: ${afterCaptured} >= ${minImages}`
        );
      }

    } catch (error) {
      log.error(
        'reload 失败，继续后续流程',
        {
          sessionId,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    } finally {
      for (const vid of viewIdsToSuppress) {
        detectionService.resumeNavigationClear(vid)
      }
      log.debug('已恢复导航清理')
    }
  }

  /**
   * 停止捕获会话并获取结果（幂等操作）
   *
   * ✅ 支持多次调用：
   * - 第一次调用：从活跃会话中获取数据并清理
   * - 后续调用：从缓存中返回相同数据
   *
   * 这样可以避免多个地方调用 stopSession 导致数据丢失
   */
  /**
   * 停止捕获并返回全部资源（图片 + 媒体）。
   * 推荐使用此方法替代 stopSession。
   */
  async stopSessionFull(sessionId: string): Promise<{ images: CapturedImage[]; media: CapturedMediaResource[] }> {
    const resolvedId = this.resolveSessionId(sessionId);
    if (this.finishedSessions.has(resolvedId)) {
      return this.finishedSessions.get(resolvedId)!;
    }
    await this.stopSession(resolvedId);
    return this.finishedSessions.get(resolvedId) || { images: [], media: [] };
  }

  /**
   * @deprecated 使用 {@link stopSessionFull} 获取全部资源（含媒体）。
   * 此方法仅返回图片，保留以兼容旧调用方。
   */
  async stopSession(sessionId: string): Promise<CapturedImage[]> {
    const resolvedId = this.resolveSessionId(sessionId);
    if (this.finishedSessions.has(resolvedId)) {
      const cached = this.finishedSessions.get(resolvedId)!;
      log.debug(
        `会话已停止，返回缓存结果: ${resolvedId} (${cached.images.length} 张图片, ${cached.media.length} 媒体)`
      );
      return cached.images;
    }

    // ✅ 从活跃会话中获取
    const session = this.sessions.get(resolvedId);
    if (!session) {
      // ✅ 会话既不在活跃列表也不在缓存中，这才是真正的错误
      log.error(`会话不存在: ${resolvedId}`);
      log.error('当前活跃会话:', Array.from(this.sessions.keys()));
      log.error('已完成会话:', Array.from(this.finishedSessions.keys()));
      return [];
    }

    log.info(`停止会话: ${resolvedId}`);

    session.stopping = true;
    if (session.pendingCaptures.size > 0) {
      log.info(`等待 ${session.pendingCaptures.size} 个飞行中的捕获请求完成...`);
      await Promise.allSettled([...session.pendingCaptures]);
      log.info('所有飞行中捕获请求已完成');
    }

    const images = Array.from(session.images.values());
    const duration = Date.now() - session.startTime;
    const totalSize = this.getTotalSize(session);

    // ✅ 最终验证：根据会话类型决定日志级别
    if (session.stats.totalRequests === 0) {
      // 🆕 区分 preview/snapshot 会话和正常业务会话
      const isPreviewSession = sessionId.includes('preview') || sessionId.includes('snapshot');

      if (isPreviewSession) {
        // Preview 会话：降级为警告（可能是时机问题，不影响功能）
        log.warn(`预览会话未捕获网络请求: ${sessionId}`);
        log.warn('这可能是因为：');
        log.warn('  - CDP Session 创建时机晚于页面加载');
        log.warn('  - 页面内容来自缓存，无新请求');
        log.warn('  - 页面使用了异步加载方式');
        log.warn('注意: 这不影响数据提取功能，仅影响网络监控');
      } else {
        // 正常业务会话：保持致命错误级别
      log.error('致命错误: 会话结束时未捕获任何请求');
      log.error('这说明 CDP Session 绑定错误或 Network domain 未生效');
      log.error('检查要点:');
      log.error('  1. 是否使用 page.target().createCDPSession()');
      log.error("  2. target.type() 是否为 'page'");
      log.error('  3. page.url() 是否为业务页面（非 devtools/localhost/chrome-extension）');
      }
    }

    const mediaResources = Array.from(session.mediaResources.values());
    const mediaByType: Record<string, number> = {};
    for (const r of mediaResources) {
      mediaByType[r.resourceType] = (mediaByType[r.resourceType] || 0) + 1;
    }

    log.info(`会话统计 (${sessionId}):`, {
      总请求数: session.stats.totalRequests,
      图片请求数: session.stats.imageRequests,
      成功捕获图片: session.stats.capturedImages,
      失败图片: session.stats.failedImages,
      媒体请求数: session.stats.mediaRequests,
      成功捕获媒体: session.stats.capturedMedia,
      失败媒体: session.stats.failedMedia,
      队列溢出丢弃: session.captureSemaphore.droppedCount,
      媒体分布: mediaByType,
      '实际返回图片数': images.length,
      总大小: formatBytes(totalSize),
      耗时: `${(duration / 1000).toFixed(1)}s`
    });

    log.info(`捕获会话结束: ${sessionId}，返回 ${images.length} 张图片`);

    // 🔧 主动清理定时器（不依赖 disconnected 事件）
    if (session.diagnosticInterval) {
      clearInterval(session.diagnosticInterval);
      log.debug(`已清理诊断定时器: ${sessionId}`);
    }

    this.finishedSessions.set(resolvedId, { images, media: mediaResources });

    // ✅ 设置自动清理（5 分钟后）
    setTimeout(() => {
      if (this.finishedSessions.has(resolvedId)) {
        log.debug(`自动清理已完成会话缓存: ${resolvedId}`);
        this.finishedSessions.delete(resolvedId);
        this.clearAliases(resolvedId);
      }
    }, this.FINISHED_SESSION_TTL);

    // 清理活跃会话
    try {
      await session.cdpSession.detach();
    } catch (error) {
      log.warn('分离 CDP Session 失败:', error);
    }

    this.sessions.delete(resolvedId);

    return images;
  }

  /**
   * 获取会话实时统计
   */
  getSessionStats(sessionId: string): {
    totalCount: number;
    imageCount: number;
    mediaCount: number;
    totalSize: number;
  } | null {
    const session = this.sessions.get(this.resolveSessionId(sessionId));
    if (!session) {
      return null;
    }

    const images = Array.from(session.images.values());
    const totalSize = this.getTotalSize(session);

    return {
      totalCount: images.length + session.mediaResources.size,
      imageCount: images.length,
      mediaCount: session.mediaResources.size,
      totalSize
    };
  }

  /**
   * 获取捕获到的媒体资源（扩展 API）
   */
  getMediaResources(sessionId: string): CapturedMediaResource[] {
    const session = this.sessions.get(this.resolveSessionId(sessionId));
    if (!session) return [];
    return Array.from(session.mediaResources.values());
  }

  getSessionSnapshot(sessionId: string): { images: CapturedImage[]; media: CapturedMediaResource[] } {
    const resolvedId = this.resolveSessionId(sessionId)
    const active = this.sessions.get(resolvedId)
    if (active) {
      return {
        images: Array.from(active.images.values()),
        media: Array.from(active.mediaResources.values())
      }
    }

    return this.finishedSessions.get(resolvedId) || { images: [], media: [] }
  }

  /**
   * 检查会话是否为活跃状态（未停止）
   */
  hasActiveSession(sessionId: string): boolean {
    return this.sessions.has(this.resolveSessionId(sessionId));
  }

  /**
   * 检查会话是否存在（包括已停止的缓存）
   */
  hasSession(sessionId: string): boolean {
    const resolvedId = this.resolveSessionId(sessionId);
    return this.sessions.has(resolvedId) || this.finishedSessions.has(resolvedId);
  }

  private resolveSessionId(sessionId: string): string {
    return this.aliasToSessionId.get(sessionId) || sessionId;
  }

  /**
   * 收集与 sessionId 关联的所有可能的 ResourceDetectionService viewId。
   * 包含 session.viewId（RP-002 显式存储） + sessionId 本身 + 所有 alias。
   *
   * RP-009 修复：移除对 Puppeteer 私有 API（_client, _transport, _targetInfo）的依赖，
   * 改为使用 session.viewId 显式字段。
   */
  private collectRelatedViewIds(
    sessionId: string,
    _detectionService: { getViewIdByWebContentsId(wcId: number): string | undefined }
  ): string[] {
    const ids = new Set<string>()
    ids.add(sessionId)

    const session = this.sessions.get(sessionId)
    if (session?.viewId && session.viewId !== sessionId) {
      ids.add(session.viewId)
    }

    for (const [alias, mappedId] of this.aliasToSessionId.entries()) {
      if (mappedId === sessionId) {
        ids.add(alias)
      }
    }

    return Array.from(ids)
  }

  private clearAliases(sessionId: string): void {
    for (const [alias, mappedId] of this.aliasToSessionId.entries()) {
      if (mappedId === sessionId) {
        this.aliasToSessionId.delete(alias);
      }
    }
  }

  /**
   * 计算会话总大小
   */
  private getTotalSize(session: CDPNetworkCaptureSession): number {
    const imageSize = Array.from(session.images.values())
      .reduce((sum, img) => sum + img.size, 0);
    const mediaSize = Array.from(session.mediaResources.values())
      .reduce((sum, r) => sum + r.size, 0);
    return imageSize + mediaSize;
  }

  /**
   * 清理所有会话（用于应用退出时）
   */
  async cleanup(): Promise<void> {
    log.info(`清理所有捕获会话 (${this.sessions.size} 个)`);

    const cleanupPromises = Array.from(this.sessions.keys()).map(id => this.stopSession(id));
    await Promise.allSettled(cleanupPromises);

    this.sessions.clear();
    this.finishedSessions.clear();
    this.aliasToSessionId.clear();
  }
}

// 单例导出
export const cdpNetworkCaptureService = new CDPNetworkCaptureService();

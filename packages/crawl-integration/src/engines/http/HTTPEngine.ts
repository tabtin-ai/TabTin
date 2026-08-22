/**
 * HTTP 引擎实现
 * 基于 axios 的轻量级 HTTP 抓取引擎
 */

import type { AxiosResponse, AxiosRequestConfig } from 'axios';
import os from 'node:os';
import { EventEmitter } from 'events';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  ScrapeEngine,
  EngineCapabilities,
  EngineStatus,
  EngineHealth,
  EngineInitOptions,
  ScrapeContext,
  ScrapeProgressEvent,
  EngineEventListener
} from '../../types/engine.js';
import { AccessResult, Payload, Cookie, PerformanceTiming, NetworkRequest, DEFAULT_LIMITS } from '../../types/access-result.js';
import { HttpScrapeOptions, EngineType } from '../../types/options.js';
import { CrawlError } from '../../errors/CrawlError.js';
import { CrawlLogger } from '../../logger/CrawlLogger.js';
import { PayloadUtils } from '../../core/PayloadUtils.js';
import { CacheKeyGenerator } from '../../core/CacheKeyGenerator.js';
import { PrivacyMasker } from '../../core/PrivacyMasker.js';
import { RobotsChecker } from '../../core/RobotsChecker.js';
import { HTTPClient } from './HTTPClient.js';
import { normalizeHeaders } from '../../utils/headers.js';
import { generateId } from '../../utils/id.js';
import { safeDecodeBuffer } from '../../utils/encoding.js';
import { checkURLSecurity, extractDomain } from '../../utils/url.js';
import { ConfigProcessor } from '../../config/config-processor.js';
import { getDefaultUserAgent } from '../../config/default.js';
import { t } from '../../i18n.js';
import { RetryExecutor } from '../../utils/retry.js';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../utils/circuit-breaker.js';
import { sizeLimitManager } from '../../utils/limits.js';

export class HTTPEngine extends EventEmitter implements ScrapeEngine {
  public readonly name = 'HTTP/Fetch Client';
  public readonly type: EngineType = 'http';
  public readonly version = '1.0.0';

  public readonly capabilities: EngineCapabilities = {
    supportsJavaScript: false,
    supportsScreenshots: false,
    supportsCookies: true,
    supportsProxy: true,
    supportsUserInteraction: false,
    supportsNetworkCapture: true,
    supportsExternalBrowser: false,
    maxConcurrency: 50,
    resourceUsage: 'LOW',
    supportedProtocols: ['http:', 'https:'],
    supportedContentTypes: ['*/*'],
    canHandleSPA: false,
    canHandleInfiniteScroll: false,
    canBypassBasicAntiBot: false,
    canReuseConnections: true
  };

  private status: EngineStatus = EngineStatus.IDLE;
  private httpClient: HTTPClient;
  private logger: any;
  private config: EngineInitOptions = {};
  private defaultUserAgent = getDefaultUserAgent();
  private circuitBreaker = new CircuitBreaker();

  // 性能统计
  private metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    currentConcurrency: 0,
    maxConcurrency: 50
  };

  constructor() {
    super();
    this.logger = CrawlLogger.getInstance().namespace('HTTPEngine');
    this.httpClient = this.createHttpClient();
  }

  private createHttpClient(): HTTPClient {
    return new HTTPClient({
      timeout: 30000,
      maxRedirects: 5,
      userAgent: this.defaultUserAgent
    });
  }

  private async sendRequest(requestConfig: AxiosRequestConfig): Promise<AxiosResponse> {
    this.metrics.currentConcurrency++;
    this.logger.debug('发送 HTTP 请求', {
      url: requestConfig.url,
      method: requestConfig.method?.toUpperCase(),
      headers: Object.keys(requestConfig.headers || {}).length
    });

    try {
      const response = await this.httpClient.request(requestConfig);
      this.metrics.totalRequests++;

      if (response.status >= 200 && response.status < 400) {
        this.metrics.successfulRequests++;
        this.logger.debug('HTTP 请求成功', {
          url: response.config.url,
          status: response.status,
          size: this.getResponseSize(response)
        });
      } else {
        this.metrics.failedRequests++;
        this.logger.warn('HTTP 请求返回错误状态', {
          url: response.config.url,
          status: response.status,
          statusText: response.statusText
        });
      }

      return response;
    } catch (error: any) {
      this.metrics.totalRequests++;
      this.metrics.failedRequests++;
      this.logger.error('HTTP 请求失败', {
        url: error?.config?.url,
        message: error?.message,
        code: error?.code
      });
      throw error;
    } finally {
      this.metrics.currentConcurrency = Math.max(0, this.metrics.currentConcurrency - 1);
    }
  }

  private getResponseSize(response: AxiosResponse): number {
    const contentLength = response.headers['content-length'];
    if (contentLength) {
      return parseInt(contentLength, 10);
    }

    // 估算响应大小（兼容 arraybuffer / buffer / string 等多种响应类型）
    if (response.data instanceof ArrayBuffer) {
      return response.data.byteLength;
    } else if (Buffer.isBuffer(response.data)) {
      return response.data.length;
    } else if (typeof response.data === 'string') {
      return Buffer.byteLength(response.data, 'utf8');
    } else if (response.data && typeof response.data === 'object') {
      return Buffer.byteLength(JSON.stringify(response.data), 'utf8');
    }

    return 0;
  }

  public getStatus(): EngineStatus {
    return this.status;
  }

  public getHealth(): EngineHealth {
    return {
      status: this.status,
      healthy: this.status === EngineStatus.READY && this.metrics.currentConcurrency < this.capabilities.maxConcurrency,
      lastCheck: new Date(),
      metrics: { ...this.metrics },
      resources: {
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
        cpuUsage: 0, // HTTP 引擎 CPU 使用率很低
        activeConnections: this.metrics.currentConcurrency
      },
      errorCount: this.metrics.failedRequests,
      version: this.version
    };
  }

  public isHealthy(): boolean {
    return this.getHealth().healthy;
  }

  public async initialize(options?: EngineInitOptions): Promise<void> {
    this.logger.info('初始化 HTTP 引擎', options);
    this.status = EngineStatus.INITIALIZING;

    try {
      this.config = { ...this.config, ...options };

      // 更新 HTTP 客户端配置
      if (options?.timeout) {
        this.httpClient.updateConfig({ timeout: options.timeout });
      }

      if (options?.maxConcurrency) {
        this.capabilities.maxConcurrency = options.maxConcurrency;
        this.metrics.maxConcurrency = options.maxConcurrency;
      }

      this.status = EngineStatus.READY;
      this.logger.info('HTTP 引擎初始化完成');
    } catch (error) {
      this.status = EngineStatus.ERROR;
      this.logger.error('HTTP 引擎初始化失败', error);
      throw new CrawlError('ENGINE_INITIALIZATION_FAILED', `HTTP 引擎初始化失败: ${error}`, { engine: this.type });
    }
  }

  public async shutdown(timeoutMs: number = 30000): Promise<void> {
    this.logger.info('关闭 HTTP 引擎');
    this.status = EngineStatus.SHUTTING_DOWN;

    try {
      // 等待所有请求完成，带超时保护
      const deadline = Date.now() + timeoutMs;
      while (this.metrics.currentConcurrency > 0) {
        if (Date.now() >= deadline) {
          this.logger.warn('HTTP 引擎关闭超时，强制关闭', {
            remainingRequests: this.metrics.currentConcurrency,
            timeoutMs
          });
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.status = EngineStatus.SHUTDOWN;
      this.logger.info('HTTP 引擎已关闭');
    } catch (error) {
      this.logger.error('HTTP 引擎关闭失败', error);
      throw error;
    }
  }

  public async scrape(url: string, options?: HttpScrapeOptions): Promise<AccessResult> {
    const startTime = Date.now();
    const defaultOptions: HttpScrapeOptions = {
      engine: 'http'
    };
    const ssrfMode = options?.security?.ssrf ?? 'block';
    let ssrfChecked = false;
    const maxAttempts = Math.max((options?.retries ?? 2) + 1, 1);
    const context: ScrapeContext = {
      requestId: generateId(),
      traceId: generateId(),
      startTime: new Date(),
      url,
      options: options || defaultOptions,
      attemptCount: 1,
      maxAttempts,
      engine: this.type
    };

    const domain = extractDomain(url) ?? new URL(url).hostname;

    this.logger.info('开始 HTTP 抓取', { url, requestId: context.requestId });

    this.emit('progress', {
      type: 'START',
      context,
      timestamp: new Date(),
      progress: { phase: 'HTTP_REQUEST', percentage: 0, message: t('progress.httpRequestPreparing') }
    } as ScrapeProgressEvent);

    try {
      // --- 不可重试的前置检查 ---
      if (ssrfMode === 'block') {
        const securityCheck = checkURLSecurity(url);
        ssrfChecked = true;
        if (securityCheck.blocked) {
          throw new CrawlError(
            'SSRF_BLOCKED',
            `SSRF protection blocked URL: ${url}`,
            { context: { url, reason: securityCheck.reason, risks: securityCheck.risks } }
          );
        }
      }

      const robotsResult = await this.checkRobots(url, options);
      if (!robotsResult.allowed && options?.security?.robots !== 'ignore') {
        throw new CrawlError(
          'ROBOTS_DISALLOWED',
          `Robots.txt disallows access: ${robotsResult.rule}`,
          { context: { robotsResult } }
        );
      }

      // 熔断器检查
      this.circuitBreaker.checkAllowed(domain);

      const cacheKey = CacheKeyGenerator.generateKey({
        url,
        method: options?.method || 'GET',
        body: options?.body,
        engine: this.type,
        userAgent: options?.userAgent || this.defaultUserAgent,
        proxy: options?.proxy,
        headers: options?.headers,
        strategy: { id: 'http-default', version: this.version }
      });

      const requestConfig = this.buildRequestConfig(url, options);

      // --- RetryExecutor 替代手写重试循环 ---
      const retryExecutor = new RetryExecutor({
        maxAttempts,
        baseDelay: options?.extended?.retry?.retryDelay ?? 1000,
        backoffFactor: options?.extended?.retry?.backoffMultiplier ?? 2,
        retryableErrors: ['TIMEOUT', 'NETWORK', 'RATE_LIMIT'],
        onRetry: (attempt, error, delay) => {
          context.attemptCount = attempt + 1;
          this.logger.warn('HTTP 请求失败，准备重试', {
            url,
            requestId: context.requestId,
            attempt,
            maxAttempts,
            nextRetryDelay: delay,
            error: error.message
          });
        },
        onMaxAttemptsReached: (error) => {
          this.logger.error('HTTP 请求达到最大重试次数', {
            url,
            requestId: context.requestId,
            maxAttempts,
            error: error.message
          });
        }
      });

      const result = await retryExecutor.execute(async () => {
        const response = await this.sendRequest(requestConfig);
        const loadTime = Date.now() - startTime;

        this.updateAverageResponseTime(loadTime);

        const accessResult = await this.buildAccessResult(
          context,
          response,
          loadTime,
          options,
          cacheKey,
          robotsResult,
          generateId(),
          ssrfChecked
        );

        this.logger.info('HTTP 抓取完成', {
          url,
          requestId: context.requestId,
          status: response.status,
          loadTime,
          size: this.getResponseSize(response),
          attempt: context.attemptCount
        });

        return accessResult;
      });

      // 请求成功，重置熔断计数
      this.circuitBreaker.recordSuccess(domain);

      this.emit('progress', {
        type: 'COMPLETE',
        context,
        timestamp: new Date(),
        result,
        progress: { phase: 'COMPLETED', percentage: 100, message: t('progress.completed') }
      } as ScrapeProgressEvent);

      return result;
    } catch (error) {
      // 网络 / 超时类错误记录到熔断器（安全类错误不算域名故障）
      if (
        !(error instanceof CrawlError && (error.code === 'SSRF_BLOCKED' || error.code === 'ROBOTS_DISALLOWED')) &&
        !(error instanceof CircuitBreakerOpenError)
      ) {
        this.circuitBreaker.recordFailure(domain);
      }

      const crawlError = error instanceof CrawlError
        ? error
        : error instanceof CircuitBreakerOpenError
          ? new CrawlError('RATE_LIMIT', error.message, { context: { domain, retryAfterMs: error.retryAfterMs } })
          : this.handleError(error, context);

      this.emit('progress', {
        type: 'ERROR',
        context,
        timestamp: new Date(),
        error: crawlError
      } as ScrapeProgressEvent);

      this.logger.error('HTTP 抓取失败', {
        url,
        requestId: context.requestId,
        error: crawlError.message,
        attempts: context.attemptCount
      });

      throw crawlError;
    }
  }

  /**
   * 检查 robots.txt
   */
  private async checkRobots(url: string, options?: HttpScrapeOptions): Promise<any> {
    const respectRobots = options?.security?.robots || 'obey';
    if (respectRobots === 'ignore') {
      return { allowed: true, source: 'N/A (ignored)', userAgent: '', rule: 'robots.txt ignored' };
    }

    try {
      return await RobotsChecker.checkUrl(url, {
        userAgent: options?.userAgent || this.defaultUserAgent,
        respectRobots,
        timeout: 5000,
        cache: true,
        cacheTtl: 3600
      });
    } catch (error) {
      // robots.txt 检查失败时默认允许，但记录警告以便排查
      this.logger.warn('robots.txt 检查失败，默认允许访问', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return {
        allowed: true,
        source: 'robots.txt check failed',
        userAgent: options?.userAgent || this.defaultUserAgent,
        rule: 'default allow on error',
        details: { fetchError: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
  }

  private buildRequestConfig(url: string, options?: HttpScrapeOptions): AxiosRequestConfig {
    const maxContentLength = options?.limits?.mainPayload ?? DEFAULT_LIMITS.MAIN_PAYLOAD_MAX;

    const config: AxiosRequestConfig = {
      url,
      method: options?.method || 'GET',
      timeout: options?.timeout || this.config.timeout || 30000,
      headers: {
        ...options?.headers
      } as any,
      maxRedirects: 5,
      validateStatus: () => true,
      // H05: 传入 maxContentLength 和 maxBodyLength 给 axios
      maxContentLength,
      maxBodyLength: maxContentLength,
      // H06: 以 arraybuffer 接收原始数据，由 createPayloads 按检测编码解码
      responseType: 'arraybuffer',
    };

    // 处理扩展配置
    if (options?.extended) {
      const processedConfig = ConfigProcessor.processHTTPConfig(options.extended);

      // 合并扩展配置的头部
      if (config.headers && processedConfig.headers) {
        Object.assign(config.headers, processedConfig.headers);
      }

      // 使用扩展配置的 User-Agent
      if (processedConfig.userAgent) {
        config.headers!['User-Agent'] = processedConfig.userAgent;
      }

      // 重试配置由 scrape() 的重试循环处理，此处不再赋值给 maxRedirects

      // 应用压缩配置
      if (options.extended.compression?.enabled) {
        // Accept-Encoding 已在 processedConfig.headers 中处理
      }

      // 应用 HTTP/2 配置
      if (options.extended.http2?.enabled) {
        // Note: Axios doesn't directly support setting HTTP version
        // This would need to be handled at the HTTP client level
        (config as any).httpVersion = '2.0';
      }
    }

    // 设置请求体
    if (options?.body) {
      config.data = options.body;
    }

    // 设置代理
    if (options?.proxy) {
      const proxyProtocol = options.proxy.protocol || 'http';

      if (proxyProtocol === 'socks4' || proxyProtocol === 'socks5') {
        // H04: SOCKS 代理通过 socks-proxy-agent 支持
        const authPart = options.proxy.username
          ? `${encodeURIComponent(options.proxy.username)}:${encodeURIComponent(options.proxy.password || '')}@`
          : '';
        const socksUrl = `${proxyProtocol}://${authPart}${options.proxy.host}:${options.proxy.port}`;
        const agent = new SocksProxyAgent(socksUrl);
        config.httpAgent = agent;
        config.httpsAgent = agent;
        // axios 的 proxy 选项与自定义 agent 冲突，必须禁用
        config.proxy = false;
      } else {
        config.proxy = {
          host: options.proxy.host,
          port: options.proxy.port,
          auth: options.proxy.username ? {
            username: options.proxy.username,
            password: options.proxy.password || ''
          } : undefined,
          protocol: proxyProtocol
        };
      }
    }

    // 设置 User-Agent（如果没有通过扩展配置设置）
    if (options?.userAgent && !options?.extended?.userAgent) {
      config.headers!['User-Agent'] = options.userAgent;
    }

    // 设置默认 User-Agent（如果都没有设置）
    if (!config.headers!['User-Agent']) {
      config.headers!['User-Agent'] = this.defaultUserAgent;
    }

    // 设置 Cookie
    if (options?.cookies && options.cookies.length > 0) {
      const cookieString = options.cookies
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ');
      config.headers!['Cookie'] = cookieString;
    }

    return config;
  }

  private async buildAccessResult(
    context: ScrapeContext,
    response: AxiosResponse,
    loadTime: number,
    options?: HttpScrapeOptions,
    cacheKey?: string,
    robotsResult?: any,
    connectionId?: string,
    ssrfChecked: boolean = false
  ): Promise<AccessResult> {
    // 生成缓存键（如果没有提供）
    const finalCacheKey = cacheKey || CacheKeyGenerator.generateKey({
      url: context.url,
      method: options?.method || 'GET',
      body: options?.body,
      engine: this.type,
      userAgent: options?.userAgent || this.defaultUserAgent,
      proxy: options?.proxy,
      headers: options?.headers,
      strategy: { id: 'http-default', version: this.version }
    });

    // 处理响应数据，创建载荷
    const payloads = await this.createPayloads(response, options);

    // 规范化头部
    const normalizedRequestHeaders = normalizeHeaders(options?.headers || {});
    const normalizedResponseHeaders = normalizeHeaders(response.headers as Record<string, string>);

    // 解析 Cookie
    const cookies = this.parseCookies(response.headers);

    // 隐私脱敏
    const maskingResult = PrivacyMasker.generateMaskingReport(
      normalizedRequestHeaders,
      cookies,
      context.url,
      { maskFields: options?.privacyMask }
    );

    // 创建性能时序
    // 注意：axios 无法提供 TCP/DNS/TLS 等细分时序，
    // 仅 total（端到端耗时）是真实测量值，其余设为 0 表示"未测量"。
    const timing: PerformanceTiming = {
      dns: 0,
      tcp: 0,
      tls: undefined,
      ttfb: 0,
      download: 0,
      total: Math.round(loadTime),

      // 向后兼容
      domainLookup: 0,
      connect: 0,
      secureConnect: undefined,
      request: 0,
      response: 0,

      // 时间戳
      timestamps: {
        start: context.startTime.getTime(),
        responseEnd: context.startTime.getTime() + loadTime
      }
    };

    // 网络请求信息
    // 计算传输大小（确保一致性）
    const transferSize = this.getResponseSize(response);
    const contentLength = this.getContentLength(response);

    const networkRequest: NetworkRequest = {
      id: generateId(),
      url: context.url,
      method: options?.method || 'GET',
      status: response.status,
      requestHeaders: maskingResult.details.headers.masked,
      responseHeaders: normalizedResponseHeaders,
      size: contentLength || transferSize,
      transferSize: transferSize,
      duration: Math.round(loadTime),
      resourceType: 'document',
      connectionId: connectionId || generateId(),
      protocol: this.getProtocol(response),
      remoteIP: this.getServerIp(response),
      remotePort: this.getServerPort(response),
      timing: timing  // 使用相同的时序信息
    };

    const result: AccessResult = {
      id: context.requestId,
      requestId: context.requestId,
      connectionId: connectionId || generateId(),
      cacheKey: finalCacheKey,
      traceId: context.traceId,

      // 引擎信息
      engine: {
        type: 'http',
        name: this.name,
        version: this.version,
        runtime: {
          startTime: new Date(),
          processId: process.pid,
          memoryUsage: process.memoryUsage().heapUsed,
        },
          config: {
            http: {
              followRedirects: true,
              maxRedirects: 10,
              keepAlive: true,
              timeout: options?.timeout || 30000,
              maxConcurrency: this.capabilities.maxConcurrency,
              proxyEnabled: !!options?.proxy,
              cookiesEnabled: true,

              // 扩展配置信息
              extended: options?.extended ? {
                userAgentType: options.extended.userAgent?.preset || 'custom',
                deviceType: options.extended.userAgent?.device?.type || 'desktop',
                geolocationEnabled: !!options.extended.geolocation,
                geolocationCountry: options.extended.geolocation?.country,
                privacyMode: !!options.extended.privacy?.incognito,
                compressionEnabled: !!options.extended.compression?.enabled,
                http2Enabled: !!options.extended.http2?.enabled
              } : undefined
            }
          },
        capabilities: {
          supportsJavaScript: this.capabilities.supportsJavaScript,
          supportsScreenshots: this.capabilities.supportsScreenshots,
          supportsCookies: this.capabilities.supportsCookies,
          supportsProxy: this.capabilities.supportsProxy,
          supportsUserInteraction: this.capabilities.supportsUserInteraction,
          supportsNetworkCapture: this.capabilities.supportsNetworkCapture,
          maxConcurrency: this.capabilities.maxConcurrency,
          resourceUsage: this.capabilities.resourceUsage
        }
      },

      request: {
        url: context.url,
        method: options?.method || 'GET',
        headers: maskingResult.details.headers.masked,
        timestamp: context.startTime,
        userAgent: options?.userAgent || this.defaultUserAgent,
        body: options?.body,

        // 网络层详细信息
        httpVersion: this.getHttpVersion(response),
        serverIp: this.getServerIp(response),
        clientIp: this.getClientIp(),
        ...(this.getTlsInfo(response) && { tls: this.getTlsInfo(response) })
      },

      response: {
        statusCode: response.status,
        statusText: response.statusText,
        headers: normalizedResponseHeaders,
        cookies: maskingResult.details.cookies.masked,
        redirectChain: this.getRedirectChain(response),
        finalUrl: response.request?.responseURL || context.url,
        loadTime: Math.round(loadTime),

        // 大小信息
        contentLength: contentLength,
        transferSize: transferSize,

        // HTTP 缓存提示（使用规范化后的头部值）
        cacheHints: {
          etag: normalizedResponseHeaders.etag,
          lastModified: normalizedResponseHeaders['last-modified'],
          cacheControl: normalizedResponseHeaders['cache-control'],
          age: normalizedResponseHeaders.age ? parseInt(normalizedResponseHeaders.age, 10) : undefined,
          expires: normalizedResponseHeaders.expires,
          vary: normalizedResponseHeaders.vary
        }
      },

      // 统一的载荷数组
      payloads,

      network: {
        requests: [networkRequest],
        resources: [{
          url: context.url,
          type: 'document',
          size: this.getResponseSize(response),
          cached: false
        }],
        timing
      },

      fromCache: false,
      cacheable: CacheKeyGenerator.isCacheable({
        url: context.url,
        method: options?.method || 'GET',
        body: options?.body,
        engine: this.type,
        userAgent: options?.userAgent || this.defaultUserAgent,
        headers: options?.headers
      }),

      security: {
        robotsAllowed: robotsResult?.allowed ?? true,
        robotsDetails: robotsResult ? {
          allowed: robotsResult.allowed,
          source: robotsResult.source,
          userAgent: robotsResult.userAgent,
          rule: robotsResult.rule,
          crawlDelay: robotsResult.crawlDelay
        } : undefined,
        ssrfChecked,
        privacyMasked: maskingResult.maskedFieldsList,
        usesTLS: context.url.startsWith('https:')  // 根据最终 URL 判断是否使用 TLS
      },

      // 错误信息（即使成功也保留空数组）
      errors: []
    };

    return result;
  }

  /**
   * 创建载荷数组（支持多个载荷并存）
   * H06: 响应以 arraybuffer 接收，按检测到的编码解码文本内容
   */
  private async createPayloads(response: AxiosResponse, options?: HttpScrapeOptions): Promise<Payload[]> {
    const memCheck = sizeLimitManager.checkMemory();
    if (memCheck.critical) {
      this.logger.warn('内存使用率超过 90%，处理大响应时可能 OOM', {
        usage: memCheck.usage,
        limit: memCheck.limit,
        percentage: memCheck.percentage.toFixed(1)
      });
    }

    const contentType = response.headers['content-type'] || 'application/octet-stream';
    const payloads: Payload[] = [];
    const mainPayloadLimit = options?.limits?.mainPayload;

    // 将响应数据统一为 Buffer（因为 responseType: 'arraybuffer'）
    const rawBuffer: Buffer = Buffer.isBuffer(response.data)
      ? response.data
      : (response.data instanceof ArrayBuffer
          ? Buffer.from(response.data)
          : Buffer.from(response.data ?? ''));

    const isTextContent = contentType.includes('text/html') ||
                          contentType.includes('application/xhtml') ||
                          contentType.includes('application/json') ||
                          contentType.startsWith('text/');

    if (isTextContent) {
      // H06: 统一使用 safeDecodeBuffer 进行编码检测和解码（支持 GBK/Shift_JIS/Big5 等）
      const responseHeaders = response.headers as Record<string, string>;
      const { content: decodedText, encoding } = safeDecodeBuffer(rawBuffer, undefined, responseHeaders);

      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        const htmlPayload = PayloadUtils.createHtmlPayload(
          decodedText,
          encoding,
          { primary: true, limit: mainPayloadLimit }
        );
        payloads.push(htmlPayload);
      } else if (contentType.includes('application/json')) {
        try {
          const jsonData = JSON.parse(decodedText);
          const jsonPayload = PayloadUtils.createJsonPayload(
            jsonData,
            { primary: true, limit: mainPayloadLimit }
          );
          payloads.push(jsonPayload);
        } catch {
          const textPayload = PayloadUtils.createTextPayload(
            decodedText, contentType, encoding,
            { primary: true, limit: mainPayloadLimit }
          );
          payloads.push(textPayload);
        }
      } else {
        const textPayload = PayloadUtils.createTextPayload(
          decodedText,
          contentType,
          encoding,
          { primary: true, limit: mainPayloadLimit }
        );
        payloads.push(textPayload);
      }
    } else {
      const binaryPayload = PayloadUtils.createBinaryPayload(
        rawBuffer,
        contentType,
        { limit: mainPayloadLimit }
      );
      binaryPayload.primary = true;
      payloads.push(binaryPayload);
    }

    // 如果启用了 keepRawBody，添加原始二进制载荷
    if (options?.keepRawBody && rawBuffer.length > 0) {
      try {
        const rawPayload = PayloadUtils.createBinaryPayload(
          rawBuffer,
          'application/octet-stream',
          { limit: mainPayloadLimit }
        );
        rawPayload.source = 'raw-response-body';
        payloads.push(rawPayload);
      } catch (error) {
        // 如果无法创建原始载荷，记录但不影响主流程
        this.logger.warn('Failed to create raw body payload:', error);
      }
    }

    return payloads;
  }

  /**
   * 获取 HTTP 版本
   */
  private getHttpVersion(response: AxiosResponse): string | undefined {
    // 尝试从多个来源获取 HTTP 版本
    const request = response.request;

    // 1. 从 request 对象获取
    if (request?.httpVersion) {
      return `HTTP/${request.httpVersion}`;
    }

    // 2. 从 socket 获取（Node.js）
    if (request?.socket?.httpVersion) {
      return `HTTP/${request.socket.httpVersion}`;
    }

    // 3. 从响应头推断（HTTP/2 通常有特定头部）
    const headers = response.headers;
    if (headers[':status'] || headers['x-http2-stream-id']) {
      return 'HTTP/2';
    }

    // 4. 默认情况下不返回版本信息（避免猜测）
    return undefined;
  }

  /**
   * 获取服务器 IP
   * H08: 仅从 TCP socket 获取远端地址，不使用 X-Forwarded-For / X-Real-IP
   *      因为这些头部表示的是客户端 IP（反向代理场景），不是服务器 IP
   */
  private getServerIp(response: AxiosResponse): string | undefined {
    const socket = response.request?.socket;

    // 1. 从 socket 获取远端地址（TCP 连接的真实服务器 IP）
    if (socket?.remoteAddress) {
      return socket.remoteAddress;
    }

    // 2. 从 socket 的连接信息获取
    if (socket?.address && typeof socket.address === 'function') {
      try {
        const addr = socket.address();
        if (addr && typeof addr === 'object' && 'address' in addr) {
          return addr.address;
        }
      } catch {
        // 忽略错误
      }
    }

    // 3. 无法获取时返回 undefined，不依赖 HTTP 头部
    return undefined;
  }

  /**
   * 获取客户端 IP（请求方 IP）
   * 注意：HTTP 客户端无法直接获取自己的公网 IP，只能获取本地 IP
   */
  private getClientIp(): string | undefined {
    try {
      // HTTP 客户端运行在本地，无法直接获取公网 IP
      // 在实际部署中，这个信息通常由反向代理或负载均衡器提供
      const networkInterfaces = os.networkInterfaces();

      // 查找非回环的 IPv4 地址
      for (const interfaceName in networkInterfaces) {
        const addresses = networkInterfaces[interfaceName];
        if (addresses) {
          for (const addr of addresses) {
            if (addr.family === 'IPv4' && !addr.internal) {
              return addr.address;
            }
          }
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 获取服务器端口
   */
  private getServerPort(response: AxiosResponse): number | undefined {
    const socket = response.request?.socket;
    if (socket?.remotePort) {
      return socket.remotePort;
    }

    // 从 URL 推断默认端口
    const url = new URL(response.request?.responseURL || response.config?.url || '');
    if (url.port) {
      return parseInt(url.port, 10);
    }

    // 默认端口
    if (url.protocol === 'https:') {
      return 443;
    } else if (url.protocol === 'http:') {
      return 80;
    }

    return undefined;
  }

  /**
   * 获取协议版本（简化版本，用于 network.requests）
   */
  private getProtocol(response: AxiosResponse): string | undefined {
    const httpVersion = this.getHttpVersion(response);
    if (httpVersion === 'HTTP/2') {
      return 'h2';
    } else if (httpVersion?.startsWith('HTTP/1.1')) {
      return 'http/1.1';
    } else if (httpVersion?.startsWith('HTTP/1.0')) {
      return 'http/1.0';
    }

    return undefined;
  }

  /**
   * 获取 TLS 信息
   */
  private getTlsInfo(response: AxiosResponse): any {
    if (!response.request?.protocol?.startsWith('https:')) {
      return undefined;
    }

    // axios 不直接提供 TLS 信息，可能需要从 socket 获取
    const socket = response.request?.socket;
    if (socket && 'getPeerCertificate' in socket) {
      try {
        const cert = (socket as any).getPeerCertificate();
        const protocol = (socket as any).getProtocol?.();
        const cipher = (socket as any).getCipher?.();

        const tlsInfo: any = {};

        // 只有在有实际数据时才添加字段
        if (protocol) {
          tlsInfo.protocol = protocol;
        }

        if (cipher?.name) {
          tlsInfo.cipherSuite = cipher.name;
        }

        if (cert && cert.subject) {
          tlsInfo.serverCertificate = {
            subject: cert.subject?.CN || 'Unknown',
            issuer: cert.issuer?.CN || 'Unknown',
            validFrom: new Date(cert.valid_from),
            validTo: new Date(cert.valid_to),
            fingerprint: cert.fingerprint
          };
        }

        return Object.keys(tlsInfo).length > 0 ? tlsInfo : undefined;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  /**
   * 获取内容长度
   */
  private getContentLength(response: AxiosResponse): number | undefined {
    const contentLength = response.headers['content-length'];
    return contentLength ? parseInt(contentLength, 10) : undefined;
  }



  private parseCookies(headers: Record<string, any>): Cookie[] {
    const setCookieHeader = headers['set-cookie'];
    if (!setCookieHeader) return [];

    const cookies: Cookie[] = [];
    const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    for (const cookieString of cookieStrings) {
      const cookie = this.parseSingleCookie(cookieString);
      if (cookie) {
        cookies.push(cookie);
      }
    }

    return cookies;
  }

  private parseSingleCookie(cookieString: string): Cookie | null {
    const parts = cookieString.split(';').map(part => part.trim());
    if (parts.length === 0) return null;

    const [nameValue] = parts;
    const [name, value] = nameValue.split('=');
    if (!name || value === undefined) return null;

    const cookie: Cookie = {
      name: name.trim(),
      value: value.trim(),
      domain: '',
      path: '/'
    };

    // 解析其他属性
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const [key, val] = part.split('=');
      const lowerKey = key.toLowerCase();

      switch (lowerKey) {
        case 'domain':
          cookie.domain = val || '';
          break;
        case 'path':
          cookie.path = val || '/';
          break;
        case 'expires':
          cookie.expires = val ? new Date(val) : undefined;
          break;
        case 'httponly':
          cookie.httpOnly = true;
          break;
        case 'secure':
          cookie.secure = true;
          break;
        case 'samesite':
          cookie.sameSite = val as 'Strict' | 'Lax' | 'None';
          break;
      }
    }

    return cookie;
  }

  private getRedirectChain(response: AxiosResponse): Array<string | { url: string; status: number; scheme: string }> {
    const redirectChain: Array<string | { url: string; status: number; scheme: string }> = [];

    // 检查是否有重定向（通过比较请求 URL 和响应 URL）
    const originalUrl = response.config?.url;
    const finalUrl = response.request?.responseURL;

    if (originalUrl && finalUrl && originalUrl !== finalUrl) {
      try {
        const originalParsedUrl = new URL(originalUrl);
        const finalParsedUrl = new URL(finalUrl);

        // 添加原始 URL 到重定向链
        redirectChain.push({
          url: originalUrl,
          status: 301, // 假设是永久重定向
          scheme: originalParsedUrl.protocol.replace(':', '')
        });

        // 如果 scheme 发生变化，特别标记
        if (originalParsedUrl.protocol !== finalParsedUrl.protocol) {
          const isUpgrade = originalParsedUrl.protocol === 'http:' && finalParsedUrl.protocol === 'https:';
          redirectChain.push({
            url: finalUrl,
            status: isUpgrade ? 301 : 302, // HTTPS 升级通常是 301
            scheme: finalParsedUrl.protocol.replace(':', '')
          });
        }
      } catch {
        // 解析失败时添加简单字符串
        redirectChain.push(originalUrl);
        if (finalUrl !== originalUrl) {
          redirectChain.push(finalUrl);
        }
      }
    }

    return redirectChain;
  }



  private updateAverageResponseTime(responseTime: number): void {
    const totalTime = this.metrics.averageResponseTime * (this.metrics.totalRequests - 1);
    this.metrics.averageResponseTime = (totalTime + responseTime) / this.metrics.totalRequests;
  }

  private handleError(error: any, context: ScrapeContext): CrawlError {
    if (error.code === 'ECONNABORTED') {
      return new CrawlError('TIMEOUT', t('errors.http.timeout'), {
        engine: this.type,
        url: context.url,
        originalError: error.message
      });
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return new CrawlError('NETWORK', t('errors.http.networkFailed'), {
        engine: this.type,
        url: context.url,
        originalError: error.code
      });
    } else if (error.response) {
      return new CrawlError('HTTP_ERROR', t('errors.http.status', { status: error.response.status }), {
        engine: this.type,
        url: context.url,
        statusCode: error.response.status,
        originalError: error.response.statusText
      });
    } else {
      return new CrawlError('UNKNOWN', t('errors.http.unknownWithMessage', { message: error.message }), {
        engine: this.type,
        url: context.url,
        originalError: error.message
      });
    }
  }

  public async cleanup(): Promise<void> {
    this.logger.debug('清理 HTTP 引擎资源');
    // HTTP 引擎没有需要特别清理的资源
  }

  public async updateConfig(config: Partial<EngineInitOptions>): Promise<void> {
    this.config = { ...this.config, ...config };

    if (config.timeout) {
      this.httpClient.updateConfig({ timeout: config.timeout });
    }

    if (config.maxConcurrency) {
      this.capabilities.maxConcurrency = config.maxConcurrency;
      this.metrics.maxConcurrency = config.maxConcurrency;
    }

    this.logger.debug('HTTP 引擎配置已更新', config);
  }

  public getConfig(): EngineInitOptions {
    return { ...this.config };
  }

  public async diagnose(): Promise<{
    issues: string[];
    suggestions: string[];
    systemInfo: Record<string, any>;
  }> {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // 检查并发数
    if (this.metrics.currentConcurrency >= this.capabilities.maxConcurrency) {
      issues.push(t('diagnose.issues.maxConcurrency'));
      suggestions.push(t('diagnose.suggestions.maxConcurrency'));
    }

    // 检查错误率
    const errorRate = this.metrics.totalRequests > 0 ?
      this.metrics.failedRequests / this.metrics.totalRequests : 0;

    if (errorRate > 0.1) {
      issues.push(t('diagnose.issues.highErrorRate', { rate: (errorRate * 100).toFixed(1) }));
      suggestions.push(t('diagnose.suggestions.checkNetwork'));
    }

    return {
      issues,
      suggestions,
      systemInfo: {
        engine: this.name,
        version: this.version,
        status: this.status,
        metrics: this.metrics,
        capabilities: this.capabilities,
        nodeVersion: process.version,
        platform: process.platform
      }
    };
  }

  // 事件监听方法
  public override on(event: 'progress' | 'error' | 'complete', listener: EngineEventListener): this {
    super.on(event, listener);
    return this;
  }

  public override off(event: 'progress' | 'error' | 'complete', listener: EngineEventListener): this {
    super.off(event, listener);
    return this;
  }
}

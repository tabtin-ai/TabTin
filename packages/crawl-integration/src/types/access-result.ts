/**
 * AccessResult - 统一的抓取结果格式
 * 基于 ScrapePRD.md 中的 AccessResult 接口设计
 */

// 统一的 Payload 类型（支持多个载荷并存）
export type Payload =
  | { type: 'html';     contentType: 'text/html'; encoding: string; data: string; truncated?: boolean; size: number; checksum: string; primary?: boolean; source?: string }
  | { type: 'json';     contentType: 'application/json'; data: unknown; size: number; checksum: string; truncated?: boolean; primary?: boolean; source?: string }
  | { type: 'text';     contentType: string; encoding: string; data: string; truncated?: boolean; size: number; checksum: string; primary?: boolean; source?: string }
  | { type: 'binary';   contentType: string; data: Buffer; size: number; checksum: string; truncated?: boolean; primary?: boolean; source?: string }
  | { type: 'xml';      contentType: 'application/xml' | 'text/xml'; encoding: string; data: string; size: number; checksum: string; truncated?: boolean; primary?: boolean; source?: string }
  | { type: 'css';      contentType: 'text/css'; encoding: string; data: string; size: number; checksum: string; primary?: boolean; source?: string; truncated?: boolean }
  | { type: 'js';       contentType: 'application/javascript' | 'text/javascript'; encoding: string; data: string; size: number; checksum: string; primary?: boolean; source?: string; truncated?: boolean }
  | { type: 'xhr_json'; contentType: 'application/json'; data: unknown; size: number; checksum: string; primary?: boolean; source: string; truncated?: boolean }
  | { type: 'image';    contentType: string; data: Buffer; size: number; checksum: string; primary?: boolean; source: string; truncated?: boolean };

// 向后兼容的类型别名
export type MainPayload = Payload & { primary: true };
export type SamplePayload = Payload & { primary?: false | undefined };

// Cookie 接口
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// 网络请求信息
export interface NetworkRequest {
  id: string;                                    // 请求唯一标识
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  size: number;
  transferSize?: number;                         // 传输层大小（包含压缩）
  duration: number;
  resourceType: string;
  connectionId?: string;                         // 连接标识，用于关联
  protocol?: string;                             // 协议版本（如 "h2", "http/1.1"）
  remoteIP?: string;                             // 服务器 IP 地址
  remotePort?: number;                           // 服务器端口
  timing?: PerformanceTiming;                    // 详细时序信息
  error?: {                                      // 请求级别错误
    code: string;
    message: string;
    timestamp: Date;
  };
}

// 资源信息
export interface Resource {
  url: string;
  type: 'document' | 'stylesheet' | 'image' | 'script' | 'xhr' | 'other';
  size: number;
  cached: boolean;
}

// 性能时序（毫秒整数，对齐 Node/Undici）
export interface PerformanceTiming {
  // 核心时序（毫秒）
  dns: number;                    // DNS 解析时间
  tcp: number;                    // TCP 连接时间
  tls?: number;                   // TLS 握手时间
  ttfb: number;                   // 首字节时间 (Time To First Byte)
  download: number;               // 下载时间
  total: number;                  // 总时间

  // 向后兼容的字段
  domainLookup: number;           // = dns
  connect: number;                // = tcp
  secureConnect?: number;         // = tls
  request: number;                // = ttfb - tcp - tls
  response: number;               // = download

  // 浏览器特有时序（可选）
  domContentLoaded?: number;
  loadComplete?: number;

  // 详细时间戳（Unix 毫秒）
  timestamps?: {
    start: number;
    dnsStart?: number;
    dnsEnd?: number;
    connectStart?: number;
    connectEnd?: number;
    tlsStart?: number;
    tlsEnd?: number;
    requestStart?: number;
    responseStart?: number;
    responseEnd?: number;
  };
}

// 截图数据
export interface Screenshot {
  type: 'fullPage' | 'viewport' | 'element';
  selector?: string;  // 元素截图时的选择器
  data: Buffer;
  width: number;
  height: number;
}

// 错误信息
export interface AccessError {
  code: 'TIMEOUT' | 'NETWORK' | 'PARSE' | 'UNSUPPORTED' | 'AUTH' | 'RATE_LIMIT' | 'CAPTCHA';
  message: string;
  timestamp: Date;

  // 错误分类（指导重试策略）
  category: 'RETRYABLE' | 'ENGINE_SWITCH' | 'HUMAN_CHECK' | 'FATAL';

  // 人机验证类型
  humanCheck?: 'captcha' | 'mfa' | 'login_required' | null;

  // 错误提示
  hints?: string[];  // 如 ['ssrf_blocked', 'robots_disallowed']

  // 引擎相关
  engine?: string;

  // 技术细节
  details?: {
    statusCode?: number;
    originalError?: string;
    stack?: string;
  };
}

// 引擎信息
export interface EngineInfo {
  type: 'http' | 'webcontents';  // 引擎类型（只实现了 http 和 webcontents）
  name: string;                  // 引擎名称
  version: string;               // 引擎版本

  // 引擎运行时信息
  runtime?: {
    startTime: Date;                    // 引擎启动时间
    processId?: number;                 // 进程 ID（如果可用）
    memoryUsage?: number;               // 内存使用量（字节）
    cpuUsage?: number;                  // CPU 使用率（百分比）
  };

  // 引擎特定配置
  config?: {
    // HTTP 引擎配置
    http?: {
      followRedirects?: boolean;
      maxRedirects?: number;
      keepAlive?: boolean;
      timeout?: number;
      maxConcurrency?: number;
      proxyEnabled?: boolean;
      cookiesEnabled?: boolean;

      // 扩展配置信息
      extended?: {
        userAgentType?: string;
        deviceType?: string;
        geolocationEnabled?: boolean;
        geolocationCountry?: string;
        privacyMode?: boolean;
        compressionEnabled?: boolean;
        http2Enabled?: boolean;
      };
    };

    // WebContents 引擎配置
    webcontents?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
      timeout?: number;
      waitForDynamic?: boolean;
      dynamicWaitTime?: number;
      screenshot?: boolean | {
        type?: 'png' | 'jpeg';
        quality?: number;
        fullPage?: boolean;
      };
      captureRequests?: boolean;
      captureResponses?: boolean;
      captureConsole?: boolean;
      captureCookies?: boolean;
      capturePerformance?: boolean;
      openInNewWindow?: boolean;
      keepEngineAlive?: boolean;
      reuseViewId?: string;
      useEmbeddedTab?: boolean;
      showTab?: boolean;
    };
  };

  // 引擎能力信息
  capabilities?: {
    supportsJavaScript?: boolean;
    supportsScreenshots?: boolean;
    supportsCookies?: boolean;
    supportsProxy?: boolean;
    supportsUserInteraction?: boolean;
    supportsNetworkCapture?: boolean;
    maxConcurrency?: number;
    resourceUsage?: 'LOW' | 'MEDIUM' | 'HIGH';
  };
}

// 主要的 AccessResult 接口
export interface AccessResult {
  // 基础信息
  id: string;                          // 请求唯一标识
  requestId: string;                   // 与 network.requests[0] 对齐的请求ID
  connectionId?: string;               // 连接标识
  cacheKey: string;                    // SHA256 规范化缓存键
  traceId: string;

  // 引擎信息
  engine: EngineInfo;                  // 使用的引擎信息

  // 请求信息
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;   // 已脱敏的请求头
    timestamp: Date;
    userAgent: string;
    body?: string | Buffer;

    // 网络层详细信息
    httpVersion?: string;              // HTTP/1.1, HTTP/2, HTTP/3
    clientIp?: string;                 // 客户端 IP（请求方 IP）
    serverIp?: string;                 // 服务器 IP（目标服务器 IP）
    tls?: {                           // TLS 连接信息
      protocol?: string;               // TLSv1.2, TLSv1.3
      cipherSuite?: string;           // 加密套件
      serverCertificate?: {
        subject: string;
        issuer: string;
        validFrom: Date;
        validTo: Date;
        fingerprint: string;
      };
    };
  };

  // 响应信息
  response: {
    statusCode: number;
    statusText: string;
    headers: Record<string, string>;   // 已脱敏的响应头
    cookies: Cookie[];
    redirectChain: Array<string | {    // 重定向链（支持详细信息）
      url: string;
      status: number;
      scheme: string;
    }>;
    finalUrl: string;
    loadTime: number;

    // 大小信息
    contentLength?: number;            // Content-Length 头指定的大小
    transferSize?: number;             // 实际传输大小（包含压缩）

    // HTTP 缓存提示（用于条件请求）
    cacheHints?: {
      etag?: string;
      lastModified?: string;
      cacheControl?: string;
      age?: number;                    // 缓存年龄（秒）
      expires?: string;
      vary?: string;
    };
  };

  // 载荷数据（支持多个载荷并存）
  payloads: Payload[];                 // 统一的载荷数组，primary: true 标记主载荷

  // 网络信息（采样限制，默认最多 200 条）
  network?: {
    requests: NetworkRequest[];        // 网络请求（采样）
    resources: Resource[];             // 加载的资源
    timing: PerformanceTiming;         // 性能时序
    truncated?: boolean;               // 是否因采样限制被截断
  };

  // 截图数据
  screenshots?: Screenshot[];

  // 缓存信息
  fromCache: boolean;
  cacheable: boolean;                  // 是否可缓存（基于敏感信息判断）

  // 安全与合规
  security: {
    robotsAllowed: boolean;
    robotsDetails?: {                  // robots.txt 判定详情
      allowed: boolean;
      source: string | null;           // robots.txt URL，null 表示没有 robots.txt
      userAgent: string;               // 匹配的 User-Agent
      rule: string;                    // 匹配的规则
      crawlDelay?: number;             // 建议的抓取延迟（秒）
    };
    ssrfChecked: boolean;
    privacyMasked: string[];           // 已脱敏的字段列表
    usesTLS: boolean;                  // 是否使用 TLS/HTTPS
  };

  // 错误信息（即使成功也保留空数组）
  errors: AccessError[];

  /**
   * 引擎上下文信息（在 keepEngineAlive 场景下保留用于后续交互）
   */
  engineContext?: {
    windowId?: string;
    connectionId?: string;
    url?: string;
    [key: string]: unknown;
  } | null;
}

// 默认大小限制常量
export const DEFAULT_LIMITS = {
  MAIN_PAYLOAD_MAX: 5 * 1024 * 1024,    // 5MB
  SAMPLE_PAYLOAD_MAX: 128 * 1024,       // 128KB
  NETWORK_SAMPLES_MAX: 200              // 最多 200 条网络请求
} as const;

// 错误分类映射
export const ERROR_CATEGORIES = {
  'TIMEOUT': 'RETRYABLE',
  'NETWORK': 'RETRYABLE',
  'RATE_LIMIT': 'RETRYABLE',
  'PARSE': 'ENGINE_SWITCH',
  'CAPTCHA': 'HUMAN_CHECK',
  'AUTH': 'HUMAN_CHECK',
  'UNSUPPORTED': 'FATAL'
} as const;

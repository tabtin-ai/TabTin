/**
 * 抓取选项类型定义
 * 基于 ScrapePRD.md 中的选项模型设计
 */

// 代理配置
export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  /**
   * 代理协议。
   *
   * **注意**：`socks4` / `socks5` 当前在 Electron session.setProxy() 中**不受支持**，
   * 传入后会在运行时产生警告并回退到直连。保留这两个枚举值是为未来原生 SOCKS 支持预留。
   * 如需 SOCKS 代理，请在外部将其转换为 HTTP(S) 代理后再传入。
   */
  protocol?: 'http' | 'https' | 'socks4' | 'socks5';
}

// 渲染提示（影响缓存键）
export interface RenderHints {
  waitFor?: 'networkidle' | 'domcontentloaded' | 'selector';
  selector?: string;
  timeout?: number;
}

// 浏览器配置
export interface BrowserConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
}

// 缓存配置
export interface CacheConfig {
  enabled?: boolean;
  allowSensitive?: boolean;  // 是否缓存包含敏感信息的请求
  ttl?: number;
}

// 安全配置
export interface SecurityConfig {
  ssrf?: 'block' | 'allow';
  robots?: 'obey' | 'ignore' | 'dryrun';  // 默认 'obey'
}

// 大小限制配置
export interface LimitsConfig {
  mainPayload?: number;    // 主载荷大小限制，默认 5MB
  samplePayload?: number;  // 样本载荷大小限制，默认 128KB
  networkSamples?: number; // 网络请求采样数量，默认 200
}

// 公共基础选项
export interface CommonScrapeOptions {
  // 基础配置
  timeout?: number;
  retries?: number;
  userAgent?: string;
  headers?: Record<string, string>;

  // 网络监控（默认 'headers'，避免海量数据）
  networkCapture?: 'none' | 'headers' | 'requests' | 'full';

  // 隐私脱敏
  privacyMask?: string[];

  // 原始数据保留
  keepRawBody?: boolean;           // 是否保留原始二进制响应体（用于极端追溯）

  // 缓存配置
  cache?: CacheConfig;

  // 安全配置
  security?: SecurityConfig;

  // 大小限制（防止内存溢出）
  limits?: LimitsConfig;
}

// HTTP 引擎特有选项
export interface HttpScrapeOptions extends CommonScrapeOptions {
  engine: 'http';

  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: string | Buffer;
  proxy?: ProxyConfig;
  cookies?: import('./access-result').Cookie[];

  // HTTP 特定配置
  followRedirects?: boolean;
  maxRedirects?: number;
  keepAlive?: boolean;
  compression?: boolean;

  // 高级配置
  httpVersion?: '1.1' | '2' | 'auto';
  customHeaders?: Record<string, string>;

  // 认证配置
  auth?: {
    type: 'basic' | 'bearer' | 'digest';
    username?: string;
    password?: string;
    token?: string;
  };

  // 扩展配置
  extended?: import('../config/extended-options').ExtendedHTTPConfig;
}

// 交互动作类型（暂时简单定义，interact 模块会详细实现）
export interface Action {
  type: 'click' | 'type' | 'scroll' | 'wait';
  selector?: string;
  value?: string;
  timeout?: number;
}

// 统一的 ScrapeOptions 类型
export interface WebContentsScrapeOptions extends CommonScrapeOptions {
  engine: 'webcontents';
  /**
   * 代理配置（Electron 会在 session 层设置）
   */
  proxy?: ProxyConfig;
  /**
   * 预设 Cookie（导航前注入）
   */
  cookies?: import('./access-result').Cookie[];
  /**
   * Session 分区（Electron）
   */
  partition?: string;
  /**
   * Session 模式：inherit（共享）、isolated（隔离持久化）、temporary（临时）
   */
  sessionMode?: 'inherit' | 'isolated' | 'temporary';
  /**
   * 是否在嵌入式标签页中打开页面（Electron 专属）
   */
  useEmbeddedTab?: boolean;
  /**
   * 嵌入式标签页是否需要在 UI 中显示
   */
  showTab?: boolean;
  /**
   * 复用已有的 WebContentsView ID（避免重复创建）
   */
  reuseViewId?: string;
  /**
   * 显式指定创建的 WebContentsView ID
   */
  viewId?: string;
  /**
   * 关联的 runId（用于 Session/事件归集）
   */
  runId?: string;
  /**
   * 当复用 View 时，是否保持引擎存活
   */
  keepEngineAlive?: boolean;
  /**
   * 保持引擎存活的时长（毫秒）
   */
  keepAliveDuration?: number;
  /**
   * 是否在新窗口中打开页面
   */
  openInNewWindow?: boolean;
  /**
   * 🆕 是否在任务完成后自动销毁 View
   * - true: 自动销毁（默认行为，适用于后台任务）
   * - false: 保留 View，由调用方管理生命周期（适用于用户可见的工作区标签）
   * - undefined: 根据 keepEngineAlive 和其他配置自动判断（向后兼容）
   */
  autoDestroy?: boolean;
  /**
   * 页面加载结束条件
   */
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
  /**
   * 是否等待页面动态渲染
   */
  waitForDynamic?: boolean;
  /**
   * 动态渲染等待时间（毫秒）
   */
  dynamicWaitTime?: number;
  /**
   * 是否捕获截图（支持布尔或详细配置）
   */
  screenshot?:
    | boolean
    | {
        type?: 'png' | 'jpeg';
        quality?: number;
        fullPage?: boolean;
      };
  /**
   * 是否捕获网络请求
   */
  captureRequests?: boolean;
  /**
   * 是否捕获网络响应体
   */
  captureResponses?: boolean;
  /**
   * 是否捕获控制台输出
   */
  captureConsole?: boolean;
  /**
   * 是否捕获 Cookie
   */
  captureCookies?: boolean;
  /**
   * 是否捕获性能指标
   */
  capturePerformance?: boolean;
}

// 统一的 ScrapeOptions 类型
export type ScrapeOptions =
  | HttpScrapeOptions
  | WebContentsScrapeOptions;

// 引擎类型（仅保留 http / webcontents，CDP/Playwright 已废弃）
export type EngineType = 'http' | 'webcontents';

// 任务优先级
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

// 任务状态
export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

// 网络捕获级别
export type NetworkCaptureLevel = 'none' | 'headers' | 'requests' | 'full';

// 等待策略
export type WaitStrategy = 'networkidle' | 'domcontentloaded' | 'selector';

// 引擎选择策略
export interface EngineSelectionStrategy {
  preferred: EngineType;
  fallbacks: EngineType[];
  conditions?: {
    urlPatterns?: string[];
    domainPatterns?: string[];
    contentTypes?: string[];
  };
}

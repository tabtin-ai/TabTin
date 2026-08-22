/**
 * 扩展的抓取配置选项
 * 包含 UA 配置、移动端配置、地理位置信息等
 */

// 设备类型
export type DeviceType = 'desktop' | 'mobile' | 'tablet';

// 操作系统类型
export type OSType = 'windows' | 'macos' | 'linux' | 'ios' | 'android';

// 浏览器类型
export type BrowserType = 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera';

// 地理位置信息
export interface GeolocationConfig {
  latitude: number;
  longitude: number;
  accuracy?: number;
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

// User-Agent 配置
export interface UserAgentConfig {
  // 预设类型
  preset?: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'custom' | 'system';

  // 设备信息
  device?: {
    type: DeviceType;
    os: OSType;
    osVersion?: string;
    browser: BrowserType;
    browserVersion?: string;
    model?: string; // 设备型号，如 'iPhone 14 Pro'
  };

  // 自定义 User-Agent 字符串
  custom?: string;

  // 是否随机化
  randomize?: boolean;

  // 随机化选项
  randomizeOptions?: {
    deviceTypes?: DeviceType[];
    browsers?: BrowserType[];
    versionRange?: {
      min: string;
      max: string;
    };
  };
}

// 移动端配置
export interface MobileConfig {
  // 设备模拟
  deviceEmulation?: {
    enabled: boolean;
    deviceName?: string; // 预设设备名称，如 'iPhone 14 Pro'
    viewport?: {
      width: number;
      height: number;
      deviceScaleFactor: number;
      isMobile: boolean;
      hasTouch: boolean;
      isLandscape?: boolean;
    };
    userAgent?: string;
  };

  // 触摸事件
  touchEvents?: {
    enabled: boolean;
    maxTouchPoints?: number;
  };

  // 网络条件模拟
  networkConditions?: {
    enabled: boolean;
    preset?: 'slow-3g' | 'fast-3g' | '4g' | '5g' | 'wifi' | 'custom';
    downloadThroughput?: number; // Kbps
    uploadThroughput?: number;   // Kbps
    latency?: number;            // ms
  };

  // 电池状态模拟
  batteryStatus?: {
    enabled: boolean;
    level?: number;     // 0-1
    charging?: boolean;
    chargingTime?: number;
    dischargingTime?: number;
  };
}

// 隐私和安全配置
export interface PrivacyConfig {
  // Do Not Track
  doNotTrack?: boolean;

  // 隐身模式
  incognito?: boolean;

  // 禁用 WebRTC
  disableWebRTC?: boolean;

  // 禁用 WebGL
  disableWebGL?: boolean;

  // 禁用插件
  disablePlugins?: boolean;

  // Canvas 指纹保护
  canvasFingerprinting?: {
    enabled: boolean;
    mode?: 'block' | 'randomize' | 'fake';
  };

  // 字体指纹保护
  fontFingerprinting?: {
    enabled: boolean;
    mode?: 'block' | 'randomize';
  };

  // 时区伪装
  timezoneSpoof?: {
    enabled: boolean;
    timezone?: string;
  };

  // 语言伪装
  languageSpoof?: {
    enabled: boolean;
    languages?: string[];
  };
}

// 性能配置
export interface PerformanceConfig {
  // CPU 限制
  cpuThrottling?: {
    enabled: boolean;
    rate?: number; // 1-100, 1 表示最慢
  };

  // 内存限制
  memoryLimit?: {
    enabled: boolean;
    maxMemoryMB?: number;
  };

  // 并发限制
  concurrencyLimit?: {
    maxConcurrentPages?: number;
    maxConcurrentRequests?: number;
    requestDelay?: number; // ms
  };

  // 资源优化
  resourceOptimization?: {
    blockImages?: boolean;
    blockCSS?: boolean;
    blockFonts?: boolean;
    blockMedia?: boolean;
    blockAds?: boolean;
    compressImages?: boolean;
  };
}

// 扩展的 HTTP 引擎配置
export interface ExtendedHTTPConfig {
  // User-Agent 配置
  userAgent?: UserAgentConfig;

  // 地理位置配置
  geolocation?: GeolocationConfig;

  // 移动端配置
  mobile?: MobileConfig;

  // 隐私配置
  privacy?: PrivacyConfig;

  // 性能配置
  performance?: PerformanceConfig;

  // HTTP/2 配置
  http2?: {
    enabled: boolean;
    maxConcurrentStreams?: number;
  };

  // 压缩配置
  compression?: {
    enabled: boolean;
    algorithms?: ('gzip' | 'deflate' | 'br')[];
  };

  // 缓存配置
  cache?: {
    enabled: boolean;
    maxAge?: number;
    maxSize?: number;
    strategy?: 'memory' | 'disk' | 'hybrid';
  };

  // 重试配置
  retry?: {
    maxRetries?: number;
    retryDelay?: number;
    backoffMultiplier?: number;
    retryConditions?: string[]; // HTTP 状态码或错误类型
  };
}

// 扩展的 Playwright 引擎配置
export interface ExtendedPlaywrightConfig {
  // User-Agent 配置
  userAgent?: UserAgentConfig;

  // 地理位置配置
  geolocation?: GeolocationConfig & {
    permissions?: ('geolocation' | 'notifications' | 'camera' | 'microphone')[];
  };

  // 移动端配置
  mobile?: MobileConfig;

  // 隐私配置
  privacy?: PrivacyConfig;

  // 性能配置
  performance?: PerformanceConfig;

  // 浏览器配置
  browser?: {
    // 启动参数
    args?: string[];

    // 环境变量
    env?: Record<string, string>;

    // 下载路径
    downloadsPath?: string;

    // 扩展程序
    extensions?: string[];

    // 代理配置
    proxy?: {
      server: string;
      bypass?: string;
      username?: string;
      password?: string;
    };
  };

  // 页面配置
  page?: {
    // 权限配置
    permissions?: string[];

    // 媒体配置
    media?: {
      videoSize?: { width: number; height: number };
      videoFrameRate?: number;
      audioSampleRate?: number;
    };

    // 截图配置
    screenshot?: {
      mode?: 'viewport' | 'fullPage';
      quality?: number;
      type?: 'png' | 'jpeg';
      omitBackground?: boolean;
    };

    // 录制配置
    recording?: {
      enabled: boolean;
      dir?: string;
      size?: { width: number; height: number };
    };
  };

  // 网络配置
  network?: {
    // 离线模式
    offline?: boolean;

    // 网络条件
    conditions?: MobileConfig['networkConditions'];

    // 请求拦截
    intercept?: {
      enabled: boolean;
      patterns?: string[];
      handler?: string; // 处理函数名称
    };

    // 响应修改
    responseModification?: {
      enabled: boolean;
      rules?: Array<{
        urlPattern: string;
        statusCode?: number;
        headers?: Record<string, string>;
        body?: string;
      }>;
    };
  };
}

// CDP 引擎扩展配置
export interface ExtendedCDPConfig {
  // User-Agent 配置
  userAgent?: UserAgentConfig;

  // 地理位置配置
  geolocation?: GeolocationConfig & {
    permissions?: ('geolocation' | 'notifications' | 'camera' | 'microphone')[];
  };

  // 移动端配置
  mobile?: MobileConfig;

  // 隐私配置
  privacy?: PrivacyConfig;

  // 性能配置
  performance?: PerformanceConfig;

  // 浏览器连接配置
  connection?: {
    // 连接池配置
    poolSize?: number;
    // 连接超时
    timeout?: number;
    // 重连策略
    reconnect?: {
      enabled: boolean;
      maxAttempts?: number;
      interval?: number;
      backoffMultiplier?: number;
    };
    // 心跳检测
    heartbeat?: {
      enabled: boolean;
      interval?: number;
      timeout?: number;
    };
  };

  // 目标管理配置
  target?: {
    // 目标发现策略
    discovery?: {
      enabled: boolean;
      interval?: number;
      filters?: {
        types?: string[];
        urlPatterns?: string[];
        titlePatterns?: string[];
      };
    };
    // 目标选择策略
    selection?: {
      strategy?: 'first' | 'last' | 'random' | 'best-match';
      fallback?: 'create-new' | 'wait' | 'error';
    };
    // 标签页管理
    tabManagement?: {
      reuseExisting?: boolean;
      closeAfterUse?: boolean;
      maxTabs?: number;
    };
  };

  // 会话管理配置
  session?: {
    // Cookie 同步策略
    cookieSync?: {
      enabled: boolean;
      strategy?: 'full' | 'domain-only' | 'selective';
      syncInterval?: number;
      domains?: string[];
    };
    // 存储同步
    storageSync?: {
      localStorage?: boolean;
      sessionStorage?: boolean;
      indexedDB?: boolean;
    };
    // 认证状态保持
    authPersistence?: {
      enabled: boolean;
      methods?: ('cookies' | 'localStorage' | 'headers')[];
    };
  };

  // 网络配置
  network?: {
    // 请求拦截
    intercept?: {
      enabled: boolean;
      patterns?: string[];
      handler?: string;
    };
    // 响应修改
    responseModification?: {
      enabled: boolean;
      rules?: Array<{
        urlPattern: string;
        statusCode?: number;
        headers?: Record<string, string>;
        body?: string;
      }>;
    };
    // 缓存控制
    cache?: {
      enabled: boolean;
      strategy?: 'bypass' | 'force-cache' | 'default';
    };
  };

  // 调试配置
  debugging?: {
    // 是否启用详细日志
    verbose?: boolean;
    // 日志级别
    logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
    // 事件记录
    eventLogging?: {
      enabled: boolean;
      events?: string[];
      maxEvents?: number;
    };
    // 性能监控
    performance?: {
      enabled: boolean;
      metrics?: ('timing' | 'memory' | 'network' | 'rendering')[];
    };
  };
}

// 配置预设
export interface ConfigPreset {
  id: string;
  name: string;
  description: string;
  category: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'custom';

  // HTTP 引擎配置
  http?: ExtendedHTTPConfig;

  // CDP 引擎配置
  cdp?: ExtendedCDPConfig;



  // 元数据
  metadata?: {
    author?: string;
    version?: string;
    tags?: string[];
    createdAt?: Date;
    updatedAt?: Date;
  };
}

/**
 * 简化版 UserAgent 生成器（Playwright 已移除，保留最小实现）
 */
export class UserAgentGenerator {
  static generate(config: UserAgentConfig): string {
    if (config.custom) return config.custom;
    const device = config.device;
    if (device) {
      const uaParts = [
        device.browser?.toUpperCase() || 'BROWSER',
        device.browserVersion || '0.0',
        device.os?.toUpperCase() || 'OS',
        device.osVersion || '0'
      ];
      return `Mozilla/5.0 (${uaParts.join('; ')})`;
    }
    // 兜底
    return 'Mozilla/5.0';
  }
}

// 常用设备预设（Playwright 已移除，暂留空以避免误用）
export const DEVICE_PRESETS: Record<string, ConfigPreset> = {};

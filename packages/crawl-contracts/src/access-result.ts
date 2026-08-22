/**
 * AccessResult - 统一的抓取结果格式
 * 基于 ScrapePRD.md 中的 AccessResult 接口设计
 */

// 统一的 Payload 类型（支持多个载荷并存）
export type Payload =
  | {
      type: 'html';
      contentType: 'text/html';
      encoding: string;
      data: string;
      truncated?: boolean;
      size: number;
      checksum: string;
      primary?: boolean;
      source?: string;
    }
  | {
      type: 'json';
      contentType: 'application/json';
      data: unknown;
      size: number;
      checksum: string;
      truncated?: boolean;
      primary?: boolean;
      source?: string;
    }
  | {
      type: 'text';
      contentType: string;
      encoding: string;
      data: string;
      truncated?: boolean;
      size: number;
      checksum: string;
      primary?: boolean;
      source?: string;
    }
  | {
      type: 'binary';
      contentType: string;
      data: Buffer;
      size: number;
      checksum: string;
      truncated?: boolean;
      primary?: boolean;
      source?: string;
    }
  | {
      type: 'xml';
      contentType: 'application/xml' | 'text/xml';
      encoding: string;
      data: string;
      size: number;
      checksum: string;
      truncated?: boolean;
      primary?: boolean;
      source?: string;
    }
  | {
      type: 'css';
      contentType: 'text/css';
      encoding: string;
      data: string;
      size: number;
      checksum: string;
      primary?: boolean;
      source?: string;
      truncated?: boolean;
    }
  | {
      type: 'js';
      contentType: 'application/javascript' | 'text/javascript';
      encoding: string;
      data: string;
      size: number;
      checksum: string;
      primary?: boolean;
      source?: string;
      truncated?: boolean;
    }
  | {
      type: 'xhr_json';
      contentType: 'application/json';
      data: unknown;
      size: number;
      checksum: string;
      primary?: boolean;
      source: string;
      truncated?: boolean;
    }
  | {
      type: 'image';
      contentType: string;
      data: Buffer;
      size: number;
      checksum: string;
      primary?: boolean;
      source: string;
      truncated?: boolean;
    };

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
  id: string;
  url: string;
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  size: number;
  transferSize?: number;
  duration: number;
  resourceType: string;
  connectionId?: string;
  protocol?: string;
  remoteIP?: string;
  remotePort?: number;
  timing?: PerformanceTiming;
  error?: {
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
  dns: number;
  tcp: number;
  tls?: number;
  ttfb: number;
  download: number;
  total: number;

  domainLookup: number;
  connect: number;
  secureConnect?: number;
  request: number;
  response: number;

  domContentLoaded?: number;
  loadComplete?: number;

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
  selector?: string;
  data: Buffer;
  width?: number;
  height?: number;
}

// 错误信息
export interface AccessError {
  code:
    | 'TIMEOUT'
    | 'NETWORK'
    | 'PARSE'
    | 'UNSUPPORTED'
    | 'AUTH'
    | 'RATE_LIMIT'
    | 'CAPTCHA';
  message: string;
  timestamp: Date;

  category: 'RETRYABLE' | 'ENGINE_SWITCH' | 'HUMAN_CHECK' | 'FATAL';

  captchaType?: 'recaptcha' | 'hcaptcha' | 'custom';
  requireHuman?: boolean;
}

// 元信息
export interface Metadata {
  url: string;
  finalUrl: string;
  statusCode: number;
  title?: string;
  lang?: string;
  charset?: string;
  contentType?: string;
  redirected?: boolean;
  fetchedAt: Date;
  duration: number;
}

// 统一的抓取结果
export interface AccessResult {
  success: boolean;
  metadata: Metadata;
  payloads: Payload[];

  mainPayload?: MainPayload;
  samplePayloads?: SamplePayload[];

  resources?: Resource[];
  screenshots?: Screenshot[];
  cookies?: Cookie[];

  network?: {
    requests: NetworkRequest[];
    summary: {
      totalRequests: number;
      totalBytes: number;
      totalTime: number;
    };
  };

  performance?: {
    timing?: PerformanceTiming;
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
    metrics?: Record<string, number>;
  };

  error?: AccessError;

  debug?: {
    rawHtml?: string;
    rawContent?: Buffer;
    rawHeaders?: Record<string, string>;
    engineLog?: string[];
  };
}

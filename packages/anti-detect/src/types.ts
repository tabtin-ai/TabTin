import type {
  ProxyConfig,
  Cookie,
  AccessResult,
} from '@tabtin/crawl-integration';

// UA 配置（轻量化，避免直接依赖 extended-options 的实现）
export interface UAConfig {
  preset?: 'desktop' | 'mobile' | 'tablet' | 'system';
  randomize?: boolean;
  pool?: string[];
}

// 反检测配置入口
export interface AntiDetectConfig {
  userAgent?: string | UAConfig;
  proxy?: ProxyConfig | ProxyConfig[];
  session?: {
    id?: string;
    cookies?: Cookie[];
    partition?: string;
    persistent?: boolean;
  };
  fingerprint?: {
    preset?: 'stealth' | 'balanced' | 'minimal';
    canvas?: boolean;
    webgl?: boolean;
    webrtc?: boolean;
  };
  behavior?: {
    delay?: {
      min: number;
      max: number;
    };
    humanize?: boolean;
  };
}

// 会话画像（UA + Proxy + Session 状态）
export interface SessionProfile {
  id: string;
  userAgent: string;
  proxy?: ProxyConfig;
  proxyPool?: ProxyConfig[];
  session: {
    id: string;
    cookies: Cookie[];
    partition?: string;
    persistent?: boolean;
  };
  fingerprint?: {
    id: string;
  };
  behavior?: {
    delayRange?: [number, number];
    humanize?: boolean;
  };
  createdAt: Date;
  lastUsedAt: Date;
  usageCount: number;
}

// 反检测信息（脱敏后写回 AccessResult 以便监控）
export interface AntiDetectInfo {
  userAgentTag?: string;
  proxyTag?: string;
  sessionId?: string;
  fingerprintId?: string;
}

// Session 存储接口
export interface SessionStore {
  get(sessionId: string): Promise<SessionProfile | undefined>;
  save(profile: SessionProfile): Promise<void>;
  updateFromAccessResult(profile: SessionProfile, result: AccessResult): Promise<void>;
}

// 适配器应用结果（便于在调用处合并）
export interface AppliedAntiDetect {
  profile?: SessionProfile;
}

// applyToHttpOptions 的输入/输出类型
export interface HttpRequestOptions {
  headers?: Record<string, string>;
  proxy?: {
    host: string;
    port: number;
    protocol?: string;
    username?: string;
    password?: string;
  };
  cookies?: Array<{ name: string; value: string; domain?: string }>;
}

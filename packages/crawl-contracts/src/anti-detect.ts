import type { Cookie } from './access-result';
import type { ProxyConfig } from './network';

export interface UAConfig {
  preset?: 'desktop' | 'mobile' | 'tablet' | 'system';
  randomize?: boolean;
  pool?: string[];
}

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

export interface AntiDetectInfo {
  userAgentTag?: string;
  proxyTag?: string;
  sessionId?: string;
  fingerprintId?: string;
}

export interface AppliedAntiDetect {
  profile?: SessionProfile;
}

export type { ProxyConfig };

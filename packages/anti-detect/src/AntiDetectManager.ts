import type {
  AccessResult,
  Cookie,
  ProxyConfig,
} from '@tabtin/crawl-integration';
import { randomUUID } from 'crypto';
import { AntiDetectConfig, SessionProfile, SessionStore, UAConfig, AntiDetectInfo, HttpRequestOptions } from './types.js';
import { getClientHintsService } from './client-hints/ClientHintsService.js';
import { DESKTOP_UA_POOL, MOBILE_UA_POOL, TABLET_UA_POOL, UAPool } from './pool/UAPool.js';
import { ProxyPool } from './pool/ProxyPool.js';
import { ProxyHealthChecker } from './ProxyHealthChecker.js';
import { DynamicUAPoolManager } from './pool/DynamicUAPoolManager.js';
import { MobileDeviceFingerprintGenerator, IOSUserAgentGenerator } from './pool/mobile-ua-generator.js';
import type { DeviceProfile } from './pool/device-profiles.js';
import { IPAD_DEVICES } from './pool/device-profiles.js';

const resolveSystemUserAgent = async (): Promise<string> => {
  try {
    const module = await import('@tabtin/crawl-integration');
    const getter = (module as { getSystemUserAgent?: () => string }).getSystemUserAgent;
    if (typeof getter === 'function') {
      return getter();
    }
  } catch {
    // Ignore: manifest generation may run without Electron dependencies
  }
  return DESKTOP_UA_POOL[0] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
};

// 简单的内存 Session 存储
class InMemorySessionStore implements SessionStore {
  private store = new Map<string, SessionProfile>();

  async get(sessionId: string): Promise<SessionProfile | undefined> {
    return this.store.get(sessionId);
  }

  async save(profile: SessionProfile): Promise<void> {
    this.store.set(profile.id, profile);
  }

  async updateFromAccessResult(profile: SessionProfile, result: AccessResult): Promise<void> {
    // 更新 cookies
    if (result?.response?.cookies && Array.isArray(result.response.cookies)) {
      profile.session.cookies = mergeCookies(profile.session.cookies, result.response.cookies);
    }
    profile.lastUsedAt = new Date();
    profile.usageCount += 1;
    this.store.set(profile.id, profile);
  }
}

export class AntiDetectManager {
  private sessionStore: SessionStore;
  private uaPool: UAPool;
  private sessionProxyPools = new Map<string, ProxyPool>();
  private proxyHealthChecker = new ProxyHealthChecker();
  private dynamicUAPoolManager: DynamicUAPoolManager;
  private dynamicPoolInitPromise: Promise<void> | null = null;
  private dynamicPoolReady = false;

  constructor(sessionStore?: SessionStore) {
    this.sessionStore = sessionStore || new InMemorySessionStore();
    this.uaPool = new UAPool();
    this.dynamicUAPoolManager = new DynamicUAPoolManager();
  }

  async initializeDynamicUA(): Promise<void> {
    if (this.dynamicPoolReady) return;
    if (!this.dynamicPoolInitPromise) {
      this.dynamicPoolInitPromise = this.dynamicUAPoolManager
        .initialize()
        .then(() => { this.dynamicPoolReady = true; })
        .catch((err) => {
          console.warn('[AntiDetect] 动态 UA 池初始化失败，将使用静态池', err);
          this.dynamicPoolInitPromise = null;
        });
    }
    return this.dynamicPoolInitPromise;
  }

  private triggerDynamicPoolInit(): void {
    if (this.dynamicPoolReady || this.dynamicPoolInitPromise) return;
    this.initializeDynamicUA();
  }

  async getOrCreateProfile(config?: AntiDetectConfig): Promise<SessionProfile> {
    const sessionId = config?.session?.id || randomUUID();
    const existing = await this.sessionStore.get(sessionId);
    if (existing) {
      if (existing.proxyPool && !this.sessionProxyPools.has(sessionId)) {
        this.sessionProxyPools.set(sessionId, new ProxyPool(existing.proxyPool));
      }
      existing.lastUsedAt = new Date();
      existing.usageCount += 1;
      return existing;
    }

    const userAgent = await this.resolveUserAgent(config?.userAgent);
    const proxy = await this.resolveProxy(sessionId, config?.proxy);
    const cookies = config?.session?.cookies || [];

    const profile: SessionProfile = {
      id: sessionId,
      userAgent,
      proxy: proxy || undefined,
      proxyPool: Array.isArray(config?.proxy) ? [...config.proxy] : undefined,
      session: {
        id: sessionId,
        cookies: [...cookies],
        partition: config?.session?.partition,
        persistent: config?.session?.persistent
      },
      fingerprint: config?.fingerprint
        ? { id: randomUUID() }
        : undefined,
      behavior: config?.behavior
        ? {
            delayRange: config.behavior.delay
              ? [config.behavior.delay.min, config.behavior.delay.max]
              : undefined,
            humanize: config.behavior.humanize
          }
        : undefined,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      usageCount: 1
    };

    await this.sessionStore.save(profile);
    return profile;
  }

  async updateProfileFromResult(profile: SessionProfile, result: AccessResult): Promise<void> {
    await this.sessionStore.updateFromAccessResult(profile, result);
  }

  buildAntiDetectInfo(profile?: SessionProfile): AntiDetectInfo | undefined {
    if (!profile) return undefined;
    return {
      userAgentTag: profile.userAgent ? tagUserAgent(profile.userAgent) : undefined,
      proxyTag: profile.proxy ? tagProxy(profile.proxy) : undefined,
      sessionId: profile.session.id,
      fingerprintId: profile.fingerprint?.id
    };
  }

  private async resolveUserAgent(config?: string | UAConfig): Promise<string> {
    if (!config) return await resolveSystemUserAgent();
    if (typeof config === 'string') {
      if (config === 'system') return await resolveSystemUserAgent();
      return config;
    }

    if (config.preset) {
      const dynamicUA = this.resolveDynamicPresetUA(config.preset);
      if (dynamicUA) return dynamicUA;

      const presetPool = this.getPresetPool(config.preset);
      if (presetPool) {
        this.uaPool = new UAPool(presetPool, config.randomize ? 'random' : 'sequential');
        return this.uaPool.next();
      }
    }

    if (config.pool && config.pool.length > 0) {
      this.uaPool = new UAPool(config.pool, config.randomize ? 'random' : 'sequential');
      return this.uaPool.next();
    }

    if (config.randomize) {
      return this.uaPool.next();
    }

    return await resolveSystemUserAgent();
  }

  private resolveDynamicPresetUA(preset: UAConfig['preset']): string | undefined {
    switch (preset) {
      case 'desktop': {
        this.triggerDynamicPoolInit();
        if (this.dynamicPoolReady) {
          return this.dynamicUAPoolManager.getRandomUA();
        }
        return undefined;
      }
      case 'mobile': {
        try {
          return MobileDeviceFingerprintGenerator.generateRandom({
            platform: 'auto',
            includeIPad: false,
          }).userAgent;
        } catch {
          return undefined;
        }
      }
      case 'tablet': {
        try {
          return this.generateRandomTabletUA();
        } catch {
          return undefined;
        }
      }
      default:
        return undefined;
    }
  }

  private generateRandomTabletUA(): string {
    if (IPAD_DEVICES.length === 0) {
      throw new Error('No iPad devices available');
    }
    const device = selectWeightedDevice(IPAD_DEVICES);
    return IOSUserAgentGenerator.generate(device).userAgent;
  }

  private async resolveProxy(
    sessionId: string,
    config?: ProxyConfig | ProxyConfig[] | undefined
  ): Promise<ProxyConfig | undefined> {
    if (!config) return undefined;
    if (Array.isArray(config) && config.length > 0) {
      const pool = this.getOrCreateProxyPool(sessionId, config);
      if (!pool) return undefined;
      pool.setProxies(config);

      const candidate = pool.nextHealthy();
      if (!candidate) return undefined;
      const health = await this.proxyHealthChecker.check(candidate);
      if (health.healthy) {
        pool.markHealthy(candidate);
        return candidate;
      }
      pool.reportFailure(candidate);
      return pool.nextHealthy();
    }
    return config as ProxyConfig;
  }

  reportProxyFailure(profile: SessionProfile, error?: any) {
    const pool = this.getOrCreateProxyPool(profile.id, profile.proxyPool);
    if (profile.proxy && pool) {
      pool.reportFailure(profile.proxy);
      const next = pool.nextHealthy();
      if (next && !isSameProxy(next, profile.proxy)) {
        profile.proxy = next;
        this.sessionStore.save(profile);
        console.warn('[AntiDetect] 代理失败，已切换到下一个代理', tagProxy(next));
        return;
      }
    }
    if (profile.proxy) {
      console.warn('[AntiDetect] 代理标记为失败', error?.message || error);
    }
  }

  markProxyHealthy(profile: SessionProfile) {
    const pool = this.getOrCreateProxyPool(profile.id, profile.proxyPool);
    if (profile.proxy && pool) {
      pool.markHealthy(profile.proxy);
    }
  }

  private getPresetPool(preset?: UAConfig['preset']): string[] | undefined {
    switch (preset) {
      case 'desktop':
        return DESKTOP_UA_POOL;
      case 'mobile':
        return MOBILE_UA_POOL;
      case 'tablet':
        return TABLET_UA_POOL;
      case 'system':
      default:
        return undefined;
    }
  }

  private getOrCreateProxyPool(sessionId: string, proxies?: ProxyConfig[]): ProxyPool | undefined {
    if (!proxies || proxies.length === 0) return undefined;
    const existing = this.sessionProxyPools.get(sessionId);
    if (existing) return existing;
    const pool = new ProxyPool(proxies);
    this.sessionProxyPools.set(sessionId, pool);
    return pool;
  }

  /**
   * 将 SessionProfile 中的反检测信息统一注入到 HTTP 请求选项中。
   *
   * 优先级：profile 生成的 headers（UA、Client Hints）覆盖调用方同名项，
   * 调用方其余自定义 headers 原样保留。
   */
  applyToHttpOptions(profile: SessionProfile, options?: HttpRequestOptions): HttpRequestOptions {
    const result: HttpRequestOptions = {
      headers: { ...options?.headers },
      proxy: options?.proxy,
      cookies: options?.cookies ? [...options.cookies] : [],
    };

    if (profile.userAgent) {
      result.headers!['User-Agent'] = profile.userAgent;

      const hintsHeaders = getClientHintsService().generateHeaders(profile.userAgent);
      for (const [key, value] of Object.entries(hintsHeaders)) {
        result.headers![key] = value;
      }
    }

    if (profile.proxy) {
      result.proxy = {
        host: profile.proxy.host,
        port: profile.proxy.port,
        protocol: profile.proxy.protocol,
        username: profile.proxy.username,
        password: profile.proxy.password,
      };
    }

    if (profile.session.cookies.length > 0) {
      const cookieMap = new Map<string, { name: string; value: string; domain?: string }>();
      for (const c of result.cookies!) {
        cookieMap.set(`${c.name}|${c.domain ?? ''}`, c);
      }
      for (const c of profile.session.cookies) {
        cookieMap.set(`${c.name}|${c.domain ?? ''}`, {
          name: c.name,
          value: c.value,
          domain: c.domain,
        });
      }
      result.cookies = Array.from(cookieMap.values());
    }

    return result;
  }

  dispose(): void {
    this.dynamicUAPoolManager.dispose();
    this.dynamicPoolReady = false;
    this.dynamicPoolInitPromise = null;
  }
}

// ===== 工具函数 =====

function mergeCookies(base: Cookie[], incoming: Cookie[]): Cookie[] {
  const map = new Map<string, Cookie>();
  for (const c of base) {
    map.set(buildCookieKey(c), c);
  }
  for (const c of incoming) {
    map.set(buildCookieKey(c), c);
  }
  return Array.from(map.values());
}

function tagProxy(proxy: ProxyConfig): string {
  const host = proxy.host || (proxy as any).server;
  const port = proxy.port || (proxy as any).port;
  return host ? `${host}${port ? `:${port}` : ''}` : 'proxy';
}

function tagUserAgent(ua: string): string {
  const match = ua.match(/(Chrome|Firefox|Safari|Edg|OPR)\/[\d.]+/);
  return match ? match[1] : 'ua';
}

function buildCookieKey(cookie: Cookie): string {
  const domain = cookie.domain || '';
  const path = cookie.path || '';
  return `${cookie.name}|${domain}|${path}`;
}

function isSameProxy(a: ProxyConfig, b: ProxyConfig): boolean {
  const hostA = (a as any).host || (a as any).server;
  const hostB = (b as any).host || (b as any).server;
  return hostA === hostB && (a.port || (a as any).port) === (b.port || (b as any).port);
}

function selectWeightedDevice(devices: DeviceProfile[]): DeviceProfile {
  const totalWeight = devices.reduce((sum, d) => sum + (d.weight || 1), 0);
  let random = Math.random() * totalWeight;
  for (const device of devices) {
    random -= (device.weight || 1);
    if (random <= 0) return device;
  }
  return devices[0];
}

// 共享的 SessionStore 与 AntiDetectManager，便于跨引擎/跨任务复用会话
const sharedSessionStore = new InMemorySessionStore();
export const sharedAntiDetectManager = new AntiDetectManager(sharedSessionStore);

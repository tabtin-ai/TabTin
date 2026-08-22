import type { ProxyConfig } from '@tabtin/crawl-integration';

type ProxyStatus = 'healthy' | 'unknown' | 'failed';

export interface PooledProxy extends ProxyConfig {
  status: ProxyStatus;
  lastChecked?: number;
  failures?: number;
  lastFailure?: number;
}

export class ProxyPool {
  private proxies: PooledProxy[] = [];
  private cursor = 0;
  private failureThreshold: number;
  private cooldownMs: number;

  constructor(configs: ProxyConfig[] = [], failureThreshold = 3, cooldownMs = 60_000) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.proxies = configs.map(p => ({ ...p, status: 'unknown', failures: 0 }));
  }

  setProxies(configs: ProxyConfig[]) {
    this.proxies = configs.map(p => ({ ...p, status: 'unknown', failures: 0 }));
    this.cursor = 0;
  }

  reportFailure(proxy: ProxyConfig) {
    const idx = this.proxies.findIndex(p => isSameProxy(p, proxy));
    if (idx >= 0) {
      this.proxies[idx].status = 'failed';
      this.proxies[idx].failures = (this.proxies[idx].failures || 0) + 1;
      this.proxies[idx].lastFailure = Date.now();
    }
  }

  markHealthy(proxy: ProxyConfig) {
    const idx = this.proxies.findIndex(p => isSameProxy(p, proxy));
    if (idx >= 0) {
      this.proxies[idx].status = 'healthy';
      this.proxies[idx].failures = 0;
      this.proxies[idx].lastChecked = Date.now();
    }
  }

  nextHealthy(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    const total = this.proxies.length;
    let checked = 0;
    const now = Date.now();

    while (checked < total) {
      const candidate = this.proxies[this.cursor % total];
      this.cursor += 1;
      checked += 1;

      if (this.inCooldown(candidate, now)) {
        continue;
      }
      if (candidate.status === 'failed' && (candidate.failures || 0) >= this.failureThreshold) {
        continue;
      }
      if (candidate.status === 'failed') {
        candidate.status = 'unknown';
      }
      return candidate;
    }

    const cooled = this.proxies.find(p => this.hasCooledDown(p, now));
    if (cooled) {
      cooled.status = 'unknown';
      return cooled;
    }

    return undefined;
  }

  private inCooldown(proxy: PooledProxy, now: number): boolean {
    return proxy.status === 'failed' && proxy.lastFailure !== undefined
      && now - proxy.lastFailure < this.cooldownMs;
  }

  private hasCooledDown(proxy: PooledProxy, now: number): boolean {
    return proxy.lastFailure !== undefined && now - proxy.lastFailure >= this.cooldownMs;
  }
}

function isSameProxy(a: ProxyConfig, b: ProxyConfig): boolean {
  const hostA = (a as any).host || (a as any).server;
  const hostB = (b as any).host || (b as any).server;
  return hostA === hostB && (a.port || (a as any).port) === (b.port || (b as any).port);
}

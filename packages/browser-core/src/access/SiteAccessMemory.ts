import { AccessLevel } from './AccessLevel';

interface SiteEntry {
  level: AccessLevel;
  updatedAt: number;
  consecutiveSuccesses: number;
  ttl: number;
}

const HOUR_MS = 3_600_000;
const BASE_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168;

const DOUBLE_SUFFIXES = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.in', 'co.nz', 'co.za',
  'com.au', 'com.br', 'com.cn', 'com.hk', 'com.tw', 'com.sg',
  'org.uk', 'net.au', 'ac.uk', 'gov.uk',
]);

/**
 * 计算自适应 TTL。
 * 公式：`min(24 * 2^(n-1), 168)` 小时，n = consecutiveSuccesses。
 */
function computeTtl(consecutiveSuccesses: number): number {
  const hours = Math.min(
    BASE_TTL_HOURS * Math.pow(2, consecutiveSuccesses - 1),
    MAX_TTL_HOURS,
  );
  return hours * HOUR_MS;
}

/**
 * 域名级别的访问策略记忆系统。
 *
 * 记住每个域名（eTLD+1）需要的最低 AccessLevel，
 * 避免每次访问都从 L0 开始探测、被拦截后再升级。
 *
 * 纯数据结构，不依赖文件系统 —— 序列化/反序列化由调用方负责。
 */
export class SiteAccessMemory {
  private memory = new Map<string, SiteEntry>();

  /**
   * 获取域名的推荐访问等级。
   *
   * - 无记录 → L0
   * - 有记录且未过期 → 返回记忆的等级
   * - 有记录但已过期 → 返回 max(level - 1, L0)（降级探测）
   */
  getLevel(domain: string): AccessLevel {
    const key = SiteAccessMemory.extractDomain(domain);
    const entry = this.memory.get(key);
    if (!entry) return AccessLevel.L0;

    const expired = Date.now() - entry.updatedAt > entry.ttl;
    if (!expired) return entry.level;

    const downgraded = Math.max(entry.level - 1, AccessLevel.L0) as AccessLevel;
    return downgraded;
  }

  /**
   * 记录域名的一次成功访问。
   *
   * - 连续在同一等级成功 → consecutiveSuccesses 递增，TTL 指数增长
   * - 等级变化 → consecutiveSuccesses 重置为 1
   */
  recordSuccess(domain: string, level: AccessLevel): void {
    const key = SiteAccessMemory.extractDomain(domain);
    const existing = this.memory.get(key);

    let consecutiveSuccesses: number;
    if (existing && existing.level === level) {
      consecutiveSuccesses = existing.consecutiveSuccesses + 1;
    } else {
      consecutiveSuccesses = 1;
    }

    this.memory.set(key, {
      level,
      updatedAt: Date.now(),
      consecutiveSuccesses,
      ttl: computeTtl(consecutiveSuccesses),
    });
  }

  /**
   * 提取 eTLD+1 域名（简化实现）。
   *
   * 对已知的双后缀（co.uk、com.au 等）做特殊处理，其他取最后两段。
   *
   * @example
   * extractDomain("www.example.com")          // → "example.com"
   * extractDomain("api.shop.example.co.uk")   // → "example.co.uk"
   * extractDomain("localhost:3000")            // → "localhost"
   */
  static extractDomain(url: string): string {
    let host = url;

    const protoIdx = host.indexOf('://');
    if (protoIdx !== -1) host = host.slice(protoIdx + 3);

    const slashIdx = host.indexOf('/');
    if (slashIdx !== -1) host = host.slice(0, slashIdx);

    const atIdx = host.lastIndexOf('@');
    if (atIdx !== -1) host = host.slice(atIdx + 1);

    const portIdx = host.lastIndexOf(':');
    if (portIdx !== -1) {
      const afterColon = host.slice(portIdx + 1);
      if (/^\d+$/.test(afterColon)) {
        host = host.slice(0, portIdx);
      }
    }

    host = host.toLowerCase();

    if (!host.includes('.')) return host;

    // IPv4 地址直接返回，不做 eTLD+1 提取
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

    const parts = host.split('.');
    if (parts.length <= 2) return host;

    const lastTwo = parts.slice(-2).join('.');
    if (DOUBLE_SUFFIXES.has(lastTwo)) {
      return parts.length >= 3
        ? parts.slice(-3).join('.')
        : host;
    }

    return lastTwo;
  }

  /**
   * 序列化为 JSON 字符串（用于持久化到本地文件）。
   */
  serialize(): string {
    const entries: Array<[string, SiteEntry]> = [];
    for (const [key, value] of this.memory) {
      entries.push([key, value]);
    }
    return JSON.stringify(entries);
  }

  /**
   * 从 JSON 字符串恢复实例（Electron 启动时加载）。
   */
  static deserialize(json: string): SiteAccessMemory {
    const instance = new SiteAccessMemory();
    try {
      const entries: Array<[string, unknown]> = JSON.parse(json);
      if (!Array.isArray(entries)) return instance;
      for (const [key, value] of entries) {
        if (typeof key === 'string' && SiteAccessMemory.isValidEntry(value)) {
          instance.memory.set(key, value as SiteEntry);
        }
      }
    } catch {
      // 数据损坏时返回空实例，下次访问重新学习
    }
    return instance;
  }

  private static isValidEntry(v: unknown): v is SiteEntry {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return (
      typeof e.level === 'number' &&
      typeof e.updatedAt === 'number' &&
      typeof e.consecutiveSuccesses === 'number' &&
      typeof e.ttl === 'number'
    );
  }

  /**
   * 清除所有记忆。
   */
  clear(): void {
    this.memory.clear();
  }

  /**
   * 当前记忆条目数。
   */
  get size(): number {
    return this.memory.size;
  }
}

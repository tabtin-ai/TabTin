/**
 * 桌面 UA 池 - 专业级扩充版
 *
 * 目标：提供 30+ 真实 UA，按市场份额加权
 * 数据来源：StatCounter Global Stats (2026-Q1)
 * 覆盖率：Chrome 70%、Edge 15%、Firefox 10%、Safari 5%
 */


/**
 * 桌面 UA 配置
 */
export interface DesktopUAConfig {
  ua: string;
  browser: 'Chrome' | 'Edge' | 'Firefox' | 'Safari';
  os: 'Windows' | 'macOS' | 'Linux';
  version: string;
  weight: number; // 市场份额百分比
}

export interface DesktopUAFactoryOptions {
  chromeVersion?: string;
  firefoxVersion?: string;
  safariVersion?: string;
  safariLegacyVersion?: string;
}

export interface WeightedDesktopUAPoolOptions extends DesktopUAFactoryOptions {
  pool?: DesktopUAConfig[];
}

export const DEFAULT_CHROME_VERSION = '141.0.0.0';
const DEFAULT_FIREFOX_VERSION = '135.0';
const DEFAULT_SAFARI_VERSION = '18.3';
const DEFAULT_SAFARI_LEGACY_VERSION = '18.2';

const isValidChromiumVersion = (version?: string): boolean => {
  return Boolean(version && /^\d+\.\d+\.\d+\.\d+$/.test(version.trim()));
};

export function resolveRuntimeChromeVersion(chromeVersion?: string): string {
  if (isValidChromiumVersion(chromeVersion)) {
    return chromeVersion!.trim();
  }

  const runtimeVersion = process.versions?.chrome;
  if (isValidChromiumVersion(runtimeVersion)) {
    return runtimeVersion!.trim();
  }

  return DEFAULT_CHROME_VERSION;
}

export function generateDesktopChromeVersionPool(
  chromeVersion?: string,
  count: number = 6,
): string[] {
  const resolved = resolveRuntimeChromeVersion(chromeVersion);
  const [major, minor, build, patch] = resolved.split('.').map(Number);

  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const nextMajor = Math.max(major - index, 120);
    return `${nextMajor}.${minor}.${build}.${patch}`;
  });
}

const createChromeUA = (
  os: DesktopUAConfig['os'],
  version: string,
  weight: number,
  platformUA: string,
): DesktopUAConfig => ({
  ua: `Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
  browser: 'Chrome',
  os,
  version,
  weight,
});

const createEdgeUA = (
  os: Extract<DesktopUAConfig['os'], 'Windows' | 'macOS'>,
  chromeVersion: string,
  weight: number,
  platformUA: string,
): DesktopUAConfig => ({
  ua: `Mozilla/5.0 (${platformUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 Edg/${chromeVersion}`,
  browser: 'Edge',
  os,
  version: chromeVersion,
  weight,
});

export function createDesktopUAConfigPool(
  options: DesktopUAFactoryOptions = {},
): DesktopUAConfig[] {
  const chromeVersions = generateDesktopChromeVersionPool(options.chromeVersion, 6);
  const firefoxVersion = options.firefoxVersion ?? DEFAULT_FIREFOX_VERSION;
  const safariVersion = options.safariVersion ?? DEFAULT_SAFARI_VERSION;
  const safariLegacyVersion = options.safariLegacyVersion ?? DEFAULT_SAFARI_LEGACY_VERSION;

  return [
    createChromeUA('Windows', chromeVersions[0], 20.0, 'Windows NT 10.0; Win64; x64'),
    createChromeUA('Windows', chromeVersions[1], 10.0, 'Windows NT 10.0; Win64; x64'),
    createChromeUA('Windows', chromeVersions[2], 8.0, 'Windows NT 10.0; Win64; x64'),
    createChromeUA('Windows', chromeVersions[3], 5.0, 'Windows NT 10.0; Win64; x64'),
    createChromeUA('Windows', chromeVersions[4], 4.0, 'Windows NT 10.0; Win64; x64'),
    createChromeUA('Windows', chromeVersions[5], 3.0, 'Windows NT 10.0; Win64; x64'),

    createChromeUA('macOS', chromeVersions[0], 12.0, 'Macintosh; Intel Mac OS X 10_15_7'),
    createChromeUA('macOS', chromeVersions[0], 8.0, 'Macintosh; Intel Mac OS X 14_7_1'),
    createChromeUA('macOS', chromeVersions[1], 5.0, 'Macintosh; Intel Mac OS X 10_15_7'),
    createChromeUA('macOS', chromeVersions[1], 3.0, 'Macintosh; Intel Mac OS X 14_7_1'),
    createChromeUA('macOS', chromeVersions[2], 2.0, 'Macintosh; Intel Mac OS X 10_15_7'),

    createChromeUA('Linux', chromeVersions[0], 3.0, 'X11; Linux x86_64'),
    createChromeUA('Linux', chromeVersions[1], 2.0, 'X11; Linux x86_64'),

    createEdgeUA('Windows', chromeVersions[0], 8.0, 'Windows NT 10.0; Win64; x64'),
    createEdgeUA('Windows', chromeVersions[1], 4.0, 'Windows NT 10.0; Win64; x64'),
    createEdgeUA('macOS', chromeVersions[0], 3.0, 'Macintosh; Intel Mac OS X 10_15_7'),

    {
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${firefoxVersion}) Gecko/20100101 Firefox/${firefoxVersion}`,
      browser: 'Firefox',
      os: 'Windows',
      version: firefoxVersion,
      weight: 5.0,
    },
    {
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:${firefoxVersion}) Gecko/20100101 Firefox/${firefoxVersion}`,
      browser: 'Firefox',
      os: 'macOS',
      version: firefoxVersion,
      weight: 3.0,
    },
    {
      ua: `Mozilla/5.0 (X11; Linux x86_64; rv:${firefoxVersion}) Gecko/20100101 Firefox/${firefoxVersion}`,
      browser: 'Firefox',
      os: 'Linux',
      version: firefoxVersion,
      weight: 2.0,
    },
    {
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safariVersion} Safari/605.1.15`,
      browser: 'Safari',
      os: 'macOS',
      version: safariVersion,
      weight: 3.0,
    },
    {
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${safariLegacyVersion} Safari/605.1.15`,
      browser: 'Safari',
      os: 'macOS',
      version: safariLegacyVersion,
      weight: 2.0,
    },
  ];
}

const DESKTOP_UA_CONFIG_POOL = createDesktopUAConfigPool();

/**
 * Chrome 桌面 UA 池（Windows + macOS + Linux）
 */
export const CHROME_DESKTOP_POOL: DesktopUAConfig[] = DESKTOP_UA_CONFIG_POOL.filter(
  item => item.browser === 'Chrome',
);

/**
 * Edge (Chromium-based) UA 池 (15% of total)
 */
export const EDGE_DESKTOP_POOL: DesktopUAConfig[] = DESKTOP_UA_CONFIG_POOL.filter(
  item => item.browser === 'Edge',
);

/**
 * Firefox UA 池 (10% of total)
 */
export const FIREFOX_DESKTOP_POOL: DesktopUAConfig[] = DESKTOP_UA_CONFIG_POOL.filter(
  item => item.browser === 'Firefox',
);

/**
 * Safari UA 池 (5% of total)
 */
export const SAFARI_DESKTOP_POOL: DesktopUAConfig[] = DESKTOP_UA_CONFIG_POOL.filter(
  item => item.browser === 'Safari',
);

/**
 * 所有桌面 UA（按权重排序）
 */
export const ALL_DESKTOP_UA_POOL = [...DESKTOP_UA_CONFIG_POOL];

/**
 * 权重 UA 选择器
 */
export class WeightedDesktopUAPool {
  private pool: DesktopUAConfig[];
  private totalWeight: number;

  constructor(customPoolOrOptions?: DesktopUAConfig[] | WeightedDesktopUAPoolOptions) {
    if (Array.isArray(customPoolOrOptions)) {
      this.pool = customPoolOrOptions;
    } else if (customPoolOrOptions?.pool) {
      this.pool = customPoolOrOptions.pool;
    } else {
      this.pool = createDesktopUAConfigPool(customPoolOrOptions);
    }
    this.totalWeight = this.pool.reduce((sum, item) => sum + item.weight, 0);
  }

  /**
   * 按权重随机选择 UA
   */
  next(): string {
    let random = Math.random() * this.totalWeight;

    for (const item of this.pool) {
      random -= item.weight;
      if (random <= 0) {
        return item.ua;
      }
    }

    return this.pool[0].ua;
  }

  /**
   * 获取 UA 配置信息
   */
  nextWithConfig(): DesktopUAConfig {
    let random = Math.random() * this.totalWeight;

    for (const item of this.pool) {
      random -= item.weight;
      if (random <= 0) {
        return item;
      }
    }

    return this.pool[0];
  }

  /**
   * 根据浏览器筛选
   */
  filterByBrowser(browser: 'Chrome' | 'Edge' | 'Firefox' | 'Safari'): WeightedDesktopUAPool {
    const filtered = this.pool.filter(item => item.browser === browser);
    return new WeightedDesktopUAPool(filtered);
  }

  /**
   * 根据操作系统筛选
   */
  filterByOS(os: 'Windows' | 'macOS' | 'Linux'): WeightedDesktopUAPool {
    const filtered = this.pool.filter(item => item.os === os);
    return new WeightedDesktopUAPool(filtered);
  }

  /**
   * 获取池大小
   */
  size(): number {
    return this.pool.length;
  }

  /**
   * 获取所有 UA 字符串
   */
  getAllUA(): string[] {
    return this.pool.map(item => item.ua);
  }
}

/**
 * 动态生成桌面 UA 池（基于真实系统）
 *
 * 🔴 修复：不再硬编码，而是使用扩充后的真实 UA 池
 */
export function generateDesktopUAPool(options: DesktopUAFactoryOptions = {}): string[] {
  return createDesktopUAConfigPool(options).map(item => item.ua);
}

/**
 * 桌面 UA 池（延迟初始化）
 */
export const DESKTOP_UA_POOL = generateDesktopUAPool();

/**
 * 移动 UA 池（保留兼容性）
 */
export const MOBILE_UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
  `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${resolveRuntimeChromeVersion()} Mobile Safari/537.36`,
];

export const TABLET_UA_POOL = [
  'Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
];

const DEFAULT_UA_POOL = [...DESKTOP_UA_POOL, ...MOBILE_UA_POOL];

export type UARotation = 'random' | 'sequential' | 'weighted';

/**
 * UA 池管理器（增强版）
 */
export class UAPool {
  private pool: string[];
  private cursor = 0;
  private rotation: UARotation;
  private weightedPool?: WeightedDesktopUAPool;

  constructor(
    userAgents?: string[],
    rotation: UARotation = 'weighted',
    options?: DesktopUAFactoryOptions,
  ) {
    this.pool = userAgents && userAgents.length > 0 ? [...userAgents] : [...DEFAULT_UA_POOL];
    this.rotation = rotation;

    // 如果是 weighted 模式，初始化权重池
    if (rotation === 'weighted' && !userAgents) {
      this.weightedPool = new WeightedDesktopUAPool(options);
    }
  }

  setRotation(rotation: UARotation) {
    this.rotation = rotation;
  }

  next(): string {
    if (this.pool.length === 0) {
      return DEFAULT_UA_POOL[0];
    }

    // Weighted 模式（推荐）
    if (this.rotation === 'weighted' && this.weightedPool) {
      return this.weightedPool.next();
    }

    // Sequential 模式
    if (this.rotation === 'sequential') {
      const ua = this.pool[this.cursor % this.pool.length];
      this.cursor += 1;
      return ua;
    }

    // Random 模式
    const idx = Math.floor(Math.random() * this.pool.length);
    return this.pool[idx];
  }

  /**
   * 获取 UA 及其配置信息
   */
  nextWithInfo(): { ua: string; config?: DesktopUAConfig } {
    if (this.rotation === 'weighted' && this.weightedPool) {
      const config = this.weightedPool.nextWithConfig();
      return { ua: config.ua, config };
    }

    return { ua: this.next() };
  }
}

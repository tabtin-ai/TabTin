/**
 * Chrome 版本追踪器
 *
 * 🎯 目标：自动获取 Chrome 最新版本号
 * 📡 数据来源：Chrome 官方 VersionHistory API
 * ✅ 特点：支持多平台、多渠道、版本池生成
 */

import axios from 'axios';

const DEFAULT_FALLBACK_CHROME_VERSION = '141.0.0.0';

const resolveFallbackChromeVersion = (): string => {
  const runtimeVersion = process.versions?.chrome;
  if (runtimeVersion && /^\d+\.\d+\.\d+\.\d+$/.test(runtimeVersion)) {
    return runtimeVersion;
  }

  return DEFAULT_FALLBACK_CHROME_VERSION;
};

/**
 * Chrome 版本信息
 */
export interface ChromeVersion {
  /** 版本号（如 "131.0.6778.139"） */
  version: string;
  /** 平台 */
  platform: 'win' | 'mac' | 'linux' | 'android' | 'ios';
  /** 发布渠道 */
  channel: 'stable' | 'beta' | 'dev' | 'canary';
  /** 发布日期 */
  releaseDate?: string;
}

/**
 * 版本历史响应
 */
interface VersionHistoryResponse {
  versions: Array<{
    version: string;
    serving?: {
      startTime: string;
    };
  }>;
}

/**
 * Chrome 版本追踪器
 */
export class ChromeVersionTracker {
  private cache = new Map<string, ChromeVersion[]>();
  private cacheExpiry = new Map<string, number>();
  private cacheDuration = 6 * 60 * 60 * 1000; // 6小时

  /**
   * 获取 Chrome 最新稳定版本（指定平台）
   *
   * @param platform 平台（win, mac, linux, android, ios）
   * @returns Chrome 版本号
   */
  async getLatestStableVersion(platform: 'win' | 'mac' | 'linux' | 'android' | 'ios' = 'win'): Promise<string> {
    try {
      const cacheKey = `${platform}-stable`;

      // 检查缓存
      if (this.cache.has(cacheKey) && Date.now() < (this.cacheExpiry.get(cacheKey) || 0)) {
        const versions = this.cache.get(cacheKey)!;
        return versions[0].version;
      }

      console.log(`[ChromeVersionTracker] 🌐 获取 ${platform} 平台最新稳定版...`);

      const response = await axios.get<VersionHistoryResponse>(
        `https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/stable/versions`,
        {
          timeout: 5000,
          params: {
            filter: 'version,serving.startTime',
            order_by: 'version desc',
            page_size: 10,
          }
        }
      );

      if (response.data.versions && response.data.versions.length > 0) {
        const versions = response.data.versions.map(v => ({
          version: v.version,
          platform,
          channel: 'stable' as const,
          releaseDate: v.serving?.startTime,
        }));

        // 更新缓存
        this.cache.set(cacheKey, versions);
        this.cacheExpiry.set(cacheKey, Date.now() + this.cacheDuration);

        console.log(`[ChromeVersionTracker] ✅ ${platform} 最新稳定版: ${versions[0].version}`);
        return versions[0].version;
      }
    } catch (error) {
      console.warn(`[ChromeVersionTracker] 获取 ${platform} 版本失败:`, error);
    }

    // 降级：返回已知的最新版本
    return this.getFallbackVersion(platform);
  }

  /**
   * 获取最近 N 个 Chrome 版本（生成版本池）
   *
   * @param platform 平台
   * @param count 版本数量
   * @param channel 发布渠道
   * @returns Chrome 版本列表
   */
  async getRecentVersions(
    platform: 'win' | 'mac' | 'linux' | 'android' | 'ios' = 'win',
    count: number = 5,
    channel: 'stable' | 'beta' = 'stable'
  ): Promise<string[]> {
    try {
      const cacheKey = `${platform}-${channel}`;

      // 检查缓存
      if (this.cache.has(cacheKey) && Date.now() < (this.cacheExpiry.get(cacheKey) || 0)) {
        const versions = this.cache.get(cacheKey)!;
        return versions.slice(0, count).map(v => v.version);
      }

      console.log(`[ChromeVersionTracker] 🌐 获取 ${platform} 最近 ${count} 个版本...`);

      const response = await axios.get<VersionHistoryResponse>(
        `https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/${channel}/versions`,
        {
          timeout: 5000,
          params: {
            filter: 'version,serving.startTime',
            order_by: 'version desc',
            page_size: Math.max(count, 10),
          }
        }
      );

      if (response.data.versions && response.data.versions.length > 0) {
        const versions = response.data.versions.map(v => ({
          version: v.version,
          platform,
          channel,
          releaseDate: v.serving?.startTime,
        }));

        // 更新缓存
        this.cache.set(cacheKey, versions);
        this.cacheExpiry.set(cacheKey, Date.now() + this.cacheDuration);

        return versions.slice(0, count).map(v => v.version);
      }
    } catch (error) {
      console.warn(`[ChromeVersionTracker] 获取版本列表失败:`, error);
    }

    // 降级：生成静态版本池
    return this.generateVersionPool(this.getFallbackVersion(platform), count);
  }

  /**
   * 生成版本池（基于最新版本）
   *
   * 策略：最新版本往前推 N 个主版本号
   *
   * @param latestVersion 最新版本号（如 "131.0.6778.139"）
   * @param count 版本数量
   * @returns 版本列表
   */
  generateVersionPool(latestVersion: string, count: number = 5): string[] {
    const [major, minor, build, patch] = latestVersion.split('.').map(Number);
    const pool: string[] = [];

    for (let i = 0; i < count; i++) {
      const version = `${Math.max(major - i, 120)}.${minor}.${build}.${patch}`;
      pool.push(version);
    }

    return pool;
  }

  /**
   * 获取所有平台的最新版本
   */
  async getAllPlatformVersions(): Promise<Record<string, string>> {
    const platforms: Array<'win' | 'mac' | 'linux' | 'android' | 'ios'> = ['win', 'mac', 'linux', 'android', 'ios'];
    const versions: Record<string, string> = {};

    await Promise.all(
      platforms.map(async (platform) => {
        try {
          versions[platform] = await this.getLatestStableVersion(platform);
        } catch (error) {
          versions[platform] = this.getFallbackVersion(platform);
        }
      })
    );

    return versions;
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheExpiry.clear();
    console.log('[ChromeVersionTracker] 缓存已清除');
  }

  /**
   * 获取缓存信息
   */
  getCacheInfo(): Array<{
    key: string;
    size: number;
    expiresIn: number;
  }> {
    const info: Array<{ key: string; size: number; expiresIn: number }> = [];

    for (const [key, versions] of this.cache.entries()) {
      info.push({
        key,
        size: versions.length,
        expiresIn: Math.max(0, (this.cacheExpiry.get(key) || 0) - Date.now()),
      });
    }

    return info;
  }

  /**
   * 降级版本（网络失败时使用）
   */
  private getFallbackVersion(platform: string): string {
    const runtimeVersion = resolveFallbackChromeVersion();
    const fallbackVersions: Record<string, string> = {
      win: runtimeVersion,
      mac: runtimeVersion,
      linux: runtimeVersion,
      android: runtimeVersion,
      ios: runtimeVersion,
    };

    return fallbackVersions[platform] || runtimeVersion;
  }
}

/**
 * 单例实例
 */
export const sharedChromeVersionTracker = new ChromeVersionTracker();

/**
 * 便捷函数：获取最新 Chrome 版本
 */
export async function getLatestChromeVersion(platform: 'win' | 'mac' | 'linux' = 'win'): Promise<string> {
  return sharedChromeVersionTracker.getLatestStableVersion(platform);
}

/**
 * 便捷函数：生成 Chrome 版本池
 */
export async function generateChromeVersionPool(
  platform: 'win' | 'mac' | 'linux' = 'win',
  count: number = 5
): Promise<string[]> {
  return sharedChromeVersionTracker.getRecentVersions(platform, count);
}

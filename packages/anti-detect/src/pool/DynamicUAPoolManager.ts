/**
 * 动态 UA 池管理器 v2.0
 *
 * 🎯 目标：提供基于 Chrome 版本追踪的 UA 池
 * ✅ 特点：版本追踪、智能缓存、静态池降级
 *
 * 🗑️ v2.0 变更：移除在线 UA 更新（useragents.me 已停止更新）
 */

import { ChromeVersionTracker } from './ChromeVersionTracker.js';
import { WeightedDesktopUAPool } from './UAPool.js';

/**
 * 动态 UA 池配置
 */
export interface DynamicUAPoolConfig {
  /** 是否启用版本追踪 */
  enableVersionTracking?: boolean;
  /** 自动更新间隔（毫秒） */
  updateInterval?: number;
}

/**
 * UA 池状态
 */
export interface UAPoolStatus {
  /** 池大小 */
  size: number;
  /** 最后更新时间 */
  lastUpdate: Date;
  /** 下次更新时间 */
  nextUpdate: Date;
  /** Chrome 版本信息 */
  chromeVersions?: {
    latest: string;
    pool: string[];
  };
}

/**
 * 动态 UA 池管理器 v2.0
 *
 * 简化版本：仅保留版本追踪和静态池
 */
export class DynamicUAPoolManager {
  private versionTracker: ChromeVersionTracker;
  private staticPool: WeightedDesktopUAPool;
  private uaPool: string[] = [];
  private lastUpdate: Date = new Date(0);
  private updateTimer?: NodeJS.Timeout;
  private config: Required<DynamicUAPoolConfig>;

  constructor(config?: DynamicUAPoolConfig) {
    this.config = {
      enableVersionTracking: config?.enableVersionTracking ?? true,
      updateInterval: config?.updateInterval ?? 7 * 24 * 60 * 60 * 1000, // 7天
    };

    this.versionTracker = new ChromeVersionTracker();
    this.staticPool = new WeightedDesktopUAPool();
  }

  /**
   * 初始化 UA 池（立即更新）
   */
  async initialize(): Promise<void> {
    console.log('[DynamicUAPoolManager] 🚀 初始化 UA 池...');

    // 立即更新一次
    await this.updatePool();

    // 设置定时更新
    if (this.config.updateInterval > 0) {
      this.startAutoUpdate();
    }

    console.log('[DynamicUAPoolManager] ✅ 初始化完成');
  }

  /**
   * 更新 UA 池
   */
  private async updatePool(): Promise<void> {
    console.log('[DynamicUAPoolManager] 🔄 更新 UA 池...');

    try {
      if (this.config.enableVersionTracking) {
        // 尝试从版本追踪生成 UA
        await this.updateFromVersionTracker();
      } else {
        // 直接使用静态池
        this.updateFromStaticPool();
      }

      this.lastUpdate = new Date();
      console.log(`[DynamicUAPoolManager] ✅ UA 池已更新：${this.uaPool.length} 个`);
    } catch (error) {
      console.error('[DynamicUAPoolManager] ❌ 更新失败，使用静态池:', error);
      this.updateFromStaticPool();
    }
  }

  /**
   * 从版本追踪更新（优先）
   */
  private async updateFromVersionTracker(): Promise<void> {
    console.log('[DynamicUAPoolManager] 📊 从 Chrome 版本追踪更新...');

    try {
      // 获取最新版本
      const latestWin = await this.versionTracker.getLatestStableVersion('win');
      const latestMac = await this.versionTracker.getLatestStableVersion('mac');
      const latestLinux = await this.versionTracker.getLatestStableVersion('linux');

      // 生成基于最新版本的 UA
      const generatedUAs: string[] = [];

      // Windows UAs
      if (latestWin) {
        generatedUAs.push(
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${latestWin} Safari/537.36`,
          `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${latestWin} Safari/537.36 Edg/${latestWin}`
        );
      }

      // macOS UAs
      if (latestMac) {
        generatedUAs.push(
          `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${latestMac} Safari/537.36`
        );
      }

      // Linux UAs
      if (latestLinux) {
        generatedUAs.push(
          `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${latestLinux} Safari/537.36`
        );
      }

      if (generatedUAs.length > 0) {
        // 合并生成的 UA 和静态池（取前10个）
        const staticUAs = this.staticPool.getAllUA().slice(0, 10);
        this.uaPool = [...generatedUAs, ...staticUAs];
        console.log(`[DynamicUAPoolManager] ✅ 版本追踪成功：${generatedUAs.length} 个最新 UA`);
      } else {
        // 降级到静态池
        console.warn('[DynamicUAPoolManager] ⚠️ 版本追踪无数据，降级到静态池');
        this.updateFromStaticPool();
      }
    } catch (error) {
      console.error('[DynamicUAPoolManager] ❌ 版本追踪失败，降级到静态池:', error);
      this.updateFromStaticPool();
    }
  }

  /**
   * 从静态池更新（降级）
   */
  private updateFromStaticPool(): void {
    console.log('[DynamicUAPoolManager] 📦 使用静态 UA 池...');
    // 获取所有 UA，随机打乱并取前20个
    const allUAs = this.staticPool.getAllUA();
    this.uaPool = allUAs.sort(() => Math.random() - 0.5).slice(0, 20);
    console.log(`[DynamicUAPoolManager] ✅ 静态池加载完成：${this.uaPool.length} 个`);
  }

  /**
   * 启动自动更新
   */
  private startAutoUpdate(): void {
    console.log(`[DynamicUAPoolManager] ⏰ 启动自动更新（间隔：${this.config.updateInterval / 1000 / 60 / 60}小时）`);

    this.updateTimer = setInterval(async () => {
      console.log('[DynamicUAPoolManager] 🔄 执行定时更新...');
      await this.updatePool();
    }, this.config.updateInterval);
  }

  /**
   * 停止自动更新
   */
  stopAutoUpdate(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
      console.log('[DynamicUAPoolManager] ⏹️ 已停止自动更新');
    }
  }

  /**
   * 获取随机 UA
   */
  getRandomUA(): string | undefined {
    if (this.uaPool.length === 0) {
      console.warn('[DynamicUAPoolManager] ⚠️ UA 池为空，返回静态 UA');
      return this.staticPool.next();
    }

    const index = Math.floor(Math.random() * this.uaPool.length);
    return this.uaPool[index];
  }

  /**
   * 批量获取随机 UA
   */
  getRandomUAs(count: number): string[] {
    if (this.uaPool.length === 0) {
      console.warn('[DynamicUAPoolManager] ⚠️ UA 池为空，返回静态 UA');
      // 从静态池随机选择
      const allUAs = this.staticPool.getAllUA();
      const result: string[] = [];
      for (let i = 0; i < count && i < allUAs.length; i++) {
        result.push(this.staticPool.next());
      }
      return result;
    }

    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const ua = this.getRandomUA();
      if (ua) result.push(ua);
    }
    return result;
  }

  /**
   * 按平台筛选 UA
   */
  getUAsByPlatform(platform: 'windows' | 'macos' | 'linux'): string[] {
    let platformFilter: string;
    switch (platform) {
      case 'windows':
        platformFilter = 'Windows';
        break;
      case 'macos':
        platformFilter = 'Macintosh';
        break;
      case 'linux':
        platformFilter = 'Linux';
        break;
    }

    const filtered = this.uaPool.filter(ua => ua.includes(platformFilter));

    if (filtered.length === 0) {
      console.warn(`[DynamicUAPoolManager] ⚠️ 没有找到 ${platform} 的 UA，返回静态池`);
      // 从静态池筛选
      let osFilter: 'Windows' | 'macOS' | 'Linux';
      switch (platform) {
        case 'windows':
          osFilter = 'Windows';
          break;
        case 'macos':
          osFilter = 'macOS';
          break;
        case 'linux':
          osFilter = 'Linux';
          break;
      }
      return this.staticPool.filterByOS(osFilter).getAllUA();
    }

    return filtered;
  }

  /**
   * 获取池状态
   */
  getStatus(): UAPoolStatus {
    const nextUpdate = new Date(this.lastUpdate.getTime() + this.config.updateInterval);

    return {
      size: this.uaPool.length,
      lastUpdate: this.lastUpdate,
      nextUpdate,
      chromeVersions: this.config.enableVersionTracking
        ? {
            latest: 'tracked',
            pool: this.uaPool.slice(0, 5), // 前5个
          }
        : undefined,
    };
  }

  /**
   * 手动刷新池
   */
  async refresh(): Promise<void> {
    console.log('[DynamicUAPoolManager] 🔄 手动刷新 UA 池...');
    await this.updatePool();
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stopAutoUpdate();
    this.uaPool = [];
    console.log('[DynamicUAPoolManager] 🗑️ 资源已清理');
  }
}

/**
 * 单例实例（方便使用）
 */
let defaultInstance: DynamicUAPoolManager | null = null;

/**
 * 获取默认实例
 */
export function getDefaultManager(): DynamicUAPoolManager {
  if (!defaultInstance) {
    defaultInstance = new DynamicUAPoolManager({
      enableVersionTracking: true,
      updateInterval: 7 * 24 * 60 * 60 * 1000, // 7天
    });
  }
  return defaultInstance;
}

/**
 * 重置默认实例
 */
export function resetDefaultManager(): void {
  if (defaultInstance) {
    defaultInstance.dispose();
    defaultInstance = null;
  }
}

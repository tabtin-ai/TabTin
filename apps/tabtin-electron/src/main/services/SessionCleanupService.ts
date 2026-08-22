/**
 * Session 清理服务
 *
 * 统一管理页面 WebContents 和 Session 的清理逻辑
 * 确保清理行为一致且可靠
 *
 * @example
 * ```typescript
 * // 清理单个 View
 * await SessionCleanupService.cleanupView(view);
 *
 * // 清理 Session
 * await SessionCleanupService.cleanupSession(session);
 *
 * // 带进度回调的清理
 * await SessionCleanupService.cleanupView(view, (step, progress) => {
 *   console.log(`清理步骤: ${step}, 进度: ${progress}%`);
 * });
 * ```
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import type { WebContents, Session } from 'electron';
import { createLogger } from '../logger';

const log = createLogger('SessionCleanup');

type ClearStorageDataOptions = NonNullable<Parameters<Session['clearStorageData']>[0]>;
type SessionStorageType = NonNullable<ClearStorageDataOptions['storages']>[number];

/**
 * 清理进度回调
 */
export type CleanupProgressCallback = (step: string, progress: number) => void;

/**
 * 清理选项
 */
export interface CleanupOptions {
  /** 是否清理缓存 */
  clearCache?: boolean;

  /** 是否清理 Cookies */
  clearCookies?: boolean;

  /** 是否清理 LocalStorage */
  clearLocalStorage?: boolean;

  /** 是否清理 IndexedDB */
  clearIndexedDB?: boolean;

  /** 是否清理 Service Workers */
  clearServiceWorkers?: boolean;

  /** 是否导航到空白页 */
  navigateToBlank?: boolean;

  /** 进度回调 */
  onProgress?: CleanupProgressCallback;
}

/**
 * 默认清理选项（清理所有）
 */
const DEFAULT_CLEANUP_OPTIONS: Required<Omit<CleanupOptions, 'onProgress'>> = {
  clearCache: true,
  clearCookies: true,
  clearLocalStorage: true,
  clearIndexedDB: true,
  clearServiceWorkers: true,
  navigateToBlank: true
};

/**
 * Session 清理服务
 */
export class SessionCleanupService {
  /**
   * 清理页面 WebContents 及其 Session
   *
   * @param webContents 页面 WebContents 实例
   * @param options 清理选项（默认清理所有）
   *
   * @example
   * ```typescript
   * // 默认清理（清理所有）
   * await SessionCleanupService.cleanupView(view);
   *
   * // 只清理 cookies 和缓存
   * await SessionCleanupService.cleanupView(view, {
   *   clearCache: true,
   *   clearCookies: true,
   *   clearLocalStorage: false,
   *   clearIndexedDB: false,
   *   clearServiceWorkers: false,
   *   navigateToBlank: false
   * });
   * ```
   */
  static async cleanupView(
    webContents: WebContents,
    options?: CleanupOptions
  ): Promise<void> {
    const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
    const session = webContents.session;
    const totalSteps = this.countSteps(opts);
    let currentStep = 0;

    try {
      log.info('开始清理 View', { steps: totalSteps });

      // 1. 清理缓存
      if (opts.clearCache) {
        this.reportProgress(opts.onProgress, '清理缓存', ++currentStep, totalSteps);
        await session.clearCache();
        log.debug('✅ 缓存已清理');
      }

      // 2. 清理存储数据
      const storages: SessionStorageType[] = [];
      if (opts.clearCookies) storages.push('cookies');
      if (opts.clearLocalStorage) storages.push('localstorage');
      if (opts.clearIndexedDB) storages.push('indexdb');
      if (opts.clearServiceWorkers) storages.push('serviceworkers');

      storages.push('websql', 'cachestorage'); // 总是清理这些

      if (storages.length > 0) {
        this.reportProgress(opts.onProgress, '清理存储数据', ++currentStep, totalSteps);
        await session.clearStorageData({ storages });
        log.debug('✅ 存储数据已清理:', storages);
      }

      // 3. 导航到空白页
      if (opts.navigateToBlank) {
        this.reportProgress(opts.onProgress, '重置页面', ++currentStep, totalSteps);
        await webContents.loadURL('about:blank');
        log.debug('✅ 已导航到空白页');
      }

      this.reportProgress(opts.onProgress, '完成', totalSteps, totalSteps);
      log.info('🎉 View 清理完成');
    } catch (error) {
      // 不抛出异常，避免阻塞后续流程；仅记录以便诊断
      log.error('❌ 清理 View 失败:', error);
    }
  }

  /**
   * 清理 Session
   *
   * @param session Electron Session 实例
   * @param options 清理选项
   *
   * @example
   * ```typescript
   * const session = require('electron').session.defaultSession;
   * await SessionCleanupService.cleanupSession(session);
   * ```
   */
  static async cleanupSession(
    session: Session,
    options?: Omit<CleanupOptions, 'navigateToBlank'>
  ): Promise<void> {
    const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
    const totalSteps = this.countSteps(opts) - (opts.navigateToBlank ? 1 : 0);
    let currentStep = 0;

    try {
      log.info('开始清理 Session', { steps: totalSteps });

      // 1. 清理缓存
      if (opts.clearCache) {
        this.reportProgress(opts.onProgress, '清理缓存', ++currentStep, totalSteps);
        await session.clearCache();
        log.debug('✅ 缓存已清理');
      }

      // 2. 清理存储数据
      const storages: SessionStorageType[] = [];
      if (opts.clearCookies) storages.push('cookies');
      if (opts.clearLocalStorage) storages.push('localstorage');
      if (opts.clearIndexedDB) storages.push('indexdb');
      if (opts.clearServiceWorkers) storages.push('serviceworkers');

      storages.push('websql', 'cachestorage');

      if (storages.length > 0) {
        this.reportProgress(opts.onProgress, '清理存储数据', ++currentStep, totalSteps);
        await session.clearStorageData({ storages });
        log.debug('✅ 存储数据已清理:', storages);
      }

      this.reportProgress(opts.onProgress, '完成', totalSteps, totalSteps);
      log.info('🎉 Session 清理完成');
    } catch (error) {
      // 不抛出异常，避免阻塞后续流程；仅记录以便诊断
      log.error('❌ 清理 Session 失败:', error);
    }
  }

  /**
   * 快速清理（只清理 cookies 和缓存）
   *
   * @param webContents 页面 WebContents 实例
   *
   * @example
   * ```typescript
   * await SessionCleanupService.quickCleanup(view);
   * ```
   */
  static async quickCleanup(webContents: WebContents): Promise<void> {
    await this.cleanupView(webContents, {
      clearCache: true,
      clearCookies: true,
      clearLocalStorage: false,
      clearIndexedDB: false,
      clearServiceWorkers: false,
      navigateToBlank: false
    });
  }

  /**
   * 深度清理（清理所有数据并重置）
   *
   * @param webContents 页面 WebContents 实例
   * @param onProgress 进度回调
   *
   * @example
   * ```typescript
   * await SessionCleanupService.deepCleanup(view, (step, progress) => {
   *   console.log(`${step}: ${progress}%`);
   * });
   * ```
   */
  static async deepCleanup(
    webContents: WebContents,
    onProgress?: CleanupProgressCallback
  ): Promise<void> {
    await this.cleanupView(webContents, {
      ...DEFAULT_CLEANUP_OPTIONS,
      onProgress
    });
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 计算总步骤数
   */
  private static countSteps(options: Required<Omit<CleanupOptions, 'onProgress'>>): number {
    let steps = 0;
    if (options.clearCache) steps++;
    if (options.clearCookies ||
        options.clearLocalStorage ||
        options.clearIndexedDB ||
        options.clearServiceWorkers) steps++;
    if (options.navigateToBlank) steps++;
    return steps;
  }

  /**
   * 报告进度
   */
  private static reportProgress(
    callback: CleanupProgressCallback | undefined,
    step: string,
    current: number,
    total: number
  ): void {
    if (callback) {
      const progress = Math.round((current / total) * 100);
      callback(step, progress);
    }
  }
}

// 导出便捷方法
export const {
  cleanupView,
  cleanupSession,
  quickCleanup,
  deepCleanup
} = SessionCleanupService;

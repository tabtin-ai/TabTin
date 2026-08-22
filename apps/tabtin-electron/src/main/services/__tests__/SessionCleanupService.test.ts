/**
 * SessionCleanupService 单元测试
 *
 * 测试覆盖：
 * - cleanupView() 方法
 * - cleanupSession() 方法
 * - quickCleanup() 方法
 * - deepCleanup() 方法
 * - 进度回调
 * - 错误处理
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionCleanupService } from '../SessionCleanupService';
import type { CleanupOptions } from '../SessionCleanupService';

// Mock Electron WebContents（: cleanup 系列已从 WebContentsView 收窄为 WebContents）
const createMockWebContentsView = () => {
  const webContents = {
    session: {
      clearCache: vi.fn().mockResolvedValue(undefined),
      clearStorageData: vi.fn().mockResolvedValue(undefined)
    },
    loadURL: vi.fn().mockResolvedValue(undefined)
  };
  return webContents;
};

// Mock Electron Session
const createMockSession = () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
  clearStorageData: vi.fn().mockResolvedValue(undefined)
});

describe('SessionCleanupService', () => {
  describe('cleanupView()', () => {
    it('应该默认清理所有数据', async () => {
      const mockView = createMockWebContentsView();
      await SessionCleanupService.cleanupView(mockView as any);

      expect(mockView.session.clearCache).toHaveBeenCalled();
      expect(mockView.session.clearStorageData).toHaveBeenCalledWith({
        storages: expect.arrayContaining([
          'cookies',
          'localstorage',
          'indexdb',
          'serviceworkers',
          'websql',
          'cachestorage'
        ])
      });
      expect(mockView.loadURL).toHaveBeenCalledWith('about:blank');
    });

    it('应该支持选择性清理', async () => {
      const mockView = createMockWebContentsView();
      const options: CleanupOptions = {
        clearCache: true,
        clearCookies: true,
        clearLocalStorage: false,
        clearIndexedDB: false,
        clearServiceWorkers: false,
        navigateToBlank: false
      };

      await SessionCleanupService.cleanupView(mockView as any, options);

      expect(mockView.session.clearCache).toHaveBeenCalled();
      expect(mockView.session.clearStorageData).toHaveBeenCalledWith({
        storages: expect.arrayContaining(['cookies', 'websql', 'cachestorage'])
      });
      expect(mockView.loadURL).not.toHaveBeenCalled();
    });

    it('应该在清理失败时不抛出异常', async () => {
      const mockView = {
        session: {
          clearCache: vi.fn().mockRejectedValue(new Error('Clear failed')),
          clearStorageData: vi.fn().mockResolvedValue(undefined)
        },
        loadURL: vi.fn().mockResolvedValue(undefined)
      };

      // 不应该抛出异常
      await expect(
        SessionCleanupService.cleanupView(mockView as any)
      ).resolves.toBeUndefined();
    });

    it('应该调用进度回调', async () => {
      const mockView = createMockWebContentsView();
      const onProgress = vi.fn();

      await SessionCleanupService.cleanupView(mockView as any, { onProgress });

      expect(onProgress).toHaveBeenCalled();
      expect(onProgress.mock.calls.length).toBeGreaterThan(0);

      // 验证最后一次调用是"完成"
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall[0]).toBe('完成');
      expect(lastCall[1]).toBe(100);
    });

    it('应该正确计算清理步骤', async () => {
      const mockView = createMockWebContentsView();
      const onProgress = vi.fn();
      const options: CleanupOptions = {
        clearCache: true,
        clearCookies: true,
        clearLocalStorage: false,
        clearIndexedDB: false,
        clearServiceWorkers: false,
        navigateToBlank: true,
        onProgress
      };

      await SessionCleanupService.cleanupView(mockView as any, options);

      // 应该有 3 个步骤：缓存 + 存储数据 + 导航，回调签名 (step, progress%)
      expect(onProgress).toHaveBeenCalledWith('清理缓存', expect.any(Number));
      expect(onProgress).toHaveBeenCalledWith('清理存储数据', expect.any(Number));
      expect(onProgress).toHaveBeenCalledWith('重置页面', expect.any(Number));
      expect(onProgress).toHaveBeenCalledWith('完成', 100);
    });
  });

  describe('cleanupSession()', () => {
    it('应该清理 Session（不包括导航）', async () => {
      const mockSession = createMockSession();
      await SessionCleanupService.cleanupSession(mockSession as any);

      expect(mockSession.clearCache).toHaveBeenCalled();
      expect(mockSession.clearStorageData).toHaveBeenCalled();
    });

    it('应该支持选择性清理', async () => {
      const mockSession = createMockSession();
      const options = {
        clearCache: true,
        clearCookies: false,
        clearLocalStorage: false,
        clearIndexedDB: false,
        clearServiceWorkers: false
      };

      await SessionCleanupService.cleanupSession(mockSession as any, options);

      expect(mockSession.clearCache).toHaveBeenCalled();
      expect(mockSession.clearStorageData).toHaveBeenCalled();
    });

    it('应该调用进度回调', async () => {
      const mockSession = createMockSession();
      const onProgress = vi.fn();

      await SessionCleanupService.cleanupSession(mockSession as any, { onProgress });

      expect(onProgress).toHaveBeenCalled();
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      expect(lastCall[0]).toBe('完成');
    });

    it('应该在清理失败时不抛出异常', async () => {
      const mockSession = {
        clearCache: vi.fn().mockRejectedValue(new Error('Clear failed')),
        clearStorageData: vi.fn().mockResolvedValue(undefined)
      };

      await expect(
        SessionCleanupService.cleanupSession(mockSession as any)
      ).resolves.toBeUndefined();
    });
  });

  describe('quickCleanup()', () => {
    it('应该只清理 cookies 和缓存', async () => {
      const mockView = createMockWebContentsView();
      await SessionCleanupService.quickCleanup(mockView as any);

      expect(mockView.session.clearCache).toHaveBeenCalled();
      expect(mockView.session.clearStorageData).toHaveBeenCalledWith({
        storages: expect.arrayContaining(['cookies'])
      });
      expect(mockView.loadURL).not.toHaveBeenCalled();
    });
  });

  describe('deepCleanup()', () => {
    it('应该清理所有数据', async () => {
      const mockView = createMockWebContentsView();
      await SessionCleanupService.deepCleanup(mockView as any);

      expect(mockView.session.clearCache).toHaveBeenCalled();
      expect(mockView.session.clearStorageData).toHaveBeenCalled();
      expect(mockView.loadURL).toHaveBeenCalledWith('about:blank');
    });

    it('应该支持进度回调', async () => {
      const mockView = createMockWebContentsView();
      const onProgress = vi.fn();

      await SessionCleanupService.deepCleanup(mockView as any, onProgress);

      expect(onProgress).toHaveBeenCalled();
    });
  });

  describe('导出的便捷方法', () => {
    it('应该导出所有静态方法', async () => {
      const mod = await import('../SessionCleanupService');

      expect(typeof mod.cleanupView).toBe('function');
      expect(typeof mod.cleanupSession).toBe('function');
      expect(typeof mod.quickCleanup).toBe('function');
      expect(typeof mod.deepCleanup).toBe('function');
    });
  });

  describe('集成场景', () => {
    it('应该支持 WebContentsViewPool 的重置场景', async () => {
      const mockView = createMockWebContentsView();

      // 模拟池化复用场景：完全重置 View
      await SessionCleanupService.cleanupView(mockView as any);

      expect(mockView.session.clearCache).toHaveBeenCalled();
      expect(mockView.session.clearStorageData).toHaveBeenCalled();
      expect(mockView.loadURL).toHaveBeenCalledWith('about:blank');
    });

    it('应该支持快速清理场景（不阻塞用户）', async () => {
      const mockView = createMockWebContentsView();

      // 模拟快速清理：只清理关键数据
      const start = Date.now();
      await SessionCleanupService.quickCleanup(mockView as any);
      const duration = Date.now() - start;

      // 快速清理应该很快完成（< 1秒）
      expect(duration).toBeLessThan(1000);
      expect(mockView.loadURL).not.toHaveBeenCalled();
    });
  });

  describe('边界情况', () => {
    it('应该处理 View 已销毁的情况', async () => {
      const mockView = {
        session: {
          clearCache: vi.fn().mockRejectedValue(new Error('View destroyed')),
          clearStorageData: vi.fn().mockRejectedValue(new Error('View destroyed'))
        },
        loadURL: vi.fn().mockRejectedValue(new Error('View destroyed'))
      };

      // 不应该抛出异常
      await expect(
        SessionCleanupService.cleanupView(mockView as any)
      ).resolves.toBeUndefined();
    });

    it('应该处理空选项', async () => {
      const mockView = createMockWebContentsView();
      await SessionCleanupService.cleanupView(mockView as any, {});

      // 应该使用默认选项（清理所有）
      expect(mockView.session.clearCache).toHaveBeenCalled();
    });

    it('应该处理所有选项为 false 的情况', async () => {
      const mockView = createMockWebContentsView();
      const options: CleanupOptions = {
        clearCache: false,
        clearCookies: false,
        clearLocalStorage: false,
        clearIndexedDB: false,
        clearServiceWorkers: false,
        navigateToBlank: false
      };

      await SessionCleanupService.cleanupView(mockView as any, options);

      // 不应该执行任何清理操作
      expect(mockView.session.clearCache).not.toHaveBeenCalled();
      expect(mockView.loadURL).not.toHaveBeenCalled();
    });
  });
});

/**
 * SessionConfigFactory 单元测试
 *
 * 测试覆盖：
 * - createWebPreferences() 方法
 * - forEmbedded() 方法
 * - forCrawl() 方法
 * - forAccount() 方法
 * - forTemporary() 方法
 * - forDebug() 方法
 * - validateConfig() 方法
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import { describe, it, expect } from 'vitest';
import {
  SessionConfigFactory,
  createWebPreferences,
  forEmbedded,
  forCrawl,
  forAccount,
  forTemporary,
  forDebug,
  custom,
  describeConfig,
  validateConfig,
} from '../SessionConfigFactory';

describe('SessionConfigFactory', () => {
  describe('createWebPreferences()', () => {
    it('应该返回默认的安全配置', () => {
      const config = SessionConfigFactory.createWebPreferences();

      expect(config.nodeIntegration).toBe(false);
      expect(config.contextIsolation).toBe(true);
      expect(config.sandbox).toBe(true);
      expect(config.webSecurity).toBe(true);
      expect(config.partition).toBeUndefined();
      expect((config as any).focusOnNavigation).toBe(false);
    });

    it('应该支持独立 session（持久化）', () => {
      const config = SessionConfigFactory.createWebPreferences({
        isolated: true,
        partition: 'test-session',
        persistent: true
      });

      expect(config.partition).toBe('persist:test-session');
    });

    it('应该支持独立 session（非持久化）', () => {
      const config = SessionConfigFactory.createWebPreferences({
        isolated: true,
        partition: 'temp-session',
        persistent: false
      });

      expect(config.partition).toBe('temp-session');
    });

    it('应该支持自定义安全配置', () => {
      const config = SessionConfigFactory.createWebPreferences({
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false,
        focusOnNavigation: true,
      });

      expect(config.nodeIntegration).toBe(true);
      expect(config.contextIsolation).toBe(false);
      expect(config.sandbox).toBe(false);
      expect(config.webSecurity).toBe(false);
      expect((config as any).focusOnNavigation).toBe(true);
    });

    it('应该在 isolated=false 时不设置 partition', () => {
      const config = SessionConfigFactory.createWebPreferences({
        isolated: false,
        partition: 'ignored'
      });

      expect(config.partition).toBeUndefined();
    });
  });

  describe('forEmbedded()', () => {
    it('应该返回共享 session 配置', () => {
      const config = SessionConfigFactory.forEmbedded();

      expect(config.partition).toBeUndefined();
      expect(config.nodeIntegration).toBe(false);
      expect(config.contextIsolation).toBe(true);
      expect(config.sandbox).toBe(true);
      expect(config.webSecurity).toBe(true);
      expect((config as any).focusOnNavigation).toBe(false);
    });
  });

  describe('forCrawl()', () => {
    it('应该默认使用共享 session', () => {
      const config = SessionConfigFactory.forCrawl('task-123');

      expect(config.partition).toBeUndefined();
    });

    it('应该支持独立 session', () => {
      const config = SessionConfigFactory.forCrawl('task-123', true);

      expect(config.partition).toBe('persist:task-task-123');
    });

    it('应该使用持久化存储', () => {
      const config = SessionConfigFactory.forCrawl('task-123', true);

      // 持久化的 partition 以 'persist:' 开头
      expect(config.partition?.startsWith('persist:')).toBe(true);
    });
  });

  describe('forAccount()', () => {
    it('应该使用独立 session', () => {
      const config = SessionConfigFactory.forAccount('user-123');

      expect(config.partition).toBe('persist:account-user-123');
    });

    it('应该使用持久化存储', () => {
      const config = SessionConfigFactory.forAccount('user-123');

      expect(config.partition?.startsWith('persist:')).toBe(true);
    });
  });

  describe('forTemporary()', () => {
    it('应该使用独立 session', () => {
      const config = SessionConfigFactory.forTemporary('temp-123');

      expect(config.partition).toBe('temp-temp-123');
    });

    it('应该使用非持久化存储', () => {
      const config = SessionConfigFactory.forTemporary('temp-123');

      // 非持久化的 partition 不以 'persist:' 开头
      expect(config.partition?.startsWith('persist:')).toBe(false);
    });
  });

  describe('forDebug()', () => {
    it('应该默认使用共享 session 和沙箱', () => {
      const config = SessionConfigFactory.forDebug();

      expect(config.partition).toBeUndefined();
      expect(config.sandbox).toBe(true);
      expect(config.webSecurity).toBe(true);
    });

    it('应该支持禁用沙箱', () => {
      const config = SessionConfigFactory.forDebug(true);

      expect(config.sandbox).toBe(false);
      expect(config.webSecurity).toBe(false);
    });
  });

  describe('custom()', () => {
    it('应该支持完全自定义配置', () => {
      const config = SessionConfigFactory.custom({
        isolated: true,
        partition: 'custom-session',
        persistent: true,
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false
      });

      expect(config.partition).toBe('persist:custom-session');
      expect(config.nodeIntegration).toBe(true);
      expect(config.contextIsolation).toBe(false);
    });
  });

  describe('describeConfig()', () => {
    it('应该描述默认 session', () => {
      const config = SessionConfigFactory.forEmbedded();
      const description = SessionConfigFactory.describeConfig(config);

      expect(description).toBe('使用默认 session，共享 cookies');
    });

    it('应该描述持久化 session', () => {
      const config = SessionConfigFactory.forAccount('user-123');
      const description = SessionConfigFactory.describeConfig(config);

      expect(description).toBe('使用独立 session: account-user-123（持久化）');
    });

    it('应该描述临时 session', () => {
      const config = SessionConfigFactory.forTemporary('temp-123');
      const description = SessionConfigFactory.describeConfig(config);

      expect(description).toBe('使用独立 session: temp-temp-123（临时）');
    });
  });

  describe('validateConfig()', () => {
    it('应该通过安全配置验证', () => {
      const config = SessionConfigFactory.forEmbedded();
      const result = SessionConfigFactory.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('应该检测不安全的 nodeIntegration 配置', () => {
      const config = SessionConfigFactory.createWebPreferences({
        nodeIntegration: true,
        contextIsolation: false
      });
      const result = SessionConfigFactory.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('启用 nodeIntegration 必须同时启用 contextIsolation');
    });

    it('应该检测不安全的 sandbox 配置', () => {
      const config = SessionConfigFactory.createWebPreferences({
        sandbox: false,
        webSecurity: undefined
      });
      const result = SessionConfigFactory.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('应该检测无效的 partition 格式', () => {
      const config = { partition: 'Invalid_Partition!' };
      const result = SessionConfigFactory.validateConfig(config as any);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('无效的 partition 格式'))).toBe(true);
    });

    it('应该通过有效的 partition 格式', () => {
      const config1 = { partition: 'valid-partition' };
      const result1 = SessionConfigFactory.validateConfig(config1 as any);
      expect(result1.valid).toBe(true);

      const config2 = { partition: 'persist:valid-partition' };
      const result2 = SessionConfigFactory.validateConfig(config2 as any);
      expect(result2.valid).toBe(true);
    });
  });

  describe('导出的便捷方法', () => {
    it('应该导出所有静态方法', () => {
      expect(typeof createWebPreferences).toBe('function');
      expect(typeof forEmbedded).toBe('function');
      expect(typeof forCrawl).toBe('function');
      expect(typeof forAccount).toBe('function');
      expect(typeof forTemporary).toBe('function');
      expect(typeof forDebug).toBe('function');
      expect(typeof custom).toBe('function');
      expect(typeof describeConfig).toBe('function');
      expect(typeof validateConfig).toBe('function');
    });
  });

  describe('集成场景', () => {
    it('应该支持嵌入式视图 → 抓取任务（共享登录状态）', () => {
      const embeddedConfig = SessionConfigFactory.forEmbedded();
      const crawlConfig = SessionConfigFactory.forCrawl('task-123', false);

      // 两者都使用默认 session，共享登录状态
      expect(embeddedConfig.partition).toBeUndefined();
      expect(crawlConfig.partition).toBeUndefined();
    });

    it('应该支持多账号隔离', () => {
      const account1 = SessionConfigFactory.forAccount('user-1');
      const account2 = SessionConfigFactory.forAccount('user-2');

      // 不同账号使用不同 partition
      expect(account1.partition).not.toBe(account2.partition);
      expect(account1.partition).toBe('persist:account-user-1');
      expect(account2.partition).toBe('persist:account-user-2');
    });

    it('应该支持临时任务隔离', () => {
      const tempConfig = SessionConfigFactory.forTemporary('temp-123');
      const embeddedConfig = SessionConfigFactory.forEmbedded();

      // 临时任务使用独立 session，不影响主 session
      expect(tempConfig.partition).toBe('temp-temp-123');
      expect(embeddedConfig.partition).toBeUndefined();
    });
  });
});

/**
 * Session 配置工厂
 *
 * 统一创建 WebContentsView 的 WebPreferences 配置
 * 确保所有 View 的 Session 配置一致且可维护
 *
 * @example
 * ```typescript
 * // 为嵌入式视图创建配置
 * const view = new WebContentsView({
 *   webPreferences: SessionConfigFactory.forEmbedded()
 * });
 *
 * // 为抓取任务创建配置
 * const view = new WebContentsView({
 *   webPreferences: SessionConfigFactory.forCrawl(taskId)
 * });
 *
 * // 为独立账号创建配置
 * const view = new WebContentsView({
 *   webPreferences: SessionConfigFactory.forAccount(accountId)
 * });
 * ```
 *
 * @author TabTin Team
 * @date 2025-11-21
 */

import type { WebPreferences } from 'electron';

/**
 * Session 配置选项
 */
export interface SessionConfig {
  /** 是否使用独立 session（partition） */
  isolated?: boolean;

  /** Session 分区名称 */
  partition?: string;

  /** 是否持久化（persist） */
  persistent?: boolean;

  /** 用户代理 */
  userAgent?: string;

  /** 是否启用 Node.js 集成 */
  nodeIntegration?: boolean;

  /** 是否启用上下文隔离 */
  contextIsolation?: boolean;

  /** 是否启用沙箱 */
  sandbox?: boolean;

  /** 是否启用 Web 安全 */
  webSecurity?: boolean;

  /** 导航时是否自动抢占焦点 */
  focusOnNavigation?: boolean;
}

/**
 * Session 配置工厂类
 */
export class SessionConfigFactory {
  /**
   * 创建标准的 WebPreferences 配置
   *
   * @param config Session 配置选项
   * @returns Electron WebPreferences
   *
   * @example
   * ```typescript
   * const prefs = SessionConfigFactory.createWebPreferences({
   *   isolated: true,
   *   partition: 'my-session',
   *   persistent: true
   * });
   * ```
   */
  static createWebPreferences(config?: SessionConfig): WebPreferences {
    // 基础安全配置（所有 View 都应该使用）
    const baseConfig: WebPreferences = {
      nodeIntegration: config?.nodeIntegration ?? false,
      contextIsolation: config?.contextIsolation ?? true,
      sandbox: config?.sandbox ?? true,
      webSecurity: config?.webSecurity ?? true,
    };

    // Electron 41 开始可用的焦点控制项；旧版本会忽略额外字段。
    (baseConfig as Record<string, unknown>).focusOnNavigation = config?.focusOnNavigation ?? false

    // 如果需要独立 session
    if (config?.isolated && config.partition) {
      const persistent = config.persistent ?? true;
      const prefix = persistent ? 'persist:' : '';
      baseConfig.partition = `${prefix}${config.partition}`;
    }
    // 否则使用默认 session（共享 cookies）

    return baseConfig;
  }

  /**
   * 为嵌入式视图创建配置
   *
   * 特点：
   * - 使用默认 session（共享登录状态）
   * - 用户在此登录后，所有视图都能访问 cookies
   *
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * const embeddedView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forEmbedded()
   * });
   * ```
   */
  static forEmbedded(): WebPreferences {
    return this.createWebPreferences({
      isolated: false,  // 共享 session
      focusOnNavigation: false,
    });
  }

  /**
   * 为抓取任务创建配置
   *
   * @param taskId 任务 ID
   * @param isolated 是否隔离（默认 false，共享登录状态）
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * // 共享登录状态的抓取任务（默认）
   * const view = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forCrawl(taskId)
   * });
   *
   * // 隔离的抓取任务（独立 cookies）
   * const isolatedView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forCrawl(taskId, true)
   * });
   * ```
   */
  static forCrawl(taskId: string, isolated: boolean = false): WebPreferences {
    return this.createWebPreferences({
      isolated,
      partition: isolated ? `task-${taskId}` : undefined,
      persistent: true,  // 持久化，便于调试
      focusOnNavigation: false,
    });
  }

  /**
   * 为独立账号创建配置
   *
   * 特点：
   * - 使用独立 session（隔离 cookies）
   * - 支持多账号并行抓取
   * - 持久化存储
   *
   * @param accountId 账号 ID
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * const accountView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forAccount('user-123')
   * });
   * ```
   */
  static forAccount(accountId: string): WebPreferences {
    return this.createWebPreferences({
      isolated: true,
      partition: `account-${accountId}`,
      persistent: true,
      focusOnNavigation: false,
    });
  }

  /**
   * 为临时任务创建配置
   *
   * 特点：
   * - 使用独立 session（隔离 cookies）
   * - 非持久化（任务结束后自动清理）
   *
   * @param taskId 任务 ID
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * const tempView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forTemporary(taskId)
   * });
   * ```
   */
  static forTemporary(taskId: string): WebPreferences {
    return this.createWebPreferences({
      isolated: true,
      partition: `temp-${taskId}`,
      persistent: false,  // 非持久化
      focusOnNavigation: false,
    });
  }

  /**
   * 为调试窗口创建配置
   *
   * 特点：
   * - 使用默认 session（方便查看用户状态）
   * - 可以选择性禁用沙箱（便于调试）
   *
   * @param disableSandbox 是否禁用沙箱（默认 false）
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * const debugView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.forDebug()
   * });
   * ```
   */
  static forDebug(disableSandbox: boolean = false): WebPreferences {
    return this.createWebPreferences({
      isolated: false,
      sandbox: !disableSandbox,
      webSecurity: !disableSandbox,
      focusOnNavigation: false,
    });
  }

  /**
   * 自定义配置（高级用法）
   *
   * @param config 完整的 Session 配置
   * @returns WebPreferences 配置
   *
   * @example
   * ```typescript
   * const customView = new WebContentsView({
   *   webPreferences: SessionConfigFactory.custom({
   *     isolated: true,
   *     partition: 'custom-session',
   *     persistent: true,
   *     userAgent: 'CustomBot/1.0'
   *   })
   * });
   * ```
   */
  static custom(config: SessionConfig): WebPreferences {
    return this.createWebPreferences(config);
  }

  /**
   * 获取配置说明
   *
   * @param config WebPreferences 配置
   * @returns 配置说明文本
   *
   * @example
   * ```typescript
   * const prefs = SessionConfigFactory.forEmbedded();
   * console.log(SessionConfigFactory.describeConfig(prefs));
   * // 输出：使用默认 session，共享 cookies
   * ```
   */
  static describeConfig(config: WebPreferences): string {
    if (!config.partition) {
      return '使用默认 session，共享 cookies';
    }

    const isPersistent = config.partition.startsWith('persist:');
    const partitionName = isPersistent
      ? config.partition.substring(8)
      : config.partition;

    return isPersistent
      ? `使用独立 session: ${partitionName}（持久化）`
      : `使用独立 session: ${partitionName}（临时）`;
  }

  /**
   * 验证配置是否有效
   *
   * @param config WebPreferences 配置
   * @returns 验证结果
   */
  static validateConfig(config: WebPreferences): {
    valid: boolean;
    errors: string[]
  } {
    const errors: string[] = [];

    // 安全检查
    if (config.nodeIntegration && !config.contextIsolation) {
      errors.push('启用 nodeIntegration 必须同时启用 contextIsolation');
    }

    if (config.sandbox === false && config.webSecurity !== false) {
      errors.push('禁用 sandbox 时应该明确设置 webSecurity');
    }

    // Partition 格式检查 —— 接受下划线 + 大小写（spaceId 片段可能含 UUID 大写字符）。
    if (config.partition) {
      const validPattern = /^(persist:)?[a-zA-Z0-9_:-]+$/;
      if (!validPattern.test(config.partition)) {
        errors.push(`无效的 partition 格式: ${config.partition}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

// 导出便捷方法
export const {
  createWebPreferences,
  forEmbedded,
  forCrawl,
  forAccount,
  forTemporary,
  forDebug,
  custom,
  describeConfig,
  validateConfig
} = SessionConfigFactory;

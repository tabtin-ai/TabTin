/**
 * ViewFactory - Profile 预设配置
 *
 * 定义不同使用场景的默认配置
 */

import type { ViewProfile, ProfilePreset, ViewFactoryConfig } from './types';
import type { AntiDetectConfig } from '@tabtin/anti-detect';

/**
 * Profile 预设映射
 */
// NOTE: antiDetect.session.persistent 是声明性元数据，当前未被消费。
// buildSessionConfigForView 通过 config.partition / config.sessionMode 控制 Electron session 持久性，
// AntiDetectManager.getOrCreateProfile 虽然会存储此值到 SessionProfile，但下游无任何读取逻辑。
// 保留此字段以备未来 session 策略统一时使用，修改时请注意它不会影响实际行为。
export const PROFILES: Record<ViewProfile, ProfilePreset> = {
  'user-tab': {
    displayMode: 'embedded',
    persistent: true,
    autoClose: false,
    showInSidebar: true,
    cdpStrategy: 'keep-alive',
    antiDetect: {
      userAgent: { preset: 'system' },
      session: { persistent: true } // ⚠️ 声明性，当前未被 buildSessionConfigForView 消费
    },
    description: '用户浏览标签：显示在主窗口+侧边栏，永久保存'
  },

  'agent-workspace': {
    displayMode: 'embedded',
    persistent: false,
    autoClose: false,
    showInSidebar: false,
    cdpStrategy: 'keep-alive',
    antiDetect: {
      userAgent: { preset: 'system' },
      fingerprint: {
        preset: 'balanced',
        canvas: true,
        webgl: true,
        webrtc: true
      },
      session: { persistent: false } // ⚠️ 声明性，当前未被 buildSessionConfigForView 消费
    },
    description: 'Agent 工作区：对话驱动的浏览/任务执行环境'
  },

  'background-task': {
    displayMode: 'hidden',
    persistent: false,
    autoClose: true,
    showInSidebar: false,
    cdpStrategy: 'task-bound',
    antiDetect: {
      userAgent: { preset: 'system' },
      fingerprint: {
        preset: 'stealth',
        canvas: true,
        webgl: true,
        webrtc: true
      },
      session: { persistent: false } // ⚠️ 声明性，当前未被 buildSessionConfigForView 消费
    },
    description: '后台任务：完全隐藏，任务完成后自动关闭'
  },

  'temporary-preview': {
    displayMode: 'embedded',
    persistent: false,
    autoClose: false,
    showInSidebar: true,
    cdpStrategy: 'keep-alive',
    antiDetect: {
      userAgent: { preset: 'system' },
      session: { persistent: false } // ⚠️ 声明性，当前未被 buildSessionConfigForView 消费
    },
    description: '临时预览：显示在主窗口+侧边栏，由工作区/用户管理关闭'
  },

};

/**
 * 合并 Profile 预设和用户配置
 *
 * @param config 用户配置
 * @returns 完整配置
 */
export function mergeProfileConfig(config: ViewFactoryConfig): Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> & Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'> {
  const preset = PROFILES[config.profile];

  if (!preset) {
    throw new Error(`未知的 ViewProfile: ${config.profile}`);
  }

  const displayMode = config.displayMode ?? preset.displayMode;

  // 合并配置（用户配置优先）
  return {
    profile: config.profile,
    id: config.id,
    url: config.url || '',
    allowPrivateHostNavigation: config.allowPrivateHostNavigation ?? false,
    localPreviewRoot: config.localPreviewRoot ?? '',

    // 显示控制
    displayMode,
    bounds: config.bounds ?? { x: -10000, y: -10000, width: 100, height: 100 },

    // 生命周期
    persistent: config.persistent ?? preset.persistent,
    autoClose: config.autoClose ?? preset.autoClose,
    keepAlive: config.keepAlive ?? false,
    keepAliveDuration: config.keepAliveDuration ?? 300000,  // 默认 5 分钟

    // 标签系统
    showInSidebar: config.showInSidebar ?? preset.showInSidebar,
    tabName: config.tabName ?? '',
    notifyRenderer: config.notifyRenderer ?? config.showInSidebar ?? preset.showInSidebar,

    // 任务关联
    taskId: config.taskId ?? '',
    runId: config.runId ?? '',
    spaceId: config.spaceId ?? '',
    appId: config.appId ?? '',

    // 🆕 CDP 连接策略
    cdpStrategy: config.cdpStrategy ?? preset.cdpStrategy,

    // 🆕 反检测配置（用户配置 > Profile 预设）
    antiDetect: config.antiDetect ?? preset.antiDetect,

    // 其他选项
    metadata: config.metadata ?? {},
    userAgent: config.userAgent ?? '',
    proxy: config.proxy,  // ✅ 保持 optional
    partition: config.partition ?? '',
    sessionMode: config.sessionMode ?? 'inherit'
  };
}

/**
 * 获取 Profile 预设信息
 *
 * @param profile Profile 名称
 * @returns Profile 预设
 */
export function getProfilePreset(profile: ViewProfile): ProfilePreset {
  const preset = PROFILES[profile];

  if (!preset) {
    throw new Error(`未知的 ViewProfile: ${profile}`);
  }

  return preset;
}

/**
 * 列出所有可用的 Profiles
 *
 * @deprecated 未被任何模块调用，计划移除
 * @returns Profile 列表
 */
export function listProfiles(): Array<{ profile: ViewProfile; preset: ProfilePreset }> {
  return Object.entries(PROFILES).map(([profile, preset]) => ({
    profile: profile as ViewProfile,
    preset
  }));
}

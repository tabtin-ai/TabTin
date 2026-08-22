/**
 * User-Agent 配置类型定义
 *
 * 用于在应用中统一管理 User-Agent 配置
 */

import i18n from '@/i18n'

/**
 * UA 配置模式
 */
export type UserAgentMode =
  | 'auto'           // 自动使用系统UA（保持原生指纹）
  | 'mobile'         // 移动设备模拟
  | 'desktop_pool'   // 桌面UA池（随机或指定）
  | 'custom'         // 自定义UA

/**
 * 桌面平台过滤
 */
export type DesktopPlatform = 'current' | 'windows' | 'macos' | 'linux'

/**
 * 移动设备预设（基础）
 */
export type MobileDevicePreset = 'iphone' | 'android' | 'ipad'

/**
 * 桌面浏览器类型
 */
export type DesktopBrowser = 'chrome' | 'edge' | 'firefox' | 'safari'

/**
 * User-Agent 配置
 */
export interface UserAgentConfig {
  /** 配置模式 */
  mode: UserAgentMode

  /** 移动设备预设（mode=mobile 时使用） */
  preset?: MobileDevicePreset

  /** 自定义 UA 字符串（mode=custom 时使用） */
  custom?: string

  /** 桌面平台过滤（mode=smart 或 desktop_pool 时使用） */
  desktopPlatform?: DesktopPlatform

  /** 桌面浏览器过滤（mode=desktop_pool 时使用） */
  desktopBrowser?: DesktopBrowser
}

/**
 * 移动设备预设 UA 字符串池（多样化示例）
 * 前端预览用，实际运行时从后端42+设备库中加权随机选择
 */
export const MOBILE_UA_POOLS: Record<MobileDevicePreset, string[]> = {
  iphone: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  ],
  android: [
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  ],
  ipad: [
    'Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  ]
};

/**
 * 桌面 UA 池（按平台和浏览器分类）
 * 用于桌面 UA 池模式的随机选择
 */
export const DESKTOP_UA_POOLS: Record<DesktopPlatform, Record<DesktopBrowser, string[]>> = {
  current: {
    // current 会动态选择，这里只是占位
    chrome: [],
    edge: [],
    firefox: [],
    safari: [],
  },
  windows: {
    chrome: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ],
    edge: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ],
    firefox: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    ],
    safari: [
      // Windows 上没有 Safari，回退到 Chrome
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    ],
  },
  macos: {
    chrome: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    ],
    edge: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    ],
    firefox: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
    ],
    safari: [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    ],
  },
  linux: {
    chrome: [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ],
    edge: [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    ],
    firefox: [
      'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    ],
    safari: [
      // Linux 上没有 Safari，回退到 Chrome
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    ],
  },
};

/**
 * 移动设备预设 UA 字符串（动态getter，每次返回随机UA）
 */
export const MOBILE_UA_PRESETS: Record<MobileDevicePreset, string> = {
  get iphone() {
    const pool = MOBILE_UA_POOLS.iphone;
    return pool[Math.floor(Math.random() * pool.length)];
  },
  get android() {
    const pool = MOBILE_UA_POOLS.android;
    return pool[Math.floor(Math.random() * pool.length)];
  },
  get ipad() {
    const pool = MOBILE_UA_POOLS.ipad;
    return pool[Math.floor(Math.random() * pool.length)];
  }
};

/**
 * 移动设备预设显示名称
 */
export const MOBILE_DEVICE_LABELS: Record<MobileDevicePreset, string> = {
  iphone: i18n.t('userAgent:mobileDevices.iphone'),
  android: i18n.t('userAgent:mobileDevices.android'),
  ipad: i18n.t('userAgent:mobileDevices.ipad')
}

/**
 * 桌面平台显示名称
 */
export const DESKTOP_PLATFORM_LABELS: Record<DesktopPlatform, string> = {
  current: i18n.t('userAgent:platforms.current'),
  windows: i18n.t('userAgent:platforms.windows'),
  macos: i18n.t('userAgent:platforms.macos'),
  linux: i18n.t('userAgent:platforms.linux')
}

/**
 * 桌面浏览器显示名称
 */
export const DESKTOP_BROWSER_LABELS: Record<DesktopBrowser, string> = {
  chrome: i18n.t('userAgent:browsers.chrome'),
  edge: i18n.t('userAgent:browsers.edge'),
  firefox: i18n.t('userAgent:browsers.firefox'),
  safari: i18n.t('userAgent:browsers.safari')
}

/**
 * UA 模式显示名称
 */
export const UA_MODE_LABELS: Record<UserAgentMode, string> = {
  auto: i18n.t('userAgent:mode.auto.label'),
  mobile: i18n.t('userAgent:mode.mobile.label'),
  desktop_pool: i18n.t('userAgent:mode.desktop_pool.label'),
  custom: i18n.t('userAgent:mode.custom.label')
}

/**
 * UA 模式描述
 */
export const UA_MODE_DESCRIPTIONS: Record<UserAgentMode, string> = {
  auto: i18n.t('userAgent:mode.auto.description'),
  mobile: i18n.t('userAgent:mode.mobile.description'),
  desktop_pool: i18n.t('userAgent:mode.desktop_pool.description'),
  custom: i18n.t('userAgent:mode.custom.description')
}

/**
 * 默认 UA 配置
 */
export const DEFAULT_UA_CONFIG: UserAgentConfig = {
  mode: 'auto',
  desktopPlatform: 'current'
}



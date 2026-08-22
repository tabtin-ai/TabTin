/**
 * Client Hints 常量定义
 *
 * 确保与真实浏览器行为一致
 */

import type { GreaseBrand } from './types.js';

/**
 * Chromium GREASE 算法使用的字符集（11 个）
 *
 * 来源: chromium/src/components/embedder_support/user_agent_utils.cc
 *       GetGreasedUserAgentBrandVersion() 函数
 *
 * 品牌计算公式:
 *   "Not" + GREASE_CHARS[seed % 11] + "A" + GREASE_CHARS[(seed + 1) % 11] + "Brand"
 * 版本计算公式:
 *   GREASE_VERSIONS[seed % 3]
 * 其中 seed = Chrome 主版本号
 */
export const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const;

/** Chromium GREASE 算法使用的版本号候选值（3 个） */
export const GREASE_VERSIONS = ['8', '99', '24'] as const;

/**
 * GREASE 品牌参考表（仅供文档参考，运行时不再使用）
 *
 * Chrome 89-109 使用旧 GREASE 算法，品牌固定为 " Not;A Brand" v="99"。
 * Chrome 110+ 使用新算法，品牌名以 11 为周期，版本号以 3 为周期，
 * 每个版本的 GREASE 品牌都不同。实际运行时通过 getGreaseBrand() 动态计算。
 *
 * 示例:
 *   Chrome 120 → "Not_A Brand" v="8"
 *   Chrome 126 → "Not/A)Brand" v="8"
 *   Chrome 132 → "Not A(Brand" v="8"
 *   Chrome 137 → "Not/A)Brand" v="24"
 *   Chrome 143 → "Not A(Brand" v="24"
 *   Chrome 144 → "Not(A:Brand" v="8"
 */
export const GREASE_BRANDS: Record<number, GreaseBrand> = {
  0: { brand: '" Not;A Brand"', version: '99' },
  1: { brand: '"Not/A)Brand"', version: '8' },
  2: { brand: '"Not_A Brand"', version: '8' },
  3: { brand: '"Not A(Brand"', version: '8' },
  4: { brand: '"Not(A:Brand"', version: '8' },
  5: { brand: '"Not;A=Brand"', version: '8' },
};

/**
 * 根据 Chrome 主版本号获取对应的 GREASE 品牌
 *
 * Chrome 110+ 使用与 Chromium 源码完全一致的动态计算算法，
 * 无需维护版本范围映射表，自动适应所有未来版本。
 *
 * @param majorVersion Chrome 主版本号
 * @returns GREASE 品牌信息（brand 字段包含外层双引号，符合 Sec-CH-UA 格式）
 */
export function getGreaseBrand(majorVersion: number): GreaseBrand {
  if (majorVersion < 110) {
    return { brand: '" Not;A Brand"', version: '99' };
  }

  const char1 = GREASE_CHARS[majorVersion % GREASE_CHARS.length];
  const char2 = GREASE_CHARS[(majorVersion + 1) % GREASE_CHARS.length];
  const brand = `"Not${char1}A${char2}Brand"`;
  const version = GREASE_VERSIONS[majorVersion % GREASE_VERSIONS.length];

  return { brand, version };
}

/**
 * 平台名称映射（UA 中的表示 → Client Hints 标准名称）
 */
export const PLATFORM_NAMES: Record<string, string> = {
  // Windows
  'Windows NT 10.0': 'Windows',
  'Windows NT 11.0': 'Windows',
  'Windows NT 6.3': 'Windows',
  'Windows NT 6.2': 'Windows',
  'Windows NT 6.1': 'Windows',

  // macOS
  'Macintosh': 'macOS',
  'Mac OS X': 'macOS',
  'MacIntel': 'macOS',

  // Linux
  'Linux': 'Linux',
  'X11': 'Linux',

  // Mobile
  'Android': 'Android',
  'iPhone': 'iOS',
  'iPad': 'iOS',
  'iPod': 'iOS',

  // Chrome OS
  'CrOS': 'Chrome OS',
};

/**
 * 架构名称映射（UA 中的表示 → Client Hints 标准名称）
 */
export const ARCH_NAMES: Record<string, string> = {
  'x86_64': 'x86',
  'x64': 'x86',
  'amd64': 'x86',
  'Win64': 'x86',
  'WOW64': 'x86',

  'arm64': 'arm',
  'aarch64': 'arm',
  'ARM64': 'arm',

  'i686': 'x86',
  'i386': 'x86',
  'ia32': 'x86',
};

/**
 * 已知移动设备型号映射（UA 片段 → 标准型号名）
 */
export const DEVICE_MODELS: Record<string, string> = {
  // Samsung
  'SM-S901': 'SM-S901B',
  'SM-G998': 'SM-G998B',
  'SM-A536': 'SM-A536B',

  // Google Pixel
  'Pixel 8 Pro': 'Pixel 8 Pro',
  'Pixel 8': 'Pixel 8',
  'Pixel 7 Pro': 'Pixel 7 Pro',
  'Pixel 7': 'Pixel 7',
  'Pixel 6 Pro': 'Pixel 6 Pro',
  'Pixel 6': 'Pixel 6',

  // iPhone (通过 iOS 版本推断)
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',

  // iPad
  'iPad13,18': 'iPad Pro 12.9-inch (6th generation)',
  'iPad13,16': 'iPad Pro 11-inch (4th generation)',
};

/**
 * Chrome 版本对应的 Chromium 版本映射
 *
 * 📌 重要：Electron 和 Edge 使用 Chromium 内核，版本号可能不同
 */
export const CHROME_TO_CHROMIUM_VERSION: Record<string, string> = {
  // Chrome 122 对应 Chromium 122
  '122': '122',
  '121': '121',
  '120': '120',
  '119': '119',
  '118': '118',

  // Electron 版本映射
  // Electron 34 = Chromium 132
  'electron-34': '132',
  'electron-33': '130',
  'electron-32': '128',
};

/**
 * 默认配置
 */
export const DEFAULT_CLIENT_HINTS_CONFIG = {
  includeExtended: true,
  includeFullVersion: false,
  enableGrease: true,
  strict: false,
};

/**
 * 浏览器识别正则表达式
 */
export const BROWSER_PATTERNS = {
  Chrome: /Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/,
  Edge: /Edg\/(\d+)\.(\d+)\.(\d+)\.(\d+)/,
  Firefox: /Firefox\/(\d+)\.(\d+)/,
  Safari: /Version\/(\d+)\.(\d+)(?:\.(\d+))?.*Safari/,
  Opera: /OPR\/(\d+)\.(\d+)\.(\d+)\.(\d+)/,
  Brave: /Brave\/(\d+)\.(\d+)\.(\d+)\.(\d+)/,
};

/**
 * 平台检测正则表达式
 */
export const PLATFORM_PATTERNS = {
  Windows: /Windows NT (\d+\.\d+)/,
  macOS: /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/,
  Linux: /Linux/,
  Android: /Android (\d+)(?:\.(\d+))?(?:\.(\d+))?/,
  iOS: /(?:iPhone OS|CPU OS) (\d+)_(\d+)(?:_(\d+))?/,
  ChromeOS: /CrOS [a-z0-9_]+ (\d+)\.(\d+)\.(\d+)/,
};


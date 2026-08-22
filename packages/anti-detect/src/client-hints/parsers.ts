/**
 * User-Agent 解析器
 *
 * 🎯 目标：从 UA 字符串精确提取所有关键信息
 * 🔬 方法：正则表达式 + 智能推断
 * ✅ 测试：覆盖 Chrome, Edge, Firefox, Safari, 移动端等所有主流浏览器
 */

import type { ParsedUserAgent } from './types.js';
import { BROWSER_PATTERNS, PLATFORM_PATTERNS, ARCH_NAMES, DEVICE_MODELS } from './constants.js';

/**
 * 解析 User-Agent 字符串
 *
 * @param userAgent 原始 UA 字符串
 * @returns 解析后的结构化信息
 *
 * @example
 * ```typescript
 * const parsed = parseUserAgent(
 *   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
 * );
 * // parsed.browser.name = "Chrome"
 * // parsed.browser.majorVersion = "122"
 * // parsed.platform.type = "Windows"
 * ```
 */
export function parseUserAgent(userAgent: string): ParsedUserAgent {
  return {
    raw: userAgent,
    browser: parseBrowser(userAgent),
    platform: parsePlatform(userAgent),
    device: parseDevice(userAgent),
  };
}

/**
 * 解析浏览器信息
 */
function parseBrowser(ua: string): ParsedUserAgent['browser'] {
  // 1. Edge (必须在 Chrome 之前检测，因为 Edge UA 也包含 Chrome)
  if (ua.includes('Edg/')) {
    const match = ua.match(BROWSER_PATTERNS.Edge);
    if (match) {
      return {
        name: 'Edge',
        majorVersion: match[1],
        fullVersion: `${match[1]}.${match[2]}.${match[3]}.${match[4]}`,
        isChromium: true,
      };
    }
  }

  // 2. Opera (也必须在 Chrome 之前)
  if (ua.includes('OPR/')) {
    const match = ua.match(BROWSER_PATTERNS.Opera);
    if (match) {
      return {
        name: 'Opera',
        majorVersion: match[1],
        fullVersion: `${match[1]}.${match[2]}.${match[3]}.${match[4]}`,
        isChromium: true,
      };
    }
  }

  // 3. Chrome (最常见)
  if (ua.includes('Chrome/')) {
    const match = ua.match(BROWSER_PATTERNS.Chrome);
    if (match) {
      return {
        name: 'Chrome',
        majorVersion: match[1],
        fullVersion: `${match[1]}.${match[2]}.${match[3]}.${match[4]}`,
        isChromium: true,
      };
    }
  }

  // 4. Safari (不包含 Chrome 的才是真 Safari)
  if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    const match = ua.match(BROWSER_PATTERNS.Safari);
    if (match) {
      return {
        name: 'Safari',
        majorVersion: match[1],
        fullVersion: match[3] ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`,
        isChromium: false,
      };
    }
  }

  // 5. Firefox
  if (ua.includes('Firefox/')) {
    const match = ua.match(BROWSER_PATTERNS.Firefox);
    if (match) {
      return {
        name: 'Firefox',
        majorVersion: match[1],
        fullVersion: `${match[1]}.${match[2]}`,
        isChromium: false,
      };
    }
  }

  // 6. 未知浏览器（降级处理）
  return {
    name: 'Unknown',
    majorVersion: '122',  // 默认值
    fullVersion: '122.0.0.0',
    isChromium: ua.includes('AppleWebKit') || ua.includes('Chromium'),
  };
}

/**
 * 解析平台信息
 */
function parsePlatform(ua: string): ParsedUserAgent['platform'] {
  // 1. Windows
  if (ua.includes('Windows')) {
    const match = ua.match(PLATFORM_PATTERNS.Windows);
    const ntVersion = match ? match[1] : '10.0';

    // Windows NT 版本映射
    const versionMap: Record<string, string> = {
      '10.0': '10.0.0',   // Windows 10/11
      '6.3': '8.1.0',     // Windows 8.1
      '6.2': '8.0.0',     // Windows 8
      '6.1': '7.0.0',     // Windows 7
    };

    return {
      type: 'Windows',
      version: versionMap[ntVersion] || '10.0.0',
      arch: extractArch(ua),
    };
  }

  // 2. macOS
  if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
    const match = ua.match(PLATFORM_PATTERNS.macOS);
    let osVersion = '15.0.0';  // 默认 macOS Sonoma (OS 版本)

    if (match) {
      const major = match[1];
      const minor = match[2] || '0';
      const patch = match[3] || '0';
      osVersion = `${major}.${minor}.${patch}`;
    }

    // 🔥 架构判断修复：macOS UA 通常不包含 ARM64 标识
    // 策略：如果 UA 明确包含 "Intel Mac OS X"，则为 x86，否则无法判断（由调用方通过 systemOverrides 提供）
    let arch: string | undefined = undefined;

    if (ua.includes('Intel Mac OS X')) {
      arch = 'x86';
    } else if (ua.includes('ARM64') || ua.includes('arm64')) {
      arch = 'arm';
    }
    // 否则 arch = undefined，由 generateClientHints 的 systemOverrides 参数提供真实架构

    return {
      type: 'macOS',
      version: osVersion,  // 注意：这是 OS 版本，实际 Client Hints 应该用 Darwin 版本（由 systemOverrides 提供）
      arch,
    };
  }

  // 3. Android
  if (ua.includes('Android')) {
    const match = ua.match(PLATFORM_PATTERNS.Android);
    let version = '14.0.0';  // 默认 Android 14

    if (match) {
      const major = match[1];
      const minor = match[2] || '0';
      const patch = match[3] || '0';
      version = `${major}.${minor}.${patch}`;
    }

    return {
      type: 'Android',
      version,
      arch: extractArch(ua),
    };
  }

  // 4. iOS (iPhone/iPad)
  if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) {
    const match = ua.match(PLATFORM_PATTERNS.iOS);
    let version = '17.0.0';  // 默认 iOS 17

    if (match) {
      const major = match[1];
      const minor = match[2] || '0';
      const patch = match[3] || '0';
      version = `${major}.${minor}.${patch}`;
    }

    return {
      type: 'iOS',
      version,
      arch: 'arm',  // iOS 全部是 ARM
    };
  }

  // 5. Chrome OS
  if (ua.includes('CrOS')) {
    const match = ua.match(PLATFORM_PATTERNS.ChromeOS);
    let version = '120.0.0';

    if (match) {
      version = `${match[1]}.${match[2]}.${match[3]}`;
    }

    return {
      type: 'Chrome OS',
      version,
      arch: extractArch(ua),
    };
  }

  // 6. Linux (桌面版，排除 Android)
  if (ua.includes('Linux') && !ua.includes('Android')) {
    return {
      type: 'Linux',
      version: undefined,
      arch: extractArch(ua),
    };
  }

  // 7. 未知平台
  return {
    type: 'Unknown',
    version: undefined,
    arch: undefined,
  };
}

/**
 * 解析设备信息
 */
function parseDevice(ua: string): ParsedUserAgent['device'] {
  const isMobile = /Mobile|Android|iPhone|iPod/i.test(ua);
  const isTablet = /iPad|Tablet/i.test(ua);

  // 提取设备型号（仅移动端）
  let model: string | undefined = undefined;

  if (isMobile || isTablet) {
    // Android 设备型号（如 "Pixel 8", "SM-S901B"）
    const androidModelMatch = ua.match(/Android.*?;\s*([^)]+)\)/);
    if (androidModelMatch) {
      const rawModel = androidModelMatch[1].trim();
      model = DEVICE_MODELS[rawModel] || rawModel;
    }

    // iPhone 型号识别（通过 iOS 版本推断）
    if (ua.includes('iPhone')) {
      const iosVersionMatch = ua.match(/iPhone OS (\d+)/);
      if (iosVersionMatch) {
        const majorVersion = parseInt(iosVersionMatch[1]);
        // iOS 17 = iPhone 15
        // iOS 16 = iPhone 14
        // iOS 15 = iPhone 13
        if (majorVersion >= 17) model = 'iPhone';
        else if (majorVersion >= 16) model = 'iPhone';
        else model = 'iPhone';
      }
    }

    // iPad 型号识别
    if (ua.includes('iPad')) {
      model = 'iPad';
    }
  }

  return {
    isMobile,
    isTablet,
    model,
  };
}

/**
 * 从 UA 中提取架构信息
 */
function extractArch(ua: string): string | undefined {
  // 检查常见架构标识
  for (const [uaArch, standardArch] of Object.entries(ARCH_NAMES)) {
    if (ua.includes(uaArch)) {
      return standardArch;
    }
  }

  // 默认推断
  if (ua.includes('64')) return 'x86';
  if (ua.includes('32') || ua.includes('i686')) return 'x86';

  return undefined;
}

/**
 * 提取完整的版本号字符串（用于 Sec-CH-UA-Full-Version）
 *
 * @example "122.0.6261.129"
 */
export function extractFullVersion(ua: string): string {
  const match = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : '122.0.0.0';
}

/**
 * 检查是否为 WoW64 模式（Windows 32位应用运行在64位系统）
 */
export function isWoW64(ua: string): boolean {
  return ua.includes('WOW64');
}


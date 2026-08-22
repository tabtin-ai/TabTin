/**
 * 系统 User-Agent 检测工具类
 * 根据当前系统信息生成合理的 User-Agent 字符串
 */

/**
 * 系统信息
 */
export interface SystemInfo {
  platform: 'darwin' | 'win32' | 'linux' | 'unknown';
  arch: 'x64' | 'arm64' | 'ia32' | 'unknown';
  version?: string;
  isElectron?: boolean;
}

/**
 * 检测当前系统信息
 */
export function detectSystemInfo(): SystemInfo {
  const info: SystemInfo = {
    platform: 'unknown',
    arch: 'unknown',
    isElectron: false
  };

  // 检测环境
  if (typeof process !== 'undefined' && process.platform) {
    // Node.js 环境
    info.platform = process.platform as any;
    info.arch = process.arch as any;
    info.version = process.version;

    // 检测是否在 Electron 中运行
    info.isElectron = !!process.versions?.electron;
  } else if (typeof navigator !== 'undefined') {
    // 浏览器环境 - 通过 navigator 推断
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes('mac os x') || userAgent.includes('macintosh')) {
      info.platform = 'darwin';
    } else if (userAgent.includes('windows')) {
      info.platform = 'win32';
    } else if (userAgent.includes('linux')) {
      info.platform = 'linux';
    }

    if (userAgent.includes('x86_64') || userAgent.includes('wow64')) {
      info.arch = 'x64';
    } else if (userAgent.includes('arm64') || userAgent.includes('aarch64')) {
      info.arch = 'arm64';
    }
  }

  return info;
}

/**
 * 从 Electron 的 navigator.userAgent 或 process.versions 中提取 Chrome 版本和架构信息
 *
 * 🎯 策略：
 * 1. 优先使用 process.versions.chrome（主进程可用）
 * 2. 回退到从 navigator.userAgent 中提取（渲染进程）
 * 3. 最后使用备用版本
 */
export function extractElectronInfo(): {
  chromeVersion: string;
  detectedPlatform: 'darwin' | 'win32' | 'linux' | 'unknown';
  arch: string;
} {
  const defaultInfo = {
    chromeVersion: '122.0.0.0',  // 备用版本（Electron 34.x 默认）
    detectedPlatform: 'unknown' as const,
    arch: 'x86_64'
  };

  // ✅ 1. 优先使用 process.versions.chrome（主进程中可用，最准确）
  let chromeVersion = defaultInfo.chromeVersion;
  if (typeof process !== 'undefined' && process.versions?.chrome) {
    chromeVersion = process.versions.chrome;
    // console.log('[system-ua] ✅ 从 process.versions.chrome 获取版本:', chromeVersion);
  }
  // 2. 回退：从 navigator.userAgent 中提取（渲染进程）
  else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    if (chromeMatch) {
      chromeVersion = chromeMatch[1];
    }
  }

  // ✅ 3. 平台检测（优先 process.platform）
  let detectedPlatform: 'darwin' | 'win32' | 'linux' | 'unknown' = 'unknown';
  if (typeof process !== 'undefined' && process.platform) {
    detectedPlatform = process.platform as any;
  } else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (ua.includes('Windows NT')) {
      detectedPlatform = 'win32';
    } else if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
      detectedPlatform = 'darwin';
    } else if (ua.includes('Linux') || ua.includes('X11')) {
      detectedPlatform = 'linux';
    }
  }

  // ✅ 4. 架构检测（优先 process.arch）
  let arch = 'x86_64';
  if (typeof process !== 'undefined' && process.arch) {
    arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  } else if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (ua.includes('Win64') || ua.includes('x86_64') || ua.includes('x64')) {
      arch = 'x86_64';
    } else if (ua.includes('aarch64') || ua.includes('arm64')) {
      arch = 'aarch64';
    }
  }

  return { chromeVersion, detectedPlatform, arch };
}

/**
 * 从 UA 字符串中提取平台信息
 */
export function extractPlatformFromUA(ua: string): 'darwin' | 'win32' | 'linux' | 'unknown' {
  if (ua.includes('Macintosh') || ua.includes('Mac OS X')) {
    return 'darwin';
  } else if (ua.includes('Windows NT')) {
    return 'win32';
  } else if (ua.includes('Linux') || ua.includes('X11')) {
    return 'linux';
  }
  return 'unknown';
}

/**
 * 验证 UA 是否与系统平台匹配
 */
export function validateUAMatchesSystem(ua: string, platform: string): boolean {
  const uaPlatform = extractPlatformFromUA(ua);
  return uaPlatform === platform;
}

/**
 * 根据系统信息生成合理的桌面 User-Agent
 *
 * ✅ 新策略：
 * 1. 使用主进程的真实系统信息（process.platform）- 最准确
 * 2. 使用 Electron 实际的 Chrome 版本（动态提取）- 不硬编码
 * 3. 动态组合，确保平台和版本都正确
 */
export function generateSystemDesktopUA(systemInfo: SystemInfo = detectSystemInfo()): string {
  const { platform, arch } = systemInfo;

  // ✅ 从 Electron 实际 UA 中提取 Chrome 版本（不硬编码）
  const electronInfo = extractElectronInfo();
  const chromeVersion = electronInfo.chromeVersion;

  switch (platform) {
    case 'darwin':
      // macOS Chrome UA（M1/Intel 通用）
      // 注意：即使是 M1 芯片，Chrome 也会报告 Intel Mac OS X
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

    case 'win32':
      // Windows Chrome UA
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

    case 'linux':
      // Linux Chrome UA
      if (arch === 'arm64') {
        return `Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      } else {
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      }

    default:
      // 通用桌面 UA
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
}

/**
 * 清理 User-Agent，移除 Electron 标识
 *
 * 输入: Mozilla/5.0 (...) tabtin-electron/1.0.0 Chrome/132.0.6834.194 Electron/34.1.1 Safari/537.36
 * 输出: Mozilla/5.0 (...) Chrome/132.0.6834.194 Safari/537.36
 */
export function cleanElectronUA(ua: string): string {
  // 移除 tabtin-electron/x.x.x
  let cleaned = ua.replace(/\s+tabtin-electron\/[\d.]+/g, '');

  // 移除 Electron/x.x.x
  cleaned = cleaned.replace(/\s+Electron\/[\d.]+/g, '');

  // 清理多余的空格
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * 从浏览器获取实际 User-Agent（仅在浏览器环境中有效）
 * 🎯 在 Electron 中，会自动清理 Electron 标识，保留真实的 Chrome 版本
 */
export function getBrowserUserAgent(): string | null {
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent;

    // 检测是否为 Electron 环境，自动清理 Electron 标识
    if (ua.includes('Electron/') || ua.includes('tabtin-electron/')) {
      return cleanElectronUA(ua);
    }

    return ua;
  }
  return null;
}

/**
 * 获取系统推荐的 User-Agent
 *
 * ✅ 新策略（修复系统平台不匹配问题）：
 * 1. 优先使用浏览器的实际 UA（自动清理 Electron 标识）
 * 2. **但验证 UA 中的平台是否与真实系统匹配**
 * 3. 如果平台不匹配（如 Mac 系统报告 Windows UA），则重新生成
 * 4. 确保 Chrome 版本从实际 Electron 中提取，不硬编码
 *
 * 🔴 解决的问题：
 * - Mac 系统被错误识别为 Windows
 * - Chrome 版本硬编码导致与实际不符
 */
export function getSystemUserAgent(): string {
  // 1. 获取真实系统信息（主进程的 process.platform）
  const systemInfo = detectSystemInfo();

  // 2. 获取浏览器的原始 UA（清理 Electron 标识）
  const browserUA = getBrowserUserAgent();

  if (browserUA) {
    // 3. ✅ 验证清理后的 UA 是否与真实系统匹配
    const isMatching = validateUAMatchesSystem(browserUA, systemInfo.platform);

    if (isMatching) {
      // UA 平台正确，直接使用清理后的 UA
      return browserUA;
    } else {
      // UA 平台不匹配（如 Mac 系统报告 Windows UA），使用真实系统信息重新生成
      return generateSystemDesktopUA(systemInfo);
    }
  }

  // 4. 无法获取浏览器 UA (通常在主进程启动早期)，根据真实系统信息生成
  // console.log('[system-ua] 正在根据系统环境生成最佳 UA...');
  return generateSystemDesktopUA(systemInfo);
}

/**
 * 检查给定的 UA 是否应该被视为"系统 UA"
 */
export function isSystemUserAgent(userAgent: string): boolean {
  if (!userAgent) return false;

  const browserUA = getBrowserUserAgent();
  if (browserUA && userAgent === browserUA) {
    return true;
  }

  // 检查是否匹配系统生成的 UA 模式
  const systemUA = generateSystemDesktopUA();
  return userAgent === systemUA;
}

/**
 * 标准化 User-Agent 处理
 */
export class SystemUserAgentManager {
  private static instance: SystemUserAgentManager;
  private cachedSystemUA: string | null = null;
  private cachedBrowserUA: string | null = null;

  static getInstance(): SystemUserAgentManager {
    if (!SystemUserAgentManager.instance) {
      SystemUserAgentManager.instance = new SystemUserAgentManager();
    }
    return SystemUserAgentManager.instance;
  }

  /**
   * 获取系统 User-Agent，带缓存
   */
  getSystemUserAgent(): string {
    if (!this.cachedSystemUA) {
      this.cachedSystemUA = getSystemUserAgent();
    }
    return this.cachedSystemUA;
  }

  /**
   * 获取浏览器 User-Agent，带缓存
   */
  getBrowserUserAgent(): string | null {
    if (this.cachedBrowserUA === null) {
      this.cachedBrowserUA = getBrowserUserAgent() || '';
    }
    return this.cachedBrowserUA || null;
  }

  /**
   * 清除缓存（用于测试或环境变化时）
   */
  clearCache(): void {
    this.cachedSystemUA = null;
    this.cachedBrowserUA = null;
  }

  /**
   * 获取系统信息
   */
  getSystemInfo(): SystemInfo {
    return detectSystemInfo();
  }
}

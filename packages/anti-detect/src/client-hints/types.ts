/**
 * Client Hints 类型定义
 *
 * 参考标准：
 * - https://wicg.github.io/client-hints-infrastructure/
 * - https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-CH-UA
 */

/**
 * 完整的 Client Hints 集合
 */
export interface ClientHints {
  // ===== 核心 Client Hints（必需） =====
  /** 品牌和版本列表 */
  'Sec-CH-UA': string;
  /** 是否为移动设备 */
  'Sec-CH-UA-Mobile': '?0' | '?1';
  /** 操作系统平台 */
  'Sec-CH-UA-Platform': string;

  // ===== 扩展 Client Hints（可选但推荐） =====
  /** 操作系统版本（如 "10.0.0", "15.0.0"） */
  'Sec-CH-UA-Platform-Version'?: string;
  /** CPU 架构（如 "x86", "arm"） */
  'Sec-CH-UA-Arch'?: string;
  /** 位数（如 "64", "32"） */
  'Sec-CH-UA-Bitness'?: string;
  /** 设备型号（移动端，如 "Pixel 8", "iPhone15,2"） */
  'Sec-CH-UA-Model'?: string;
  /** 完整版本列表（更详细的品牌信息） */
  'Sec-CH-UA-Full-Version-List'?: string;
  /** WoW64 模式（Windows 32位应用运行在64位系统） */
  'Sec-CH-UA-WoW64'?: '?0' | '?1';

  // ===== 高级 Client Hints（罕见使用） =====
  /** 完整的浏览器版本（如 "122.0.6261.129"） */
  'Sec-CH-UA-Full-Version'?: string;
}

/**
 * Client Hints 生成配置
 */
export interface ClientHintsConfig {
  /** 是否包含扩展 Hints（Platform-Version, Arch 等） */
  includeExtended?: boolean;
  /** 是否包含完整版本信息 */
  includeFullVersion?: boolean;
  /** 是否启用 GREASE 策略（推荐：true） */
  enableGrease?: boolean;
  /** 自定义品牌名（覆盖默认 GREASE） */
  customBrands?: string[];
  /** 严格模式：如果无法解析 UA 则抛出错误 */
  strict?: boolean;
  /** 🆕 真实系统信息覆盖（用于修正 UA 中不准确的信息） */
  systemOverrides?: {
    /** 真实的平台版本（如 macOS 的 Darwin 内核版本 "26.0.0"） */
    platformVersion?: string;
    /** 真实的架构（"arm" 或 "x86"） */
    arch?: 'arm' | 'x86';
    /** 真实的位数（"64" 或 "32"） */
    bitness?: '64' | '32';
  };
}

/**
 * 解析后的 User-Agent 信息
 */
export interface ParsedUserAgent {
  /** 原始 UA 字符串 */
  raw: string;

  /** 浏览器信息 */
  browser: {
    /** 浏览器名称（Chrome, Edge, Firefox, Safari 等） */
    name: 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Opera' | 'Brave' | 'Unknown';
    /** 主版本号 */
    majorVersion: string;
    /** 完整版本号 */
    fullVersion: string;
    /** 是否为 Chromium 内核 */
    isChromium: boolean;
  };

  /** 平台信息 */
  platform: {
    /** 平台类型 */
    type: 'Windows' | 'macOS' | 'Linux' | 'Android' | 'iOS' | 'Chrome OS' | 'Unknown';
    /** 平台版本（如 "10.0", "15.0"） */
    version?: string;
    /** 平台架构（如 "x86_64", "arm64"） */
    arch?: string;
  };

  /** 设备信息 */
  device: {
    /** 是否为移动设备 */
    isMobile: boolean;
    /** 是否为平板 */
    isTablet: boolean;
    /** 设备型号（移动端） */
    model?: string;
  };
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否通过验证 */
  valid: boolean;
  /** 验证警告 */
  warnings: string[];
  /** 验证错误 */
  errors: string[];
}

/**
 * GREASE 品牌配置（Google 的反指纹策略）
 */
export interface GreaseBrand {
  /** 品牌名称 */
  brand: string;
  /** 版本号（通常是固定值如 "8", "99"） */
  version: string;
}


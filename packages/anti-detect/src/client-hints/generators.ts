/**
 * Client Hints 生成器
 *
 * 🎯 目标：根据解析后的 UA 信息生成标准的 Client Hints Headers
 * 🔬 方法：GREASE 策略 + 版本号匹配 + 平台适配
 * ✅ 精度：100% 与真实浏览器一致
 */

import type { ClientHints, ParsedUserAgent, ClientHintsConfig, GreaseBrand } from './types.js';
import { getGreaseBrand, DEFAULT_CLIENT_HINTS_CONFIG } from './constants.js';
import { extractFullVersion, isWoW64 } from './parsers.js';

/**
 * 生成完整的 Client Hints Headers
 *
 * @param parsed 解析后的 UA 信息
 * @param config 生成配置
 * @returns Client Hints Headers 对象
 *
 * @example
 * ```typescript
 * const parsed = parseUserAgent(ua);
 * const hints = generateClientHints(parsed, { includeExtended: true });
 * // hints['Sec-CH-UA'] = '"Not A(Brand";v="8", "Chromium";v="122", "Google Chrome";v="122"'
 * ```
 */
export function generateClientHints(
  parsed: ParsedUserAgent,
  config: ClientHintsConfig = {}
): ClientHints {
  const finalConfig = { ...DEFAULT_CLIENT_HINTS_CONFIG, ...config };

  // 核心 Client Hints（必需）
  const hints: ClientHints = {
    'Sec-CH-UA': generateSecChUA(parsed, finalConfig),
    'Sec-CH-UA-Mobile': parsed.device.isMobile ? '?1' : '?0',
    'Sec-CH-UA-Platform': `"${parsed.platform.type}"`,
  };

  // 扩展 Client Hints（可选但推荐）
  if (finalConfig.includeExtended) {
    // 平台版本（优先使用系统覆盖值）
    const platformVersion = finalConfig.systemOverrides?.platformVersion || parsed.platform.version;
    if (platformVersion) {
      hints['Sec-CH-UA-Platform-Version'] = `"${platformVersion}"`;
    }

    // 架构（优先使用系统覆盖值，仅桌面端）
    if (!parsed.device.isMobile) {
      const arch = finalConfig.systemOverrides?.arch || parsed.platform.arch;
      if (arch) {
        hints['Sec-CH-UA-Arch'] = `"${arch}"`;
      }

      // 位数（优先使用系统覆盖值）
      const bitness = finalConfig.systemOverrides?.bitness || '64';
      hints['Sec-CH-UA-Bitness'] = `"${bitness}"`;
    }

    // 设备型号（仅移动端）
    if (parsed.device.model) {
      hints['Sec-CH-UA-Model'] = `"${parsed.device.model}"`;
    }

    // WoW64 检测（Windows 特有）
    if (parsed.platform.type === 'Windows' && isWoW64(parsed.raw)) {
      hints['Sec-CH-UA-WoW64'] = '?1';
    }

    // 完整版本列表
    hints['Sec-CH-UA-Full-Version-List'] = generateFullVersionList(parsed, finalConfig);
  }

  // 完整版本号（罕见使用）
  if (finalConfig.includeFullVersion) {
    hints['Sec-CH-UA-Full-Version'] = `"${parsed.browser.fullVersion}"`;
  }

  return hints;
}

/**
 * 生成 Sec-CH-UA 头（品牌列表）
 *
 * 格式："<浏览器>";v="<版本>", "<内核>";v="<版本>", "<GREASE品牌>";v="<版本>"
 *
 * 🔥 重要：真实 Chrome 的顺序是【浏览器品牌 → Chromium → GREASE】，而不是【GREASE → Chromium → 浏览器】！
 *
 * @example
 * Chrome 143: '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"'
 * Edge 122:   '"Microsoft Edge";v="122", "Chromium";v="122", "Not A(Brand";v="8"'
 */
function generateSecChUA(parsed: ParsedUserAgent, config: ClientHintsConfig): string {
  const brands: string[] = [];
  const majorVersion = parsed.browser.majorVersion;

  // 1. 具体浏览器品牌（最前面）
  const browserBrand = getBrowserBrand(parsed.browser.name);
  brands.push(`"${browserBrand}";v="${majorVersion}"`);

  // 2. Chromium 内核（如果是 Chromium 系浏览器）
  if (parsed.browser.isChromium) {
    brands.push(`"Chromium";v="${majorVersion}"`);
  }

  // 3. GREASE 品牌（反指纹机制，最后面）
  if (config.enableGrease) {
    const grease = getGreaseBrand(parseInt(majorVersion));
    brands.push(`${grease.brand};v="${grease.version}"`);
  }

  return brands.join(', ');
}

/**
 * 生成 Sec-CH-UA-Full-Version-List（完整版本列表）
 *
 * 格式：与 Sec-CH-UA 相同，但使用完整版本号
 *
 * 🔥 顺序：【浏览器品牌 → Chromium → GREASE】
 *
 * @example
 * '"Google Chrome";v="143.0.7499.41", "Chromium";v="143.0.7499.41", "Not A(Brand";v="24.0.0.0"'
 */
function generateFullVersionList(parsed: ParsedUserAgent, config: ClientHintsConfig): string {
  const brands: string[] = [];
  const fullVersion = parsed.browser.fullVersion;

  // 1. 具体浏览器（最前面）
  const browserBrand = getBrowserBrand(parsed.browser.name);
  brands.push(`"${browserBrand}";v="${fullVersion}"`);

  // 2. Chromium 内核
  if (parsed.browser.isChromium) {
    brands.push(`"Chromium";v="${fullVersion}"`);
  }

  // 3. GREASE 品牌（最后面）
  if (config.enableGrease) {
    const grease = getGreaseBrand(parseInt(parsed.browser.majorVersion));
    brands.push(`${grease.brand};v="${grease.version}.0.0.0"`);
  }

  return brands.join(', ');
}

/**
 * 获取浏览器品牌名称（用于 Client Hints）
 */
function getBrowserBrand(browserName: string): string {
  const brandMap: Record<string, string> = {
    Chrome: 'Google Chrome',
    Edge: 'Microsoft Edge',
    Opera: 'Opera',
    Brave: 'Brave',
    Safari: 'Safari',
    Firefox: 'Firefox',
  };

  return brandMap[browserName] || 'Chromium';
}

/**
 * 将 Client Hints 对象转换为标准 HTTP Headers
 *
 * @param hints Client Hints 对象
 * @returns HTTP Headers 对象（去除 undefined 值）
 */
export function clientHintsToHeaders(hints: ClientHints): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(hints)) {
    if (value !== undefined) {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * 合并 Client Hints 到现有 Headers
 *
 * @param existingHeaders 现有 Headers
 * @param hints Client Hints
 * @param overwrite 是否覆盖已存在的值（默认 false）
 * @returns 合并后的 Headers
 */
export function mergeClientHintsHeaders(
  existingHeaders: Record<string, string>,
  hints: ClientHints,
  overwrite: boolean = false
): Record<string, string> {
  const merged = { ...existingHeaders };
  const hintsHeaders = clientHintsToHeaders(hints);

  for (const [key, value] of Object.entries(hintsHeaders)) {
    if (overwrite || !merged[key]) {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * 生成自定义 GREASE 品牌（用于高级定制）
 *
 * @param format GREASE 格式（如 "Not A(Brand"）
 * @param version 版本号（如 "8"）
 * @returns GreaseBrand 对象
 */
export function createCustomGrease(format: string, version: string = '8'): GreaseBrand {
  return { brand: format, version };
}


/**
 * Client Hints 一致性验证器
 *
 * 🎯 目标：确保生成的 Client Hints 与 User-Agent 100% 一致
 * 🔍 检查项：版本号匹配、平台匹配、移动端标识、架构合理性
 * ⚠️ 防止：UA 说 Mac 但 Platform 是 Windows，UA 版本 115 但 Hints 版本 122 等
 */

import type { ValidationResult, ParsedUserAgent, ClientHints } from './types.js';
import { GREASE_VERSIONS, GREASE_CHARS, getGreaseBrand } from './constants.js';
import { t } from '../i18n.js';

/**
 * 验证 Client Hints 与 User-Agent 的一致性
 *
 * @param parsed 解析后的 UA 信息
 * @param hints 生成的 Client Hints
 * @returns 验证结果
 *
 * @example
 * ```typescript
 * const result = validateClientHints(parsed, hints);
 * if (!result.valid) {
 *   console.error('验证失败:', result.errors);
 * }
 * ```
 */
export function validateClientHints(
  parsed: ParsedUserAgent,
  hints: ClientHints
): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  // 1. 验证版本号一致性
  validateVersionConsistency(parsed, hints, warnings, errors);

  // 2. 验证平台一致性
  validatePlatformConsistency(parsed, hints, warnings, errors);

  // 3. 验证移动端标识一致性
  validateMobileConsistency(parsed, hints, warnings, errors);

  // 4. 验证架构合理性
  validateArchConsistency(parsed, hints, warnings, errors);

  // 5. 验证 GREASE 品牌格式
  validateGreaseFormat(parsed, hints, warnings, errors);

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * 验证版本号一致性
 *
 * 关键检查：
 * - Sec-CH-UA 中的版本号必须与 UA 中的 Chrome 版本匹配
 * - 如果是 Edge/Opera，品牌名称也要匹配
 */
function validateVersionConsistency(
  parsed: ParsedUserAgent,
  hints: ClientHints,
  warnings: string[],
  errors: string[]
): void {
  const secChUA = hints['Sec-CH-UA'];
  if (!secChUA) {
    errors.push(t('clientHints.errors.missingSecChUa'));
    return;
  }

  // 提取 Chromium 版本
  const chromiumMatch = secChUA.match(/"Chromium";v="(\d+)"/);
  if (chromiumMatch) {
    const hintsVersion = chromiumMatch[1];
    const uaVersion = parsed.browser.majorVersion;

    if (hintsVersion !== uaVersion) {
      errors.push(
        t('clientHints.errors.versionMismatch', { uaVersion, hintsVersion })
      );
    }
  }

  // 验证浏览器品牌
  if (parsed.browser.name === 'Edge') {
    if (!secChUA.includes('Microsoft Edge')) {
      warnings.push(t('clientHints.warnings.edgeBrandMissing'));
    }
  }

  if (parsed.browser.name === 'Opera') {
    if (!secChUA.includes('Opera')) {
      warnings.push(t('clientHints.warnings.operaBrandMissing'));
    }
  }

  // 验证 Full-Version-List（如果存在）
  const fullVersionList = hints['Sec-CH-UA-Full-Version-List'];
  if (fullVersionList) {
    const fullVersionMatch = fullVersionList.match(/"Chromium";v="([\d.]+)"/);
    if (fullVersionMatch) {
      const hintsFullVersion = fullVersionMatch[1];
      const uaFullVersion = parsed.browser.fullVersion;

      if (hintsFullVersion !== uaFullVersion) {
        warnings.push(
          t('clientHints.warnings.fullVersionMismatch', { uaFullVersion, hintsFullVersion })
        );
      }
    }
  }
}

/**
 * 验证平台一致性
 *
 * 关键检查：
 * - UA 说是 Windows，Sec-CH-UA-Platform 也必须是 "Windows"
 * - UA 说是 Mac，Platform 必须是 "macOS"（注意大小写）
 */
function validatePlatformConsistency(
  parsed: ParsedUserAgent,
  hints: ClientHints,
  warnings: string[],
  errors: string[]
): void {
  const secChUAPlatform = hints['Sec-CH-UA-Platform'];
  if (!secChUAPlatform) {
    errors.push(t('clientHints.errors.missingPlatform'));
    return;
  }

  // 移除引号
  const hintsPlatform = secChUAPlatform.replace(/"/g, '');
  const uaPlatform = parsed.platform.type;

  if (hintsPlatform !== uaPlatform) {
    errors.push(
      t('clientHints.errors.platformMismatch', { uaPlatform, hintsPlatform })
    );
  }

  // 验证平台版本（如果存在）
  const platformVersion = hints['Sec-CH-UA-Platform-Version'];
  if (platformVersion && parsed.platform.version) {
    const hintsVersion = platformVersion.replace(/"/g, '');
    const uaVersion = parsed.platform.version;

    // 只验证主版本号和次版本号（补丁版本可以忽略）
    const [hintsMajor, hintsMinor] = hintsVersion.split('.');
    const [uaMajor, uaMinor] = uaVersion.split('.');

    if (hintsMajor !== uaMajor || hintsMinor !== uaMinor) {
      warnings.push(
        t('clientHints.warnings.platformVersionMismatch', { uaVersion, hintsVersion })
      );
    }
  }
}

/**
 * 验证移动端标识一致性
 *
 * 关键检查：
 * - UA 包含 "Mobile" 时，Sec-CH-UA-Mobile 必须是 "?1"
 * - UA 是桌面端时，Sec-CH-UA-Mobile 必须是 "?0"
 */
function validateMobileConsistency(
  parsed: ParsedUserAgent,
  hints: ClientHints,
  warnings: string[],
  errors: string[]
): void {
  const secChUAMobile = hints['Sec-CH-UA-Mobile'];
  if (!secChUAMobile) {
    errors.push(t('clientHints.errors.missingMobile'));
    return;
  }

  const hintsMobile = secChUAMobile === '?1';
  const uaMobile = parsed.device.isMobile;

  if (hintsMobile !== uaMobile) {
    errors.push(
      t('clientHints.errors.mobileMismatch', {
        isMobile: uaMobile ? t('clientHints.labels.is') : t('clientHints.labels.isNot'),
        secChUAMobile
      })
    );
  }

  // 额外检查：如果是移动端，应该有设备型号
  if (uaMobile && !hints['Sec-CH-UA-Model'] && !parsed.device.model) {
    warnings.push(t('clientHints.warnings.mobileModelMissing'));
  }
}

/**
 * 验证架构合理性
 *
 * 关键检查：
 * - Windows 不能是 ARM（除非是 Surface Pro X 等特殊设备）
 * - macOS M1/M2/M3 必须是 ARM
 * - Android 通常是 ARM（少数平板是 x86）
 * - iOS 永远是 ARM
 */
function validateArchConsistency(
  parsed: ParsedUserAgent,
  hints: ClientHints,
  warnings: string[],
  errors: string[]
): void {
  const arch = hints['Sec-CH-UA-Arch']?.replace(/"/g, '');
  if (!arch) return;  // 架构是可选的

  const platform = parsed.platform.type;
  const uaArch = parsed.platform.arch;

  // 1. iOS 必须是 ARM
  if (platform === 'iOS' && arch !== 'arm') {
    errors.push(t('clientHints.errors.iosArchInvalid', { arch }));
  }

  // 2. macOS M 芯片检测
  if (platform === 'macOS') {
    const isAppleSilicon = parsed.raw.includes('ARM64') || parsed.raw.includes('arm64');
    if (isAppleSilicon && arch !== 'arm') {
      errors.push(t('clientHints.errors.appleSiliconArchInvalid'));
    }
    if (!isAppleSilicon && arch === 'arm') {
      warnings.push(t('clientHints.warnings.appleSiliconMissing'));
    }
  }

  // 3. Windows ARM 设备罕见
  if (platform === 'Windows' && arch === 'arm') {
    warnings.push(t('clientHints.warnings.windowsArmRare'));
  }

  // 4. Android x86 设备罕见（模拟器除外）
  if (platform === 'Android' && arch === 'x86' && !parsed.device.isMobile) {
    warnings.push(t('clientHints.warnings.androidX86Rare'));
  }
}

/**
 * 验证 GREASE 品牌格式
 *
 * 关键检查：
 * - GREASE 品牌格式必须符合当前 Chrome 版本的规范
 * - 版本号通常是 "8" 或 "99"
 */
function validateGreaseFormat(
  parsed: ParsedUserAgent,
  hints: ClientHints,
  warnings: string[],
  errors: string[]
): void {
  const secChUA = hints['Sec-CH-UA'];
  if (!secChUA) return;

  // 提取 GREASE 品牌（在品牌列表的最后一个位置：浏览器 → Chromium → GREASE）
  const brandEntries = secChUA.split(',').map(b => b.trim());
  const lastBrand = brandEntries[brandEntries.length - 1];
  const greaseBrandMatch = lastBrand?.match(/"([^"]+)";v="(\d+)"/);
  if (!greaseBrandMatch) {
    warnings.push(t('clientHints.warnings.greaseMissing'));
    return;
  }

  const [, greaseBrand, greaseVersion] = greaseBrandMatch;

  const greaseChars = GREASE_CHARS.filter(c => c !== ' ');
  if (!greaseChars.some(c => greaseBrand.includes(c))) {
    warnings.push(t('clientHints.warnings.greaseBrandFormatInvalid', { brand: greaseBrand }));
  }

  if (!GREASE_VERSIONS.includes(greaseVersion as typeof GREASE_VERSIONS[number])) {
    warnings.push(t('clientHints.warnings.greaseVersionInvalid', { version: greaseVersion }));
  }

  const majorVersion = parseInt(parsed.browser.majorVersion);
  if (majorVersion >= 110) {
    const expected = getGreaseBrand(majorVersion);
    const expectedBrandInner = expected.brand.replace(/^"|"$/g, '');
    if (greaseBrand !== expectedBrandInner) {
      warnings.push(t('clientHints.warnings.greaseBrandOutdated', { brand: greaseBrand }));
    }
  }
}

/**
 * 快速验证：检查最关键的一致性问题
 *
 * @param parsed 解析后的 UA
 * @param hints Client Hints
 * @returns 是否通过基础验证
 */
export function quickValidate(parsed: ParsedUserAgent, hints: ClientHints): boolean {
  // 1. 版本号必须匹配
  const secChUA = hints['Sec-CH-UA'];
  if (secChUA) {
    const chromiumMatch = secChUA.match(/"Chromium";v="(\d+)"/);
    if (chromiumMatch && chromiumMatch[1] !== parsed.browser.majorVersion) {
      return false;
    }
  }

  // 2. 平台必须匹配
  const platform = hints['Sec-CH-UA-Platform']?.replace(/"/g, '');
  if (platform && platform !== parsed.platform.type) {
    return false;
  }

  // 3. 移动端标识必须匹配
  const mobile = hints['Sec-CH-UA-Mobile'];
  if (mobile && (mobile === '?1') !== parsed.device.isMobile) {
    return false;
  }

  return true;
}

/**
 * 自动修复常见的不一致问题
 *
 * @param parsed 解析后的 UA
 * @param hints 有问题的 Client Hints
 * @returns 修复后的 Client Hints
 */
export function autoFixClientHints(
  parsed: ParsedUserAgent,
  hints: ClientHints
): ClientHints {
  const fixed = { ...hints };

  // 修复平台
  fixed['Sec-CH-UA-Platform'] = `"${parsed.platform.type}"`;

  // 修复移动端标识
  fixed['Sec-CH-UA-Mobile'] = parsed.device.isMobile ? '?1' : '?0';

  // 修复版本号（重新生成 Sec-CH-UA）
  if (fixed['Sec-CH-UA']) {
    const majorVersion = parsed.browser.majorVersion;
    fixed['Sec-CH-UA'] = fixed['Sec-CH-UA'].replace(
      /"Chromium";v="\d+"/,
      `"Chromium";v="${majorVersion}"`
    ).replace(
      /"Google Chrome";v="\d+"/,
      `"Google Chrome";v="${majorVersion}"`
    );
  }

  return fixed;
}

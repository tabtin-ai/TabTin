export type AntiDetectLocale = 'zh-CN' | 'en-US';

type MessageParams = Record<string, string | number | boolean | null | undefined>;
type Translator = (key: string, params?: MessageParams) => string;

const MESSAGES: Record<AntiDetectLocale, Record<string, string>> = {
  'zh-CN': {
    'clientHints.errors.missingSecChUa': '缺少必需的 Sec-CH-UA 头',
    'clientHints.errors.versionMismatch': '版本号不一致：UA 中 Chrome 版本为 {{uaVersion}}，但 Sec-CH-UA 中为 {{hintsVersion}}',
    'clientHints.warnings.edgeBrandMissing': 'UA 是 Edge 但 Sec-CH-UA 中未包含 \"Microsoft Edge\"',
    'clientHints.warnings.operaBrandMissing': 'UA 是 Opera 但 Sec-CH-UA 中未包含 \"Opera\"',
    'clientHints.warnings.fullVersionMismatch': '完整版本号不一致：UA 为 {{uaFullVersion}}，但 Full-Version-List 为 {{hintsFullVersion}}',
    'clientHints.errors.missingPlatform': '缺少必需的 Sec-CH-UA-Platform 头',
    'clientHints.errors.platformMismatch': '平台不一致：UA 中为 {{uaPlatform}}，但 Sec-CH-UA-Platform 为 {{hintsPlatform}}',
    'clientHints.warnings.platformVersionMismatch': '平台版本不一致：UA 为 {{uaVersion}}，但 Platform-Version 为 {{hintsVersion}}',
    'clientHints.errors.missingMobile': '缺少必需的 Sec-CH-UA-Mobile 头',
    'clientHints.errors.mobileMismatch': '移动端标识不一致：UA {{isMobile}}移动端，但 Sec-CH-UA-Mobile 为 {{secChUAMobile}}',
    'clientHints.warnings.mobileModelMissing': '移动端 UA 但未检测到设备型号（可能影响真实性）',
    'clientHints.errors.iosArchInvalid': 'iOS 设备架构必须是 ARM，但检测到 {{arch}}',
    'clientHints.errors.appleSiliconArchInvalid': '检测到 Apple Silicon (M1/M2/M3) 但架构不是 ARM',
    'clientHints.warnings.appleSiliconMissing': '架构是 ARM 但 UA 中未检测到 Apple Silicon 标识（可能是伪装）',
    'clientHints.warnings.windowsArmRare': 'Windows ARM 设备较罕见（如 Surface Pro X），可能引起注意',
    'clientHints.warnings.androidX86Rare': 'Android x86 架构通常只出现在模拟器中',
    'clientHints.warnings.greaseMissing': '未检测到 GREASE 品牌（可能影响反指纹效果）',
    'clientHints.warnings.greaseBrandFormatInvalid': 'GREASE 品牌格式异常：\"{{brand}}\"（应包含特殊字符）',
    'clientHints.warnings.greaseVersionInvalid': 'GREASE 版本异常：{{version}}（通常是 8 或 99）',
    'clientHints.warnings.greaseBrandOutdated': 'GREASE 品牌格式可能过时：\"{{brand}}\"',
    'clientHints.labels.is': '是',
    'clientHints.labels.isNot': '不是',
  },
  'en-US': {
    'clientHints.errors.missingSecChUa': 'Missing required Sec-CH-UA header.',
    'clientHints.errors.versionMismatch': 'Version mismatch: UA Chrome version is {{uaVersion}}, but Sec-CH-UA is {{hintsVersion}}.',
    'clientHints.warnings.edgeBrandMissing': 'UA is Edge but Sec-CH-UA does not include \"Microsoft Edge\".',
    'clientHints.warnings.operaBrandMissing': 'UA is Opera but Sec-CH-UA does not include \"Opera\".',
    'clientHints.warnings.fullVersionMismatch': 'Full version mismatch: UA is {{uaFullVersion}}, but Full-Version-List is {{hintsFullVersion}}.',
    'clientHints.errors.missingPlatform': 'Missing required Sec-CH-UA-Platform header.',
    'clientHints.errors.platformMismatch': 'Platform mismatch: UA is {{uaPlatform}}, but Sec-CH-UA-Platform is {{hintsPlatform}}.',
    'clientHints.warnings.platformVersionMismatch': 'Platform version mismatch: UA is {{uaVersion}}, but Platform-Version is {{hintsVersion}}.',
    'clientHints.errors.missingMobile': 'Missing required Sec-CH-UA-Mobile header.',
    'clientHints.errors.mobileMismatch': 'Mobile flag mismatch: UA {{isMobile}} mobile, but Sec-CH-UA-Mobile is {{secChUAMobile}}.',
    'clientHints.warnings.mobileModelMissing': 'Mobile UA without detected device model (may affect realism).',
    'clientHints.errors.iosArchInvalid': 'iOS device architecture must be ARM, but detected {{arch}}.',
    'clientHints.errors.appleSiliconArchInvalid': 'Apple Silicon (M1/M2/M3) detected but arch is not ARM.',
    'clientHints.warnings.appleSiliconMissing': 'Arch is ARM but no Apple Silicon markers in UA (may be spoofed).',
    'clientHints.warnings.windowsArmRare': 'Windows ARM devices are rare (e.g., Surface Pro X) and may attract attention.',
    'clientHints.warnings.androidX86Rare': 'Android x86 is usually only seen on emulators.',
    'clientHints.warnings.greaseMissing': 'No GREASE brand detected (may reduce anti-fingerprinting effectiveness).',
    'clientHints.warnings.greaseBrandFormatInvalid': 'GREASE brand format is invalid: \"{{brand}}\" (should include special characters).',
    'clientHints.warnings.greaseVersionInvalid': 'GREASE version is unusual: {{version}} (typically 8 or 99).',
    'clientHints.warnings.greaseBrandOutdated': 'GREASE brand format may be outdated: \"{{brand}}\".',
    'clientHints.labels.is': 'is',
    'clientHints.labels.isNot': 'is not',
  },
};

let currentLocale: AntiDetectLocale = 'zh-CN';
let externalTranslator: Translator | null = null;

const formatMessage = (template: string, params?: MessageParams): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
};

export const setAntiDetectLocale = (locale: AntiDetectLocale): void => {
  currentLocale = locale;
};

export const setAntiDetectTranslator = (translator: Translator | null): void => {
  externalTranslator = translator;
};

export const t = (key: string, params?: MessageParams): string => {
  if (externalTranslator) {
    return externalTranslator(`antiDetect.${key}`, params);
  }
  const template =
    MESSAGES[currentLocale]?.[key] ??
    MESSAGES['en-US']?.[key] ??
    key;
  return formatMessage(template, params);
};

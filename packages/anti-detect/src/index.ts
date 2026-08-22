export * from './types.js';
export * from './AntiDetectManager.js';
export * from './pool/UAPool.js';
export * from './pool/ProxyPool.js';
export * from './ProxyHealthChecker.js';
export { sharedAntiDetectManager } from './AntiDetectManager.js';

// 🆕 设备配置数据库
export * from './pool/device-profiles.js';

// 🆕 移动设备 UA 生成器
export * from './pool/mobile-ua-generator.js';

// 🆕 动态 UA 池（阶段 2）
export * from './pool/ChromeVersionTracker.js';
export * from './pool/DynamicUAPoolManager.js';

// Stealth 启动参数
export { STEALTH_ARGS, HARMFUL_ARGS_TO_REMOVE, applyStealthArgs } from './stealth/flags.js';

// ==================== i18n ====================
export { setAntiDetectLocale, setAntiDetectTranslator, t } from './i18n.js';

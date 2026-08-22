/**
 * Client Hints 模块统一导出
 *
 * 🎯 使用方式：
 * ```typescript
 * import { getClientHintsService, generateClientHintsHeaders } from '@tabtin/anti-detect/client-hints';
 *
 * // 方式 1：使用服务类
 * const service = getClientHintsService();
 * const hints = service.generate(userAgent);
 *
 * // 方式 2：快捷函数
 * const headers = generateClientHintsHeaders(userAgent);
 * ```
 */

// ===== 核心服务 =====
export {
  ClientHintsService,
  getClientHintsService,
  resetClientHintsService,
  generateClientHintsHeaders,
} from './ClientHintsService.js';

// ===== 类型定义 =====
export type {
  ClientHints,
  ClientHintsConfig,
  ParsedUserAgent,
  ValidationResult,
  GreaseBrand,
} from './types.js';

// ===== 工具函数 =====
export {
  // 解析器
  parseUserAgent,
  extractFullVersion,
  isWoW64,
} from './parsers.js';

export {
  // 生成器
  generateClientHints,
  clientHintsToHeaders,
  mergeClientHintsHeaders,
  createCustomGrease,
} from './generators.js';

export {
  // 验证器
  validateClientHints,
  quickValidate,
  autoFixClientHints,
} from './validators.js';

// ===== 常量 =====
export {
  getGreaseBrand,
  PLATFORM_NAMES,
  ARCH_NAMES,
  DEVICE_MODELS,
  DEFAULT_CLIENT_HINTS_CONFIG,
} from './constants.js';

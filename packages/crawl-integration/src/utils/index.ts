/**
 * 工具函数统一导出
 */

// 校验和工具
export {
  calculateChecksum,
  calculateStringChecksum,
  calculateBufferChecksum,
  calculateObjectChecksum,
  calculateFileChecksum,
  verifyChecksum,
  generateShortChecksum,
  calculateMultipleChecksums,
  IncrementalChecksum,
  ChecksumUtils
} from './checksum.js';

// 编码检测工具
export {
  EncodingType,
  detectEncoding,
  detectEncodingFromBOM,
  detectEncodingFromHeaders,
  detectEncodingFromHTML,
  detectEncodingFromContent,
  normalizeEncodingName,
  safeDecodeBuffer
} from './encoding.js';

// 重试机制工具
export {
  RetryExecutor,
  DEFAULT_RETRY_CONFIG,
  retry,
  retryOperation,
  retryOnError,
  retryWithLinearBackoff,
  retryWithFixedInterval,
  RetryStatsCollector
} from './retry.js';

export type {
  RetryConfig,
  RetryStats
} from './retry.js';

// URL 处理工具
export {
  validateURL,
  normalizeURL,
  parseURL,
  isRelativeURL,
  isAbsoluteURL,
  resolveURL,
  extractDomain,
  extractHostname,
  isSameDomain,
  isSameOrigin,
  buildQueryString,
  parseQueryString,
  addQueryParams,
  removeQueryParams,
  cleanURL,
  matchesPattern,
  matchesAnyPattern,
  generateURLId,
  checkURLSecurity,
  URLUtils
} from './url.js';

export type {
  URLValidationResult,
  ParsedURL,
  URLSecurityCheck
} from './url.js';

// 大小限制工具
export {
  calculateSize,
  exceedsLimit,
  truncateString,
  truncateBuffer,
  smartTruncate,
  truncateJSON,
  limitArraySize,
  MemoryMonitor,
  SizeLimitManager,
  sizeLimitManager
} from './limits.js';

export type {
  TruncationResult,
  SizeInfo
} from './limits.js';

// 熔断器
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState
} from './circuit-breaker.js';

export type {
  CircuitBreakerConfig
} from './circuit-breaker.js';

// ID 生成工具
export {
  generateId,
  generateShortId,
  generateTraceId
} from './id.js';

// 系统 User-Agent 工具
export {
  detectSystemInfo,
  generateSystemDesktopUA,
  getBrowserUserAgent,
  getSystemUserAgent,
  isSystemUserAgent,
  SystemUserAgentManager
} from './system-ua.js';

export type {
  SystemInfo,
  SystemInfo as SystemInfoType
} from './system-ua.js';

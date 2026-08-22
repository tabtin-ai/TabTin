/**
 * 错误类型和分类定义
 * 基于 ScrapePRD.md 中的错误处理设计
 */
import { t } from '../i18n.js';

// 错误代码枚举
export enum ErrorCode {
  // 网络相关错误
  TIMEOUT = 'TIMEOUT',
  NETWORK = 'NETWORK',
  DNS_RESOLUTION = 'DNS_RESOLUTION',
  CONNECTION_REFUSED = 'CONNECTION_REFUSED',
  SSL_ERROR = 'SSL_ERROR',

  // 解析相关错误
  PARSE = 'PARSE',
  ENCODING_ERROR = 'ENCODING_ERROR',
  INVALID_RESPONSE = 'INVALID_RESPONSE',

  // 认证和授权错误
  AUTH = 'AUTH',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',

  // 限流和反爬虫
  RATE_LIMIT = 'RATE_LIMIT',
  CAPTCHA = 'CAPTCHA',
  BOT_DETECTED = 'BOT_DETECTED',

  // 引擎相关错误
  ENGINE_NOT_AVAILABLE = 'ENGINE_NOT_AVAILABLE',
  ENGINE_INITIALIZATION_FAILED = 'ENGINE_INITIALIZATION_FAILED',
  BROWSER_CRASHED = 'BROWSER_CRASHED',
  PAGE_CRASHED = 'PAGE_CRASHED',

  // 配置和参数错误
  INVALID_URL = 'INVALID_URL',
  INVALID_OPTIONS = 'INVALID_OPTIONS',
  UNSUPPORTED_PROTOCOL = 'UNSUPPORTED_PROTOCOL',

  // 安全相关错误
  SSRF_BLOCKED = 'SSRF_BLOCKED',
  ROBOTS_DISALLOWED = 'ROBOTS_DISALLOWED',

  // 资源限制错误
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  MEMORY_LIMIT_EXCEEDED = 'MEMORY_LIMIT_EXCEEDED',

  // 通用错误
  UNKNOWN = 'UNKNOWN',
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}

// 错误分类
export enum ErrorCategory {
  RETRYABLE = 'RETRYABLE',           // 可重试错误
  ENGINE_SWITCH = 'ENGINE_SWITCH',   // 需要切换引擎
  HUMAN_CHECK = 'HUMAN_CHECK',       // 需要人工干预
  FATAL = 'FATAL'                    // 致命错误，无法恢复
}

// 人机验证类型
export enum HumanCheckType {
  CAPTCHA = 'captcha',
  MFA = 'mfa',
  LOGIN_REQUIRED = 'login_required',
  PHONE_VERIFICATION = 'phone_verification',
  EMAIL_VERIFICATION = 'email_verification'
}

// 错误详情接口
export interface ErrorDetails {
  statusCode?: number;
  originalError?: string;
  stack?: string;
  url?: string;
  engine?: string;
  retryCount?: number;
  timestamp?: Date;
  context?: Record<string, any>;
}

// 抓取错误接口
export interface CrawlError {
  code: ErrorCode;
  message: string;
  category: ErrorCategory;

  // 人机验证信息
  humanCheck?: HumanCheckType;

  // 错误提示和建议
  hints?: string[];
  suggestions?: string[];

  // 详细信息
  details?: ErrorDetails;

  // 重试相关
  retryable: boolean;
  retryAfter?: number; // 建议重试间隔（毫秒）

  // 引擎切换建议
  suggestedEngine?: string;
}

// 错误代码到分类的映射
export const ERROR_CODE_TO_CATEGORY: Record<ErrorCode, ErrorCategory> = {
  // 可重试错误
  [ErrorCode.TIMEOUT]: ErrorCategory.RETRYABLE,
  [ErrorCode.NETWORK]: ErrorCategory.RETRYABLE,
  [ErrorCode.DNS_RESOLUTION]: ErrorCategory.RETRYABLE,
  [ErrorCode.CONNECTION_REFUSED]: ErrorCategory.RETRYABLE,
  [ErrorCode.RATE_LIMIT]: ErrorCategory.RETRYABLE,

  // 需要切换引擎
  [ErrorCode.PARSE]: ErrorCategory.ENGINE_SWITCH,
  [ErrorCode.ENGINE_NOT_AVAILABLE]: ErrorCategory.ENGINE_SWITCH,
  [ErrorCode.ENGINE_INITIALIZATION_FAILED]: ErrorCategory.ENGINE_SWITCH,
  [ErrorCode.BROWSER_CRASHED]: ErrorCategory.ENGINE_SWITCH,
  [ErrorCode.PAGE_CRASHED]: ErrorCategory.ENGINE_SWITCH,
  [ErrorCode.UNSUPPORTED_PROTOCOL]: ErrorCategory.ENGINE_SWITCH,

  // 需要人工干预
  [ErrorCode.AUTH]: ErrorCategory.HUMAN_CHECK,
  [ErrorCode.UNAUTHORIZED]: ErrorCategory.HUMAN_CHECK,
  [ErrorCode.CAPTCHA]: ErrorCategory.HUMAN_CHECK,
  [ErrorCode.BOT_DETECTED]: ErrorCategory.HUMAN_CHECK,

  // 致命错误
  [ErrorCode.FORBIDDEN]: ErrorCategory.FATAL,
  [ErrorCode.INVALID_URL]: ErrorCategory.FATAL,
  [ErrorCode.INVALID_OPTIONS]: ErrorCategory.FATAL,
  [ErrorCode.SSRF_BLOCKED]: ErrorCategory.FATAL,
  [ErrorCode.ROBOTS_DISALLOWED]: ErrorCategory.FATAL,
  [ErrorCode.PAYLOAD_TOO_LARGE]: ErrorCategory.FATAL,
  [ErrorCode.MEMORY_LIMIT_EXCEEDED]: ErrorCategory.FATAL,
  [ErrorCode.SSL_ERROR]: ErrorCategory.FATAL,
  [ErrorCode.ENCODING_ERROR]: ErrorCategory.FATAL,
  [ErrorCode.INVALID_RESPONSE]: ErrorCategory.FATAL,
  [ErrorCode.UNKNOWN]: ErrorCategory.FATAL,
  [ErrorCode.INTERNAL_ERROR]: ErrorCategory.FATAL
};

// 错误代码到人机验证类型的映射
export const ERROR_CODE_TO_HUMAN_CHECK: Partial<Record<ErrorCode, HumanCheckType>> = {
  [ErrorCode.CAPTCHA]: HumanCheckType.CAPTCHA,
  [ErrorCode.AUTH]: HumanCheckType.LOGIN_REQUIRED,
  [ErrorCode.UNAUTHORIZED]: HumanCheckType.LOGIN_REQUIRED
};

// 创建抓取错误的工厂函数
export function createCrawlError(
  code: ErrorCode,
  message: string,
  details?: Partial<ErrorDetails>
): CrawlError {
  const category = ERROR_CODE_TO_CATEGORY[code];
  const humanCheck = ERROR_CODE_TO_HUMAN_CHECK[code];

  return {
    code,
    message,
    category,
    humanCheck,
    retryable: category === ErrorCategory.RETRYABLE,
    details: details ? {
      timestamp: new Date(),
      ...details
    } : undefined,
    hints: generateErrorHints(code),
    suggestions: generateErrorSuggestions(code, category)
  };
}

// 生成错误提示
function generateErrorHints(code: ErrorCode): string[] {
  const hints: string[] = [];

  switch (code) {
    case ErrorCode.TIMEOUT:
      hints.push('request_timeout', 'slow_network');
      break;
    case ErrorCode.RATE_LIMIT:
      hints.push('rate_limited', 'too_many_requests');
      break;
    case ErrorCode.CAPTCHA:
      hints.push('captcha_required', 'bot_detected');
      break;
    case ErrorCode.SSRF_BLOCKED:
      hints.push('ssrf_blocked', 'internal_network');
      break;
    case ErrorCode.ROBOTS_DISALLOWED:
      hints.push('robots_disallowed', 'crawling_forbidden');
      break;
  }

  return hints;
}

// 生成错误建议
function generateErrorSuggestions(code: ErrorCode, category: ErrorCategory): string[] {
  const suggestions: string[] = [];

  switch (category) {
    case ErrorCategory.RETRYABLE:
      suggestions.push(t('errors.suggestions.retryBackoff'));
      if (code === ErrorCode.RATE_LIMIT) {
        suggestions.push(t('errors.suggestions.reduceFrequency'));
        suggestions.push(t('errors.suggestions.rotateProxy'));
      }
      break;

    case ErrorCategory.ENGINE_SWITCH:
      suggestions.push(t('errors.suggestions.tryAlternativeEngine'));
      if (code === ErrorCode.PARSE) {
        suggestions.push(t('errors.suggestions.switchToWebContents'));
      }
      break;

    case ErrorCategory.HUMAN_CHECK:
      suggestions.push(t('errors.suggestions.manualIntervention'));
      if (code === ErrorCode.CAPTCHA) {
        suggestions.push(t('errors.suggestions.solveCaptcha'));
        suggestions.push(t('errors.suggestions.changeUserAgent'));
      }
      break;

    case ErrorCategory.FATAL:
      suggestions.push(t('errors.suggestions.checkConfigAndUrl'));
      break;
  }

  return suggestions;
}

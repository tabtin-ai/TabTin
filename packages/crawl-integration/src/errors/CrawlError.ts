/**
 * 抓取错误类
 * 扩展标准 Error 类，提供更丰富的错误信息
 */

import { ErrorCode, ErrorCategory, HumanCheckType, ErrorDetails, createCrawlError } from '../types/errors.js';
import { t } from '../i18n.js';

export class CrawlError extends Error {
  public readonly code: ErrorCode;
  public readonly category: ErrorCategory;
  public readonly humanCheck?: HumanCheckType;
  public readonly hints?: string[];
  public readonly suggestions?: string[];
  public readonly details?: ErrorDetails;
  public readonly retryable: boolean;
  public readonly retryAfter?: number;
  public readonly suggestedEngine?: string;

  constructor(
    code: ErrorCode | string,
    message: string,
    details?: Partial<ErrorDetails>
  ) {
    super(message);

    this.name = 'CrawlError';

    // 如果传入的是字符串，尝试转换为 ErrorCode
    if (typeof code === 'string') {
      this.code = this.parseErrorCode(code);
    } else {
      this.code = code;
    }

    // 使用工厂函数创建错误信息
    const errorInfo = createCrawlError(this.code, message, details);

    this.category = errorInfo.category;
    this.humanCheck = errorInfo.humanCheck;
    this.hints = errorInfo.hints;
    this.suggestions = errorInfo.suggestions;
    this.retryable = errorInfo.retryable;
    this.retryAfter = errorInfo.retryAfter;
    this.suggestedEngine = errorInfo.suggestedEngine;

    this.details = {
      timestamp: new Date(),
      ...details
    };

    // 确保堆栈跟踪正确
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CrawlError);
    }
  }

  /**
   * 解析字符串错误代码
   */
  private parseErrorCode(code: string): ErrorCode {
    // 尝试直接匹配
    if (Object.values(ErrorCode).includes(code as ErrorCode)) {
      return code as ErrorCode;
    }

    // 常见错误代码映射
    const codeMapping: Record<string, ErrorCode> = {
      'ECONNABORTED': ErrorCode.TIMEOUT,
      'ENOTFOUND': ErrorCode.DNS_RESOLUTION,
      'ECONNREFUSED': ErrorCode.CONNECTION_REFUSED,
      'ECONNRESET': ErrorCode.NETWORK,
      'ETIMEDOUT': ErrorCode.TIMEOUT,
      'CERT_HAS_EXPIRED': ErrorCode.SSL_ERROR,
      'CERT_UNTRUSTED': ErrorCode.SSL_ERROR,
      'ENGINE_INIT_FAILED': ErrorCode.ENGINE_INITIALIZATION_FAILED,
      'HTTP_ERROR': ErrorCode.NETWORK
    };

    return codeMapping[code] || ErrorCode.UNKNOWN;
  }

  /**
   * 检查是否为特定类型的错误
   */
  public isType(code: ErrorCode): boolean {
    return this.code === code;
  }

  /**
   * 检查是否为特定分类的错误
   */
  public isCategory(category: ErrorCategory): boolean {
    return this.category === category;
  }

  /**
   * 检查是否可重试
   */
  public isRetryable(): boolean {
    return this.retryable;
  }

  /**
   * 检查是否需要人工干预
   */
  public needsHumanIntervention(): boolean {
    return this.category === ErrorCategory.HUMAN_CHECK;
  }

  /**
   * 检查是否需要切换引擎
   */
  public needsEngineSwitch(): boolean {
    return this.category === ErrorCategory.ENGINE_SWITCH;
  }

  /**
   * 获取建议的重试延迟时间
   */
  public getRetryDelay(): number {
    if (!this.retryable) return 0;

    if (this.retryAfter) {
      return this.retryAfter;
    }

    // 根据错误类型返回默认延迟
    switch (this.code) {
      case ErrorCode.RATE_LIMIT:
        return 5000; // 5秒
      case ErrorCode.TIMEOUT:
        return 2000; // 2秒
      case ErrorCode.NETWORK:
        return 1000; // 1秒
      default:
        return 1000;
    }
  }

  /**
   * 转换为 JSON 格式（用于序列化）
   */
  public toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      humanCheck: this.humanCheck,
      hints: this.hints,
      suggestions: this.suggestions,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      suggestedEngine: this.suggestedEngine,
      details: this.details,
      stack: this.stack
    };
  }

  /**
   * 转换为用户友好的字符串
   */
  public toUserString(): string {
    let result = `${this.message}`;

    if (this.suggestions && this.suggestions.length > 0) {
      result += `\n${t('errors.crawl.suggestionsLabel')}: ${this.suggestions.join(', ')}`;
    }

    if (this.retryable) {
      const delay = this.getRetryDelay();
      result += `\n${t('errors.crawl.retryAfter', { ms: delay })}`;
    }

    return result;
  }

  /**
   * 创建带有额外上下文的新错误
   */
  public withContext(context: Record<string, any>): CrawlError {
    const newDetails = {
      ...this.details,
      context: {
        ...this.details?.context,
        ...context
      }
    };

    return new CrawlError(this.code, this.message, newDetails);
  }

  /**
   * 创建带有重试计数的新错误
   */
  public withRetryCount(retryCount: number): CrawlError {
    const newDetails = {
      ...this.details,
      retryCount
    };

    return new CrawlError(this.code, this.message, newDetails);
  }

  /**
   * 从标准 Error 创建 CrawlError
   */
  public static fromError(error: Error, code?: ErrorCode): CrawlError {
    if (error instanceof CrawlError) {
      return error;
    }

    const errorCode = code || ErrorCode.UNKNOWN;

    return new CrawlError(errorCode, error.message, {
      originalError: error.message,
      stack: error.stack
    });
  }

  /**
   * 从 HTTP 响应创建错误
   */
  public static fromHttpResponse(
    statusCode: number,
    statusText: string,
    url?: string
  ): CrawlError {
    let code: ErrorCode;
    let message: string;

    if (statusCode >= 400 && statusCode < 500) {
      // 客户端错误
      switch (statusCode) {
        case 401:
          code = ErrorCode.UNAUTHORIZED;
          message = t('errors.http.unauthorized');
          break;
        case 403:
          code = ErrorCode.FORBIDDEN;
          message = t('errors.http.forbidden');
          break;
        case 429:
          code = ErrorCode.RATE_LIMIT;
          message = t('errors.http.rateLimit');
          break;
        default:
          code = ErrorCode.NETWORK;
          message = t('errors.http.clientError', { status: statusCode, statusText });
      }
    } else if (statusCode >= 500) {
      // 服务器错误
      code = ErrorCode.NETWORK;
      message = t('errors.http.serverError', { status: statusCode, statusText });
    } else {
      // 其他状态码
      code = ErrorCode.NETWORK;
      message = t('errors.http.generic', { status: statusCode, statusText });
    }

    return new CrawlError(code, message, {
      statusCode,
      url
    });
  }

  /**
   * 检查错误是否表示需要认证
   */
  public isAuthenticationRequired(): boolean {
    return this.code === ErrorCode.UNAUTHORIZED ||
           this.code === ErrorCode.AUTH ||
           (this.details?.statusCode === 401);
  }

  /**
   * 检查错误是否表示被限流
   */
  public isRateLimited(): boolean {
    return this.code === ErrorCode.RATE_LIMIT ||
           (this.details?.statusCode === 429);
  }

  /**
   * 检查错误是否表示网络问题
   */
  public isNetworkError(): boolean {
    return [
      ErrorCode.NETWORK,
      ErrorCode.TIMEOUT,
      ErrorCode.DNS_RESOLUTION,
      ErrorCode.CONNECTION_REFUSED,
      ErrorCode.SSL_ERROR
    ].includes(this.code);
  }
}

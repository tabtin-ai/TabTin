/**
 * 隐私脱敏工具
 * 提供智能的敏感信息脱敏功能
 */

import { Cookie } from '../types/access-result.js';

export interface MaskingOptions {
  maskFields?: string[];           // 自定义脱敏字段
  preserveLength?: boolean;        // 是否保持原长度
  maskPattern?: string;            // 脱敏字符，默认 '*'
  showPrefix?: number;             // 显示前缀字符数
  showSuffix?: number;             // 显示后缀字符数
}

export interface MaskingResult {
  masked: Record<string, string>;  // 脱敏后的数据
  maskedFields: string[];          // 被脱敏的字段列表
  originalCount: number;           // 原始字段数量
  maskedCount: number;             // 脱敏字段数量
}

export class PrivacyMasker {
  // 默认敏感字段模式
  private static readonly DEFAULT_SENSITIVE_PATTERNS = [
    // 认证相关
    /^authorization$/i,
    /^bearer$/i,
    /^token$/i,
    /^jwt$/i,
    /^api[-_]?key$/i,
    /^x[-_]?api[-_]?key$/i,
    /^x[-_]?auth[-_]?token$/i,
    /^x[-_]?access[-_]?token$/i,
    /^x[-_]?csrf[-_]?token$/i,

    // 会话相关
    /^cookie$/i,
    /^set[-_]?cookie$/i,
    /^session$/i,
    /^session[-_]?id$/i,
    /^jsessionid$/i,
    /^phpsessid$/i,

    // 用户信息
    /^x[-_]?user[-_]?id$/i,
    /^x[-_]?user[-_]?token$/i,
    /^x[-_]?forwarded[-_]?for$/i,
    /^x[-_]?real[-_]?ip$/i,

    // 安全相关
    /^x[-_]?signature$/i,
    /^x[-_]?hash$/i,
    /^x[-_]?checksum$/i,

    // 自定义头部
    /password/i,
    /secret/i,
    /private/i,
    /confidential/i
  ];

  // 敏感 Cookie 名称模式
  private static readonly SENSITIVE_COOKIE_PATTERNS = [
    /session/i,
    /auth/i,
    /token/i,
    /jwt/i,
    /csrf/i,
    /login/i,
    /user/i,
    /account/i,
    /remember/i,
    /secure/i
  ];

  // 敏感 URL 参数模式
  private static readonly SENSITIVE_URL_PATTERNS = [
    /token/i,
    /key/i,
    /secret/i,
    /password/i,
    /auth/i,
    /session/i,
    /signature/i,
    /hash/i
  ];

  /**
   * 脱敏请求头
   */
  static maskHeaders(headers: Record<string, string>, options: MaskingOptions = {}): MaskingResult {
    const masked: Record<string, string> = {};
    const maskedFields: string[] = [];
    const originalCount = Object.keys(headers).length;

    for (const [key, value] of Object.entries(headers)) {
      if (this.isSensitiveHeader(key, options.maskFields)) {
        masked[key] = this.maskValue(value, options);
        maskedFields.push(key);
      } else {
        masked[key] = value;
      }
    }

    return {
      masked,
      maskedFields,
      originalCount,
      maskedCount: maskedFields.length
    };
  }

  /**
   * 脱敏 Cookie
   */
  static maskCookies(cookies: Cookie[], options: MaskingOptions = {}): {
    masked: Cookie[];
    maskedFields: string[];
    originalCount: number;
    maskedCount: number;
  } {
    const masked: Cookie[] = [];
    const maskedFields: string[] = [];
    const originalCount = cookies.length;

    for (const cookie of cookies) {
      if (this.isSensitiveCookie(cookie.name, options.maskFields)) {
        masked.push({
          ...cookie,
          value: this.maskValue(cookie.value, options)
        });
        maskedFields.push(cookie.name);
      } else {
        masked.push(cookie);
      }
    }

    return {
      masked,
      maskedFields,
      originalCount,
      maskedCount: maskedFields.length
    };
  }

  /**
   * 脱敏 URL 参数
   */
  static maskUrl(url: string, options: MaskingOptions = {}): {
    maskedUrl: string;
    maskedFields: string[];
    originalParamCount: number;
    maskedParamCount: number;
  } {
    try {
      const parsed = new URL(url);
      const maskedFields: string[] = [];
      const originalParamCount = parsed.searchParams.size;

      for (const [key, value] of parsed.searchParams.entries()) {
        if (this.isSensitiveUrlParam(key, options.maskFields)) {
          parsed.searchParams.set(key, this.maskValue(value, options));
          maskedFields.push(key);
        }
      }

      return {
        maskedUrl: parsed.toString(),
        maskedFields,
        originalParamCount,
        maskedParamCount: maskedFields.length
      };
    } catch {
      return {
        maskedUrl: url,
        maskedFields: [],
        originalParamCount: 0,
        maskedParamCount: 0
      };
    }
  }

  /**
   * 脱敏任意对象
   */
  static maskObject(obj: Record<string, any>, options: MaskingOptions = {}): MaskingResult {
    const masked: Record<string, any> = {};
    const maskedFields: string[] = [];
    const originalCount = Object.keys(obj).length;

    for (const [key, value] of Object.entries(obj)) {
      if (this.isSensitiveField(key, options.maskFields)) {
        if (typeof value === 'string') {
          masked[key] = this.maskValue(value, options);
        } else {
          masked[key] = '[MASKED_OBJECT]';
        }
        maskedFields.push(key);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // 递归处理嵌套对象
        const nestedResult = this.maskObject(value, options);
        masked[key] = nestedResult.masked;
        maskedFields.push(...nestedResult.maskedFields.map(field => `${key}.${field}`));
      } else {
        masked[key] = value;
      }
    }

    return {
      masked,
      maskedFields,
      originalCount,
      maskedCount: maskedFields.length
    };
  }

  /**
   * 检查是否为敏感头部
   */
  private static isSensitiveHeader(headerName: string, customFields?: string[]): boolean {
    // 检查自定义字段
    if (customFields?.includes(headerName.toLowerCase())) {
      return true;
    }

    // 检查默认模式
    return this.DEFAULT_SENSITIVE_PATTERNS.some(pattern => pattern.test(headerName));
  }

  /**
   * 检查是否为敏感 Cookie
   */
  private static isSensitiveCookie(cookieName: string, customFields?: string[]): boolean {
    // 检查自定义字段
    if (customFields?.includes(cookieName.toLowerCase())) {
      return true;
    }

    // 检查默认模式
    return this.SENSITIVE_COOKIE_PATTERNS.some(pattern => pattern.test(cookieName));
  }

  /**
   * 检查是否为敏感 URL 参数
   */
  private static isSensitiveUrlParam(paramName: string, customFields?: string[]): boolean {
    // 检查自定义字段
    if (customFields?.includes(paramName.toLowerCase())) {
      return true;
    }

    // 检查默认模式
    return this.SENSITIVE_URL_PATTERNS.some(pattern => pattern.test(paramName));
  }

  /**
   * 检查是否为敏感字段（通用）
   */
  private static isSensitiveField(fieldName: string, customFields?: string[]): boolean {
    // 检查自定义字段
    if (customFields?.includes(fieldName.toLowerCase())) {
      return true;
    }

    // 检查所有默认模式
    return [...this.DEFAULT_SENSITIVE_PATTERNS, ...this.SENSITIVE_COOKIE_PATTERNS, ...this.SENSITIVE_URL_PATTERNS]
      .some(pattern => pattern.test(fieldName));
  }

  /**
   * 脱敏单个值
   */
  private static maskValue(value: string, options: MaskingOptions = {}): string {
    if (!value) return value;

    const {
      preserveLength = true,
      maskPattern = '*',
      showPrefix = 4,
      showSuffix = 4
    } = options;

    // 对于很短的值，完全脱敏
    if (value.length <= 8) {
      return preserveLength ? maskPattern.repeat(value.length) : '***';
    }

    // 显示前缀和后缀
    const prefixLength = Math.min(showPrefix, Math.floor(value.length * 0.2));
    const suffixLength = Math.min(showSuffix, Math.floor(value.length * 0.2));
    const maskLength = value.length - prefixLength - suffixLength;

    if (maskLength <= 0) {
      return preserveLength ? maskPattern.repeat(value.length) : '***';
    }

    const prefix = value.substring(0, prefixLength);
    const suffix = value.substring(value.length - suffixLength);
    const mask = preserveLength ? maskPattern.repeat(maskLength) : '***';

    return `${prefix}${mask}${suffix}`;
  }

  /**
   * 生成脱敏报告
   */
  static generateMaskingReport(
    headers: Record<string, string>,
    cookies: Cookie[],
    url: string,
    options: MaskingOptions = {}
  ): {
    summary: {
      totalFields: number;
      maskedFields: number;
      maskingRate: number;
    };
    details: {
      headers: MaskingResult;
      cookies: ReturnType<typeof PrivacyMasker.maskCookies>;
      url: ReturnType<typeof PrivacyMasker.maskUrl>;
    };
    maskedFieldsList: string[];
  } {
    const headerResult = this.maskHeaders(headers, options);
    const cookieResult = this.maskCookies(cookies, options);
    const urlResult = this.maskUrl(url, options);

    const totalFields = headerResult.originalCount + cookieResult.originalCount + urlResult.originalParamCount;
    const maskedFields = headerResult.maskedCount + cookieResult.maskedCount + urlResult.maskedParamCount;
    const maskingRate = totalFields > 0 ? (maskedFields / totalFields) * 100 : 0;

    const maskedFieldsList = [
      ...headerResult.maskedFields.map(field => `header:${field}`),
      ...cookieResult.maskedFields.map(field => `cookie:${field}`),
      ...urlResult.maskedFields.map(field => `url_param:${field}`)
    ];

    return {
      summary: {
        totalFields,
        maskedFields,
        maskingRate: Math.round(maskingRate * 100) / 100
      },
      details: {
        headers: headerResult,
        cookies: cookieResult,
        url: urlResult
      },
      maskedFieldsList
    };
  }

  /**
   * 检查数据是否包含敏感信息
   */
  static containsSensitiveData(
    headers: Record<string, string>,
    cookies: Cookie[],
    url: string,
    customFields?: string[]
  ): {
    hasSensitiveData: boolean;
    sensitiveFields: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  } {
    const sensitiveFields: string[] = [];

    // 检查头部
    for (const headerName of Object.keys(headers)) {
      if (this.isSensitiveHeader(headerName, customFields)) {
        sensitiveFields.push(`header:${headerName}`);
      }
    }

    // 检查 Cookie
    for (const cookie of cookies) {
      if (this.isSensitiveCookie(cookie.name, customFields)) {
        sensitiveFields.push(`cookie:${cookie.name}`);
      }
    }

    // 检查 URL 参数
    try {
      const parsed = new URL(url);
      for (const [paramName] of parsed.searchParams.entries()) {
        if (this.isSensitiveUrlParam(paramName, customFields)) {
          sensitiveFields.push(`url_param:${paramName}`);
        }
      }
    } catch {
      // URL 解析失败，忽略
    }

    const hasSensitiveData = sensitiveFields.length > 0;
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

    if (sensitiveFields.length >= 5) {
      riskLevel = 'HIGH';
    } else if (sensitiveFields.length >= 2) {
      riskLevel = 'MEDIUM';
    }

    return {
      hasSensitiveData,
      sensitiveFields,
      riskLevel
    };
  }
}

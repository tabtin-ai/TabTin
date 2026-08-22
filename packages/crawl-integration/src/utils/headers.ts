/**
 * HTTP 头部处理工具
 * 提供头部规范化、去重、合并等功能
 */

/**
 * 规范化响应头：去重、合并大小写、处理重复值
 * 避免把"脏"头写进缓存或 UI
 */
export function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();

    // 统一处理：将值转为数组，分割逗号，去重，合并
    const values = Array.isArray(value) ? value : [value];
    const flatValues = values.flatMap(v =>
      v.split(',').map(s => s.trim()).filter(Boolean)
    );
    const uniqueValues = [...new Set(flatValues)];
    normalized[normalizedKey] = uniqueValues.join(', ');
  }

  return normalized;
}

/**
 * 合并多个头部对象，后面的覆盖前面的
 */
export function mergeHeaders(...headerObjects: Array<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const headers of headerObjects) {
    for (const [key, value] of Object.entries(headers)) {
      merged[key.toLowerCase()] = value;
    }
  }

  return merged;
}

/**
 * 提取安全相关的头部（用于缓存键生成）
 */
export function extractSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  const securityHeaders: Record<string, string> = {};
  const securityKeys = [
    'authorization',
    'cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'bearer'
  ];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (securityKeys.includes(lowerKey)) {
      securityHeaders[lowerKey] = value;
    }
  }

  return securityHeaders;
}

/**
 * 提取影响响应的关键头部（用于缓存键生成）
 */
export function extractCacheRelevantHeaders(headers: Record<string, string>): Record<string, string> {
  const relevantHeaders: Record<string, string> = {};
  const relevantKeys = [
    'accept',
    'accept-encoding',
    'accept-language',
    'content-type',
    'user-agent',
    'if-none-match',
    'if-modified-since',
    'authorization'  // 通常不缓存，但如果缓存则需要进键
  ];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (relevantKeys.includes(lowerKey)) {
      relevantHeaders[lowerKey] = value;
    }
  }

  return relevantHeaders;
}

/**
 * 移除易变但对响应不敏感的头部
 */
export function removeVolatileHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  const volatileKeys = [
    'date',
    'connection',
    'keep-alive',
    'proxy-connection',
    'upgrade',
    'via',
    'warning',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-real-ip',
    'x-request-id',
    'x-correlation-id'
  ];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (!volatileKeys.includes(lowerKey)) {
      cleaned[lowerKey] = value;
    }
  }

  return cleaned;
}

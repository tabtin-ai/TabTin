/**
 * ID 生成工具
 */

import crypto from 'crypto';

/**
 * 生成唯一 ID
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * 生成短 ID（用于日志等场景）
 */
export function generateShortId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * 生成追踪 ID（用于请求追踪）
 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

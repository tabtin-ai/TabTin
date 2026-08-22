import * as path from 'node:path';
import type {
  ToolResult,
} from '../../engine/contracts/tools.js';

/**
 * 只读取本机平台数据（tool-logs / archive 等）的只读工具共享原语。
 *
 * `RawRefCap` 和 `PlatformDataCap` 都读同一棵平台托管目录树，且共用同一套
 * 入参解析 / 路径安全 / bounded-read 口径。这些原语集中在此处，避免两个 Cap
 * 各自维护一份会漂移的拷贝（数值阈值由各 Cap 以参数传入，保持各自语义）。
 */

/** 单个路径段安全字符集：字母数字 + `_.:-`，长度 1..160，且不是 `.` / `..`。 */
export const SAFE_PATH_SEGMENT_RE = /^[a-zA-Z0-9_.:-]{1,160}$/;

export function jsonResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: JSON.stringify(payload),
    ...(isError ? { isError: true } : {}),
  };
}

export function readString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input.trim() : undefined;
}

export function readInteger(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isInteger(input) ? input : undefined;
}

export function clampMaxChars(input: unknown, defaultMax: number, hardMax: number): number {
  const value = readInteger(input);
  if (value === undefined || value <= 0) return defaultMax;
  return Math.min(value, hardMax);
}

export function isSafePathSegment(value: string): boolean {
  return SAFE_PATH_SEGMENT_RE.test(value) && value !== '.' && value !== '..';
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function permissionDenied(message: string): ToolResult {
  return jsonResult({
    success: false,
    error_kind: 'permission_denied',
    error: message,
  }, true);
}

export function applyGrep(content: string, pattern: string | undefined): string {
  if (!pattern) return content;
  const lowerPattern = pattern.toLowerCase();
  return content
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(lowerPattern))
    .join('\n');
}

/**
 * 审计中间件 — 记录每次能力调用的参数摘要、结果摘要与耗时，便于追踪与调试。
 *
 * 审计逻辑失败时静默忽略，不阻断能力执行。
 */

import type { CapabilityResult } from '../types.js';
import type { CapabilityMiddleware, WrapExecuteOptions } from './types.js';

const DEFAULT_PARAMS_SUMMARY_MAX = 512;
const DEFAULT_RESULT_SUMMARY_MAX = 512;

export interface AuditEntry {
  capabilityId: string;
  /** 能力调用开始的 ISO 8601 时间 */
  timestamp: string;
  durationMs: number;
  success: boolean;
  error?: string;
  /** includeParams 为 true 时为原始参数；否则通常省略（见 resultSummary 中的摘要） */
  params?: unknown;
  /** 参数与/或结果的简短摘要（避免日志过大） */
  resultSummary?: string;
  /** includeResult 为 true 时的完整结果 */
  result?: unknown;
}

/** 调用开始前写入的一条记录（无耗时与成败字段） */
export interface AuditBeginEntry {
  capabilityId: string;
  timestamp: string;
  params?: unknown;
  /** includeParams 为 false 时的参数摘要 */
  paramsSummary?: string;
}

export type AuditLogEntry = AuditEntry | AuditBeginEntry;

export interface AuditMiddlewareOptions {
  /** 自定义日志处理器；默认使用 console.info */
  logger?: (entry: AuditLogEntry) => void;
  /** 是否在条目中包含完整调用参数（默认 false） */
  includeParams?: boolean;
  /** 是否在条目中包含完整返回结果（默认 false） */
  includeResult?: boolean;
}

function defaultLogger(entry: AuditLogEntry): void {
  console.info('[media-capabilities:audit]', entry);
}

function safeLog(log: () => void): void {
  try {
    log();
  } catch {
    // 审计失败不影响业务
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…(truncated)`;
}

function summarizeParams(params: unknown, maxLen: number): string {
  if (params === null) return 'null';
  if (params === undefined) return 'undefined';
  if (typeof params === 'string') return truncate(params, maxLen);
  if (typeof params === 'number' || typeof params === 'boolean' || typeof params === 'bigint') {
    return String(params);
  }
  if (typeof params === 'symbol') return params.toString();
  if (typeof params === 'function') return `[function ${params.name || 'anonymous'}]`;

  try {
    const json = JSON.stringify(params);
    if (json !== undefined) return truncate(json, maxLen);
  } catch {
    // fall through
  }

  if (Array.isArray(params)) return `array(length=${params.length})`;
  if (typeof params === 'object') {
    const keys = Object.keys(params as object);
    return `object(keys=${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''})`;
  }

  return String(params);
}

function summarizeResult(result: CapabilityResult, maxLen: number): string {
  const parts: string[] = [];

  if (result.url) parts.push(`url=${truncate(String(result.url), 120)}`);
  if (result.localPath) parts.push(`localPath=${truncate(String(result.localPath), 120)}`);
  if (result.mimeType) parts.push(`mimeType=${result.mimeType}`);
  if (typeof result.width === 'number' && typeof result.height === 'number') {
    parts.push(`${result.width}x${result.height}`);
  }
  if (typeof result.fileSize === 'number') parts.push(`fileSize=${result.fileSize}`);

  const { provenance } = result;
  if (provenance?.model) parts.push(`model=${String(provenance.model)}`);
  if (provenance?.taskId) parts.push(`taskId=${String(provenance.taskId)}`);

  if (result.data !== undefined) {
    try {
      const d = JSON.stringify(result.data);
      parts.push(`data=${truncate(d ?? '', maxLen)}`);
    } catch {
      parts.push('data=[unserializable]');
    }
  }

  if (parts.length === 0) {
    try {
      return truncate(JSON.stringify(result), maxLen);
    } catch {
      return '[CapabilityResult]';
    }
  }

  return truncate(parts.join(' '), maxLen);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createAuditMiddleware(options?: AuditMiddlewareOptions): CapabilityMiddleware {
  const logger = options?.logger ?? defaultLogger;
  const includeParams = options?.includeParams ?? false;
  const includeResult = options?.includeResult ?? false;

  return {
    name: 'audit',

    async wrapExecute(wrapOpts: WrapExecuteOptions) {
      const { doExecute, params, capabilityId } = wrapOpts;
      const started = Date.now();
      const timestamp = new Date(started).toISOString();

      const paramsForEntry = includeParams ? params : undefined;
      const paramsSummary = includeParams ? undefined : summarizeParams(params, DEFAULT_PARAMS_SUMMARY_MAX);

      const beginEntry: AuditBeginEntry = {
        capabilityId,
        timestamp,
        ...(paramsForEntry !== undefined ? { params: paramsForEntry } : {}),
        ...(paramsSummary !== undefined ? { paramsSummary } : {}),
      };

      safeLog(() => {
        logger(beginEntry);
      });

      function buildResultSummary(resultPart: string | undefined): string | undefined {
        if (paramsSummary === undefined && resultPart === undefined) return undefined;
        const chunks: string[] = [];
        if (paramsSummary !== undefined) chunks.push(`params: ${paramsSummary}`);
        if (resultPart !== undefined) chunks.push(`result: ${resultPart}`);
        return truncate(chunks.join(' | '), DEFAULT_RESULT_SUMMARY_MAX * 2);
      }

      try {
        const result = await doExecute();
        const durationMs = Date.now() - started;

        const resultPart = includeResult
          ? undefined
          : summarizeResult(result as CapabilityResult, DEFAULT_RESULT_SUMMARY_MAX);

        const entry: AuditEntry = {
          capabilityId,
          timestamp,
          durationMs,
          success: true,
          ...(paramsForEntry !== undefined ? { params: paramsForEntry } : {}),
          resultSummary: includeResult ? undefined : buildResultSummary(resultPart),
          ...(includeResult ? { result } : {}),
        };

        safeLog(() => {
          logger(entry);
        });

        return result;
      } catch (err: unknown) {
        const durationMs = Date.now() - started;

        const entry: AuditEntry = {
          capabilityId,
          timestamp,
          durationMs,
          success: false,
          error: errorMessage(err),
          ...(paramsForEntry !== undefined ? { params: paramsForEntry } : {}),
          resultSummary: buildResultSummary(undefined),
        };

        safeLog(() => {
          logger(entry);
        });

        throw err;
      }
    },
  };
}

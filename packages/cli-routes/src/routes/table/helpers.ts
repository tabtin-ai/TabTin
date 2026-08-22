import type { ServerResponse } from 'node:http';
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core';
import { resolveSpaceId } from '../../host-bindings.js';

export const LOG_TAG = '[CLI Table]';

// ── Field type inference ─────────────────────────────────

const URL_RE = /^https?:\/\//i;
const PROTOCOL_RELATIVE_URL_RE =
  /^\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?#].*)?$/;
const DOMAIN_URL_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?#].*)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isUrlLike(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (URL_RE.test(text)) return true;
  if (PROTOCOL_RELATIVE_URL_RE.test(text)) return true;
  return DOMAIN_URL_RE.test(text);
}

export function inferFieldType(value: unknown): string {
  if (value == null) return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'string') {
    if (isUrlLike(value)) return 'url';
    const trimmed = value.trim();
    if (ISO_DATE_RE.test(trimmed)) return 'date';
    if (trimmed.includes('@') && trimmed.includes('.')) return 'email';
  }
  return 'text';
}

// ── Helpers ──────────────────────────────────────────────

export function getSpaceId(body?: any): string | null {
  return resolveSpaceId(body);
}

export function requireSpaceId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const id = getSpaceId(body);
  if (!id) {
    sendJSON(res, 400, errorResponse(
      'VALIDATION_ERROR',
      '缺少 space_id。请设置 TABTIN_SPACE_ID 环境变量，或在请求中传入 space_id / project_id',
    ));
  }
  return id;
}

/** ：表/文档等资源挂 Organization；create/list 走 org，不要求 Space。 */
export function requireOrganizationId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const id = body?.organization_id ?? body?.organizationId ?? null;
  if (!id || typeof id !== 'string') {
    sendJSON(res, 400, errorResponse(
      'VALIDATION_ERROR',
      '缺少 organization_id。请设置 TABTIN_ORGANIZATION_ID 环境变量，或在请求中传入 organization_id',
    ));
    return null;
  }
  return id;
}

export function requireTableId(body: any, res: ServerResponse, sendJSON: SendJSON): string | null {
  const id = body?.table_id;
  if (!id) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 table_id 参数'));
  }
  return id;
}

/**
 * Normalize records: unwrap { cells: {...} } to flat dict, accepted by Django.
 */
export function flattenRecords(records: any[]): any[] {
  return records.map((rec: any) => {
    if (rec.cells && typeof rec.cells === 'object') return rec.cells;
    if (rec.fields && typeof rec.fields === 'object') return rec.fields;
    return rec;
  });
}

/**
 * 防御性解析：当上游（如旧 CLI / PowerShell BOM）把 JSON 对象/数组当字符串传来时，
 * 尝试 strip UTF-8 BOM 后再 JSON.parse。解析失败则原样返回。
 */
export function coerceJSONValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.replace(/^\uFEFF/, '').trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

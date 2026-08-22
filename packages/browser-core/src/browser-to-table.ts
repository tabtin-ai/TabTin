import type { NetworkLogEntry } from './runtime/NetworkLog';
import { normalizeBrowserNetworkEntries } from './browser-to-api';

export type BrowserToTableFieldType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'url'
  | 'date';

export interface BrowserToTableField {
  name: string;
  source_key: string;
  field_type: BrowserToTableFieldType;
  reason?: string;
}

export interface BrowserToTableCaptureScope {
  kind: 'bounded_initial_batch';
  rows: number;
  row_limit: number;
  pages: number;
  page_limit: number;
  is_partial: boolean;
  source_kind: 'provided_records' | 'network_api' | 'dom_table';
  source_url?: string;
  source_path?: string;
}

export interface BrowserToTableDataset {
  records: Array<Record<string, unknown>>;
  source_records: Array<Record<string, unknown>>;
  row_count: number;
  field_count: number;
  preview_rows: Array<Record<string, unknown>>;
  fields: BrowserToTableField[];
  capture_scope: BrowserToTableCaptureScope;
  warnings: string[];
  recoveries: string[];
}

export interface BrowserToTableInput {
  url?: string;
  records?: unknown;
  network?: unknown;
  domRecords?: unknown;
  rowLimit?: number;
  pageLimit?: number;
  previewLimit?: number;
}

interface CandidateArray {
  rows: Array<Record<string, unknown>>;
  path: string;
  sourceUrl?: string;
  pageCount: number;
  sourceKind?: BrowserToTableCaptureScope['source_kind'];
}

interface CandidatePage {
  page: number;
  rows: Array<Record<string, unknown>>;
  sourceUrl?: string;
}

const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 5;
const DEFAULT_PREVIEW_LIMIT = 5;
const MAX_ROW_LIMIT = 500;
const MAX_PAGE_LIMIT = 20;
const LONG_NUMERIC_IDENTIFIER_LENGTH = 12;
/** Align with backend import inference: tolerate a minority of dirty cells. */
const URL_RATIO_THRESHOLD = 0.8;
/** Name-hinted URL columns can accept a lower sample hit rate. */
const URL_NAME_HINT_RATIO_THRESHOLD = 0.5;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ID_KEY_RE = /(^id$|[_-]id$|id$|identifier)/i;
const DICTIONARY_KEY_RE = /^(id|code|key|name|label|title|value|text)$/i;
/** Source key / label that strongly suggests a URL column (e.g. project_url, 文章链接). */
const URL_KEY_RE = /(^|[_\-\s])(url|href|link|website)([_\-\s]|$)|(链接|网址|官网|主页)$/i;
/** Bare domain / host+path, matching UrlField without relative-path `/...`. */
const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?#].*)?$/;

export function collectBrowserTableDataset(input: BrowserToTableInput): BrowserToTableDataset {
  const rowLimit = clampInt(input.rowLimit, DEFAULT_ROW_LIMIT, 1, MAX_ROW_LIMIT);
  const pageLimit = clampInt(input.pageLimit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT);
  const previewLimit = clampInt(input.previewLimit, DEFAULT_PREVIEW_LIMIT, 0, 20);
  const warnings: string[] = [];
  const recoveries: string[] = [];

  const candidate = input.records != null
    ? withSourceKind(recordsCandidate(input.records), 'provided_records')
    : withSourceKind(networkCandidate(input.network, pageLimit), 'network_api')
      ?? withSourceKind(domRecordsCandidate(input.domRecords), 'dom_table');

  if (!candidate || candidate.rows.length === 0) {
    throw new Error('未从页面或 network 响应中发现可导入的对象列表');
  }

  if (candidate.rows.length > rowLimit) {
    warnings.push(`默认只采集前 ${rowLimit} 行；源数据至少包含 ${candidate.rows.length} 行`);
  }
  if (candidate.pageCount > pageLimit) {
    warnings.push(`默认只采集前 ${pageLimit} 页；源数据至少覆盖 ${candidate.pageCount} 页`);
  }

  const sourceRows = candidate.rows.slice(0, rowLimit);
  const fields = inferBrowserToTableFields(sourceRows);
  warnings.push(...unsafeIdentifierWarnings(sourceRows, fields));
  const records = sourceRows.map((row) => normalizeRecordForFields(row, fields));
  const isPartial = candidate.rows.length >= rowLimit || candidate.pageCount >= pageLimit;

  return {
    records,
    source_records: sourceRows,
    row_count: records.length,
    field_count: fields.length,
    preview_rows: records.slice(0, previewLimit),
    fields,
    capture_scope: {
      kind: 'bounded_initial_batch',
      rows: records.length,
      row_limit: rowLimit,
      pages: Math.min(candidate.pageCount, pageLimit),
      page_limit: pageLimit,
      is_partial: isPartial,
      source_kind: candidate.sourceKind ?? 'network_api',
      ...(candidate.sourceUrl ? { source_url: candidate.sourceUrl } : {}),
      ...(candidate.path ? { source_path: candidate.path } : {}),
    },
    warnings,
    recoveries,
  };
}

export function inferBrowserToTableFields(rows: Array<Record<string, unknown>>): BrowserToTableField[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  const usedNames = new Map<string, number>();
  return keys.map((key) => {
    const samples = rows
      .map((row) => row[key])
      .filter((value) => value !== null && value !== undefined && value !== '');
    const inferred = inferFieldTypeForSamples(key, samples);
    return {
      name: uniqueFieldName(labelizeKey(key), usedNames),
      source_key: key,
      field_type: inferred.field_type,
      ...(inferred.reason ? { reason: inferred.reason } : {}),
    };
  });
}

function recordsCandidate(input: unknown): CandidateArray | null {
  const value = parseMaybeJson(input);
  const rows = normalizeObjectRows(Array.isArray(value) ? value : unwrapKnownList(value));
  if (rows.length === 0) return null;
  return { rows, path: '$', pageCount: 1 };
}

function domRecordsCandidate(input: unknown): CandidateArray | null {
  const value = parseMaybeJson(input);
  const rows = normalizeObjectRows(Array.isArray(value) ? value : unwrapKnownList(value));
  if (rows.length === 0) return null;
  return { rows, path: '$.dom', pageCount: 1 };
}

function withSourceKind(
  candidate: CandidateArray | null,
  sourceKind: BrowserToTableCaptureScope['source_kind'],
): (CandidateArray & { sourceKind: BrowserToTableCaptureScope['source_kind'] }) | null {
  if (!candidate) return null;
  return { ...candidate, sourceKind };
}

function networkCandidate(input: unknown, pageLimit: number): CandidateArray | null {
  const entries = normalizeBrowserNetworkEntries(input);
  const groups = new Map<string, { path: string; pages: CandidatePage[] }>();
  for (const entry of entries) {
    if (!looksLikeJsonResponse(entry)) continue;
    const parsed = parseMaybeJson(entry.responseBody);
    if (parsed === undefined) continue;
    for (const candidate of extractObjectArrays(parsed, '$')) {
      const sourceKey = paginationSeriesKey(entry);
      const groupKey = `${sourceKey}\n${candidate.path}`;
      const group = groups.get(groupKey) ?? { path: candidate.path, pages: [] };
      group.pages.push({
        page: pageNumber(entry.url),
        rows: candidate.rows,
        sourceUrl: entry.url,
      });
      groups.set(groupKey, group);
    }
  }
  const candidates: CandidateArray[] = [];
  for (const group of groups.values()) {
    const pages = group.pages
      .sort((a, b) => a.page - b.page)
      .slice(0, pageLimit);
    candidates.push({
      rows: pages.flatMap((page) => page.rows),
      path: group.path,
      sourceUrl: pages[0]?.sourceUrl,
      pageCount: group.pages.length,
    });
  }
  candidates.sort((a, b) => candidateScore(b) - candidateScore(a));
  return candidates[0] ?? null;
}

function candidateScore(candidate: CandidateArray): number {
  const sampleRows = candidate.rows.slice(0, 10);
  const keys = new Set<string>();
  for (const row of sampleRows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  const keyList = [...keys];
  const avgFieldCount = sampleRows.length > 0
    ? sampleRows.reduce((sum, row) => sum + Object.keys(row).length, 0) / sampleRows.length
    : 0;
  const avgTextLength = averageScalarTextLength(sampleRows);
  const valueShapeCount = distinctValueShapeCount(sampleRows);
  const dictionaryLikeKeyRatio = keyList.length > 0
    ? keyList.filter((key) => DICTIONARY_KEY_RE.test(labelizeKey(key).replace(/\s+/g, ''))).length / keyList.length
    : 0;
  const dictionaryLike = avgFieldCount <= 2.5 && dictionaryLikeKeyRatio >= 0.75 && avgTextLength <= 24;

  let score = Math.min(candidate.rows.length, 100);
  score += avgFieldCount * 20;
  score += Math.min(avgTextLength, 80) * 1.5;
  score += valueShapeCount * 15;
  if (dictionaryLike) score -= 160;
  if (avgFieldCount <= 2) score -= 40;
  return score;
}

function averageScalarTextLength(rows: Array<Record<string, unknown>>): number {
  const values = rows.flatMap((row) => Object.values(row))
    .filter((value) => value !== null && value !== undefined && typeof value !== 'object');
  if (values.length === 0) return 0;
  const total = values.reduce<number>((sum, value) => sum + String(value).trim().length, 0);
  return total / values.length;
}

function distinctValueShapeCount(rows: Array<Record<string, unknown>>): number {
  const shapes = new Set<string>();
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value === null || value === undefined || value === '') continue;
      if (typeof value === 'boolean') {
        shapes.add('boolean');
      } else if (typeof value === 'number') {
        shapes.add(Number.isInteger(value) ? 'integer' : 'decimal');
      } else if (typeof value === 'string') {
        if (isUrlLike(value)) shapes.add('url');
        else if (ISO_DATETIME_RE.test(value.trim())) shapes.add('timestamp');
        else if (ISO_DATE_RE.test(value.trim())) shapes.add('date');
        else if (value.length > 40) shapes.add('long_text');
        else shapes.add('short_text');
      } else {
        shapes.add('complex');
      }
    }
  }
  return shapes.size;
}

function looksLikeJsonResponse(entry: NetworkLogEntry): boolean {
  if (!entry.responseBody || entry.responseBodyBase64Encoded) return false;
  const mime = entry.mimeType?.toLowerCase() ?? '';
  if (mime.includes('json')) return true;
  const trimmed = entry.responseBody.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parseMaybeJson(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function unwrapKnownList(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  for (const key of ['records', 'rows', 'items', 'list', 'data']) {
    const child = obj[key];
    if (Array.isArray(child)) return child;
    if (child && typeof child === 'object') {
      const nested = unwrapKnownList(child);
      if (Array.isArray(nested)) return nested;
    }
  }
  return value;
}

function extractObjectArrays(value: unknown, path: string): CandidateArray[] {
  if (Array.isArray(value)) {
    const rows = normalizeObjectRows(value);
    return rows.length > 0 ? [{ rows, path, pageCount: 1 }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  const out: CandidateArray[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(...extractObjectArrays(child, `${path}.${key}`));
  }
  return out;
}

function normalizeObjectRows(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  return input
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .map((row) => flattenRecord(row));
}

function flattenRecord(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    const nested = value as Record<string, unknown>;
    const display = nested.name ?? nested.title ?? nested.label ?? nested.value;
    out[key] = display ?? JSON.stringify(value);
  }
  return out;
}

function normalizeRecordForFields(
  row: Record<string, unknown>,
  fields: BrowserToTableField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = row[field.source_key];
    out[field.name] = shouldStringifyForTextIdentifier(field, value) ? String(value) : value;
  }
  return out;
}

function shouldStringifyForTextIdentifier(field: BrowserToTableField, value: unknown): boolean {
  return field.field_type === 'text'
    && field.reason?.includes('identifier') === true
    && (typeof value === 'number' || typeof value === 'bigint');
}

function inferFieldTypeForSamples(
  key: string,
  samples: unknown[],
): { field_type: BrowserToTableFieldType; reason?: string } {
  if (isIdentifierKey(key)) {
    return { field_type: 'text', reason: 'identifier field' };
  }
  if (samples.some((value) => isLongNumericIdentifier(value))) {
    return { field_type: 'text', reason: 'long numeric identifier' };
  }
  if (samples.length > 0 && samples.every((value) => typeof value === 'boolean')) {
    return { field_type: 'checkbox' };
  }
  if (samples.length > 0 && samples.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return { field_type: 'number' };
  }
  const urlHint = isUrlKey(key);
  const urlThreshold = urlHint ? URL_NAME_HINT_RATIO_THRESHOLD : URL_RATIO_THRESHOLD;
  if (majorityMatch(samples, isUrlLike, urlThreshold)) {
    return {
      field_type: 'url',
      reason: urlHint ? 'url-like field name' : undefined,
    };
  }
  if (samples.length > 0 && samples.every((value) => typeof value === 'string' && ISO_DATETIME_RE.test(value.trim()))) {
    // TabData 不再提供独立 datetime 字段；保留完整 ISO 时间文本，避免
    // 映射到 date 后丢失时分秒与时区。
    return { field_type: 'text' };
  }
  if (samples.length > 0 && samples.every((value) => typeof value === 'string' && ISO_DATE_RE.test(value.trim()))) {
    return { field_type: 'date' };
  }
  return { field_type: 'text' };
}

function isIdentifierKey(key: string): boolean {
  return ID_KEY_RE.test(key);
}

function isUrlKey(key: string): boolean {
  return URL_KEY_RE.test(key.trim());
}

/** URL shapes accepted for inference (narrower than write-side relative `/path`). */
function isUrlLike(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return true;
  if (text.startsWith('//') && DOMAIN_RE.test(text.slice(2))) return true;
  return DOMAIN_RE.test(text);
}

function majorityMatch(
  samples: unknown[],
  predicate: (value: unknown) => boolean,
  threshold: number,
): boolean {
  if (samples.length === 0) return false;
  let hits = 0;
  for (const sample of samples) {
    if (predicate(sample)) hits += 1;
  }
  return hits >= samples.length * threshold;
}

function isLongNumericIdentifier(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) >= 10 ** (LONG_NUMERIC_IDENTIFIER_LENGTH - 1);
  }
  if (typeof value !== 'string') return false;
  return /^\d+$/.test(value) && value.length >= LONG_NUMERIC_IDENTIFIER_LENGTH;
}

function unsafeIdentifierWarnings(
  rows: Array<Record<string, unknown>>,
  fields: BrowserToTableField[],
): string[] {
  const warnings: string[] = [];
  for (const field of fields) {
    const isIdentifier = field.reason?.includes('identifier') === true || isIdentifierKey(field.source_key);
    if (!isIdentifier) continue;
    const hasUnsafeNumber = rows.some((row) => (
      typeof row[field.source_key] === 'number' && !Number.isSafeInteger(row[field.source_key] as number)
    ));
    if (hasUnsafeNumber) {
      warnings.push(`字段 ${field.name} 包含超过 JavaScript 安全整数范围的数字 ID；已按 text 导入，但源响应可能已发生精度损失`);
    }
  }
  return warnings;
}

function labelizeKey(key: string): string {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!normalized) return 'Field';
  return normalized
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUrl\b/g, 'URL');
}

function uniqueFieldName(name: string, used: Map<string, number>): string {
  const count = used.get(name) ?? 0;
  used.set(name, count + 1);
  return count === 0 ? name : `${name} ${count + 1}`;
}

function safePathname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return null;
  }
}

function paginationSeriesKey(entry: NetworkLogEntry): string {
  try {
    const url = new URL(entry.url);
    const params = new URLSearchParams(url.search);
    for (const key of ['page', 'pageNo', 'pageNum', 'p']) {
      params.delete(key);
    }
    params.sort();
    const method = entry.method?.toUpperCase() || 'GET';
    const query = params.toString();
    return `${method} ${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return `${entry.method?.toUpperCase() || 'GET'} ${entry.url}`;
  }
}

function pageNumber(rawUrl: string): number {
  const rawPage = safeSearchParam(rawUrl, 'page')
    ?? safeSearchParam(rawUrl, 'pageNo')
    ?? safeSearchParam(rawUrl, 'pageNum')
    ?? safeSearchParam(rawUrl, 'p')
    ?? '1';
  const parsed = Number(rawPage);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : 1;
}

function safeSearchParam(rawUrl: string, key: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get(key);
  } catch {
    return null;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

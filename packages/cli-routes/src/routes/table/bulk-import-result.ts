export type BulkImportOperationStatus = 'full_success' | 'partial_success' | 'complete_failure';

export interface BulkImportErrorGroup {
  message: string;
  count: number;
  rows: string[];
}

export interface BulkImportErrorSummary {
  total: number;
  unique_count: number;
  repeated_count: number;
  groups: BulkImportErrorGroup[];
  truncated: boolean;
}

export interface BulkImportResultPayload {
  success_count: number;
  failed_count: number;
  total_count: number;
  operation_status: BulkImportOperationStatus;
  errors: string[];
  error_summary: BulkImportErrorSummary;
  errors_truncated: boolean;
  [key: string]: unknown;
}

const MAX_COMPACT_ERRORS = 20;
const MAX_ERROR_GROUPS = 12;
const MAX_ROW_EXAMPLES_PER_GROUP = 5;
const ROW_ERROR_PREFIX_RE = /^(第\d+条)[:：]\s*/;

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function unwrapDjangoPayload(data: any): Record<string, unknown> {
  const payload = data?.data ?? data;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

function parseRowError(error: string): { row: string | null; message: string } {
  const trimmed = String(error).trim();
  const match = ROW_ERROR_PREFIX_RE.exec(trimmed);
  if (!match) {
    return { row: null, message: trimmed };
  }
  return {
    row: match[1],
    message: trimmed.slice(match[0].length).trim(),
  };
}

function summarizeBulkErrors(errors: string[]): BulkImportErrorSummary {
  const groupsByMessage = new Map<string, BulkImportErrorGroup>();

  for (const error of errors) {
    const { row, message } = parseRowError(error);
    const key = message || error;
    const group = groupsByMessage.get(key) ?? { message: key, count: 0, rows: [] };
    group.count += 1;
    if (row && group.rows.length < MAX_ROW_EXAMPLES_PER_GROUP) {
      group.rows.push(row);
    }
    groupsByMessage.set(key, group);
  }

  const allGroups = [...groupsByMessage.values()].sort((a, b) => b.count - a.count);
  const groups = allGroups.slice(0, MAX_ERROR_GROUPS);
  const repeated_count = allGroups.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);

  return {
    total: errors.length,
    unique_count: allGroups.length,
    repeated_count,
    groups,
    truncated: allGroups.length > groups.length,
  };
}

function compactBulkErrors(errors: string[], summary: BulkImportErrorSummary): string[] {
  if (errors.length <= MAX_COMPACT_ERRORS && summary.repeated_count === 0) {
    return errors;
  }

  const compact = summary.groups.map((group) => {
    const rowHint = group.rows.length > 0 ? `${group.rows.join('、')}${group.count > group.rows.length ? '等' : ''}` : '多条记录';
    return group.count > 1
      ? `${rowHint} ${group.count} 条: ${group.message}`
      : `${rowHint}: ${group.message}`;
  });

  if (summary.truncated || summary.total > compact.length) {
    compact.push(`已汇总 ${summary.total} 条 row-level error；完整分布见 error_summary`);
  }

  return compact;
}

export function buildBulkImportResultPayload(data: any, inputRecordCount: number): BulkImportResultPayload {
  // Django 会把每条成功插入记录的完整序列化对象放在 `records` 里回显——1000 条
  // bulk-insert 就是 1000 个完整记录对象。CLI 出口只保留计数 / 状态 / 错误摘要；
  // 需要 record_id 时按 skill 正典用 `record list` 重拉建索引。
  const { records: rawRecords, ...payload } = unwrapDjangoPayload(data);
  const records = Array.isArray(rawRecords) ? rawRecords : [];
  const rawErrors = Array.isArray(payload.errors) ? payload.errors.map((error) => String(error)) : [];

  const successCount = toInt(payload.success_count) ?? records.length;
  const explicitTotalCount = toInt(payload.total_count);
  const failedCount = toInt(payload.failed_count)
    ?? (explicitTotalCount != null ? Math.max(0, explicitTotalCount - successCount) : rawErrors.length);
  const totalCount = explicitTotalCount ?? Math.max(inputRecordCount, successCount + failedCount);

  const operationStatus: BulkImportOperationStatus =
    successCount === 0 && (failedCount > 0 || rawErrors.length > 0 || totalCount > 0)
      ? 'complete_failure'
      : failedCount > 0 || rawErrors.length > 0
        ? 'partial_success'
        : 'full_success';

  const errorSummary = summarizeBulkErrors(rawErrors);
  const compactErrors = compactBulkErrors(rawErrors, errorSummary);

  return {
    ...payload,
    success_count: successCount,
    failed_count: failedCount,
    total_count: totalCount,
    operation_status: operationStatus,
    errors: compactErrors,
    error_summary: errorSummary,
    errors_truncated: compactErrors.length < rawErrors.length || errorSummary.repeated_count > 0,
  };
}

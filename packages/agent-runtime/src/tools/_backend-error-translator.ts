import {
  AUTH_FAILED,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NETWORK_FAILED,
  PERMISSION_DENIED,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  RESOURCE_NOT_FOUND,
  RUNTIME_MISCONFIG,
  UPSTREAM_ERROR,
  VERSION_CONFLICT,
  type ToolErrorKind,
} from '../engine/errors/error-kinds.js';

export interface BackendErrorInput {
  status?: number;
  body?: unknown;
  error?: unknown;
  fallbackMessage?: string;
  toolName: string;
  operation: string;
}

export interface TranslatedBackendError {
  error_kind: ToolErrorKind;
  message: string;
  hint: string;
  upstream_status?: number;
  upstream_code?: string;
}

type JsonErrorExtraMetadata = Record<string, unknown>;

const SAFE_UPSTREAM_CODES = new Set([
  'PLAN_NOT_FOUND',
  'PLAN_NOT_DRAFT',
  'PLAN_PERMISSION_DENIED',
  'PLAN_NO_USER',
  'PLAN_MISSING_SCOPE',
  'PLAN_NOT_A_PLAN',
  'PLAN_INVALID_INPUT',
  'PLAN_INVALID_TODO',
  'PLAN_INVALID_TODOS',
  'PLAN_DUPLICATE_TODO_ID',
  'CREDENTIAL_EXPIRED',
  'CREDENTIAL_INACTIVE',
  // credential_retrieve availability miss —— 安全运维归因，不含 id/secret
  'NOT_FOUND',
  'SEARCH_ERROR',
  'BILLING_ERROR',
]);

const SAFE_EXTRA_METADATA_KEYS = new Set([
  'endpoint',
  'error_label',
  'http_status',
  'parse_status',
  'primary_error_label',
  'slug',
  'status',
  'upstream_status',
]);

const INTERNAL_LEAK_PATTERNS: RegExp[] = [
  /context[_ ]?id is required/i,
  /caller must pass/i,
  /\bDjango\b/i,
  /\bqueryset\b/i,
  /serializer\.errors/i,
  /\brequest_dict\b/i,
  /\bTraceback\b/i,
  /\bValueError:/i,
  /\bKeyError:/i,
  /\bIntegrityError\b/i,
  /\bDoesNotExist\b/i,
  /\bValidationError\b/i,
  /\bNoneType\b/i,
];

export function containsBackendInternalLeak(value: string): boolean {
  return INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeBackendText(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (containsBackendInternalLeak(trimmed)) return fallback;
  return trimmed.replace(/\s+/g, ' ');
}

export function toJsonErrorMetadata(
  translated: TranslatedBackendError,
  extra: JsonErrorExtraMetadata = {},
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    error_kind: translated.error_kind,
    hint: translated.hint,
  };
  if (translated.upstream_status !== undefined) metadata.upstream_status = translated.upstream_status;
  const upstreamCode = toSafeUpstreamCode(translated.upstream_code);
  if (upstreamCode) metadata.upstream_code = upstreamCode;

  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    if (!SAFE_EXTRA_METADATA_KEYS.has(key)) continue;
    metadata[key] = value;
  }
  return metadata;
}

export function translateBackendError(input: BackendErrorInput): TranslatedBackendError {
  const upstreamStatus = typeof input.status === 'number' ? input.status : undefined;
  const rawUpstreamCode = extractBackendCode(input.body);
  const upstreamCode = toSafeUpstreamCode(rawUpstreamCode);
  const fallback = input.fallbackMessage ?? 'The backend operation could not be completed.';

  const planError = translatePlanError(input, rawUpstreamCode, upstreamStatus);
  if (planError) return planError;

  const searchError = translateSearchError(input, rawUpstreamCode, upstreamStatus);
  if (searchError) return searchError;

  if (input.error) {
    return translateThrownError(input, fallback, upstreamCode);
  }

  const credentialError = translateCredentialError(rawUpstreamCode, upstreamStatus, upstreamCode);
  if (credentialError) return credentialError;

  const statusError = translateHttpStatusError(input, upstreamStatus, upstreamCode);
  if (statusError) return statusError;

  const safeMessage = sanitizeBackendText(extractBackendMessage(input.body) ?? fallback, fallback);
  return {
    error_kind: UPSTREAM_ERROR,
    message: safeMessage,
    hint: `Retry ${input.toolName} once. If the same operation fails again, ask the user for help instead of repeating it.`,
    upstream_status: upstreamStatus,
    upstream_code: upstreamCode,
  };
}

function translateCredentialError(
  rawUpstreamCode: string | undefined,
  upstreamStatus: number | undefined,
  upstreamCode: string | undefined,
): TranslatedBackendError | undefined {
  if (rawUpstreamCode !== 'CREDENTIAL_EXPIRED' && rawUpstreamCode !== 'CREDENTIAL_INACTIVE') {
    return undefined;
  }
  return {
    error_kind: RESOURCE_NOT_FOUND,
    message: 'The saved credential is no longer usable.',
    hint:
      'Ask the user to update or re-enable this credential in Agent Security settings, then run credential_lookup again.',
    upstream_status: upstreamStatus,
    upstream_code: upstreamCode,
  };
}

function translateHttpStatusError(
  input: BackendErrorInput,
  upstreamStatus: number | undefined,
  upstreamCode: string | undefined,
): TranslatedBackendError | undefined {
  if (upstreamStatus === 401) return buildAuthFailedError(input, upstreamStatus, upstreamCode);
  if (upstreamStatus === 403) return buildPermissionDeniedError(upstreamStatus, upstreamCode);
  if (upstreamStatus === 404 || upstreamStatus === 410) {
    return {
      error_kind: RESOURCE_NOT_FOUND,
      message: 'The requested resource was not found.',
      hint: buildNotFoundHint(input),
      upstream_status: upstreamStatus,
      upstream_code: upstreamCode,
    };
  }
  if (upstreamStatus === 429) {
    return {
      error_kind: RATE_LIMITED,
      message: 'The service is rate limiting this operation.',
      hint: `Wait a moment, reduce the request size or frequency, then retry ${input.toolName}.`,
      upstream_status: upstreamStatus,
      upstream_code: upstreamCode,
    };
  }
  if (upstreamStatus !== undefined && upstreamStatus >= 400 && upstreamStatus < 500) {
    return {
      error_kind: INVALID_PARAM_FORMAT,
      message: 'The request parameters are not valid for this operation.',
      hint: buildInvalidInputHint(input),
      upstream_status: upstreamStatus,
      upstream_code: upstreamCode,
    };
  }
  if (upstreamStatus !== undefined && upstreamStatus >= 500) {
    return {
      error_kind: UPSTREAM_ERROR,
      message: 'The service is temporarily unavailable.',
      hint: `Retry ${input.toolName} once. If it fails again, tell the user the service is unavailable and stop retrying this path.`,
      upstream_status: upstreamStatus,
      upstream_code: upstreamCode,
    };
  }
  return undefined;
}

function buildAuthFailedError(
  input: BackendErrorInput,
  upstreamStatus: number | undefined,
  upstreamCode: string | undefined,
): TranslatedBackendError {
  return {
    error_kind: AUTH_FAILED,
    message: 'Authentication is required for this operation.',
    hint: `Ask the user to sign in again, then retry ${input.toolName}.`,
    upstream_status: upstreamStatus,
    upstream_code: upstreamCode,
  };
}

function buildPermissionDeniedError(
  upstreamStatus: number | undefined,
  upstreamCode: string | undefined,
): TranslatedBackendError {
  return {
    error_kind: PERMISSION_DENIED,
    message: 'You do not have permission to access this resource.',
    hint:
      'Ask the user to confirm this Agent has access to the current Space or resource, then retry after permission is granted.',
    upstream_status: upstreamStatus,
    upstream_code: upstreamCode,
  };
}

const SEARCH_CONFIG_CODES = new Set([
  'search_provider_api_key_missing',
  'search_provider_inactive',
  'search_provider_unsupported',
]);

const SEARCH_BILLING_QUOTA_CODES = new Set([
  'search_billing_budget_exceeded',
  'search_billing_member_budget',
]);

function translateSearchError(
  input: BackendErrorInput,
  upstreamCode: string | undefined,
  upstreamStatus: number | undefined,
): TranslatedBackendError | undefined {
  if (input.toolName !== 'web_search') return undefined;

  const normalizedCode = upstreamCode?.trim();
  if (!normalizedCode) return undefined;

  const base = {
    upstream_status: upstreamStatus,
    upstream_code: toSafeUpstreamCode(normalizedCode),
  };

  if (normalizedCode === 'search_query_required') {
    return {
      ...base,
      error_kind: MISSING_REQUIRED_PARAM,
      message: 'search_term is required',
      hint: 'Provide the web search query in search_term before calling web_search.',
    };
  }

  if (SEARCH_CONFIG_CODES.has(normalizedCode)) {
    return {
      ...base,
      error_kind: RUNTIME_MISCONFIG,
      message: 'The search service is not configured.',
      hint: 'Tell the user the search provider is unavailable due to server configuration. Do not retry web_search on this path. If the target site is well known, you may open its domain homepage and navigate via real in-page links; never guess deeper URL paths. Otherwise ask the user for the exact URL.',
    };
  }

  if (
    normalizedCode === 'BILLING_ERROR'
    || normalizedCode.includes('billing')
    || normalizedCode.startsWith('search_billing_')
    || normalizedCode === 'search_service_disabled'
  ) {
    if (SEARCH_BILLING_QUOTA_CODES.has(normalizedCode)) {
      return {
        ...base,
        error_kind: RATE_LIMITED,
        message: 'Web search is blocked by billing quota limits.',
        hint: 'Wait a moment or ask the user to increase the organization search budget, then retry web_search.',
      };
    }
    return {
      ...base,
      error_kind: PERMISSION_DENIED,
      message: 'Web search is blocked by billing limits.',
      hint: 'Ask the user to check organization billing balance or search access before retrying web_search.',
    };
  }

  if (
    normalizedCode === 'SEARCH_ERROR'
    || normalizedCode.startsWith('search_provider_')
    || normalizedCode.startsWith('bocha_')
  ) {
    return {
      ...base,
      error_kind: UPSTREAM_ERROR,
      message: 'The search provider could not complete the request.',
      hint: 'Retry web_search once. If it fails again, tell the user the search service is unavailable and stop retrying this path. If the target site is well known, you may open its domain homepage and navigate via real in-page links; never guess deeper URL paths. Otherwise ask the user for the exact URL.',
    };
  }

  return undefined;
}

function translatePlanError(
  input: BackendErrorInput,
  upstreamCode: string | undefined,
  upstreamStatus: number | undefined,
): TranslatedBackendError | undefined {
  if (!input.toolName.startsWith('plan_') || !upstreamCode?.startsWith('PLAN_')) return undefined;
  const base = {
    upstream_status: upstreamStatus,
    upstream_code: toSafeUpstreamCode(upstreamCode),
  };
  switch (upstreamCode) {
    case 'PLAN_NOT_FOUND':
      return {
        ...base,
        error_kind: RESOURCE_NOT_FOUND,
        message: 'The plan draft was not found.',
        hint: 'Use the document_id returned by the most recent successful plan_create call, or create a new plan draft with plan_create.',
      };
    case 'PLAN_NOT_DRAFT':
      return {
        ...base,
        error_kind: VERSION_CONFLICT,
        message: 'This plan is already settled and cannot be edited.',
        hint: 'Create a new draft with plan_create instead of updating this settled plan.',
      };
    case 'PLAN_PERMISSION_DENIED':
      return {
        ...base,
        error_kind: PERMISSION_DENIED,
        message: 'You do not have permission to edit this plan.',
        hint: 'Ask the user to grant this Agent editor access in the Space, or use an Agent that already has permission.',
      };
    case 'PLAN_NO_USER':
      return {
        ...base,
        error_kind: AUTH_FAILED,
        message: 'Authentication is required for plan operations.',
        hint: 'Ask the user to sign in again, then retry the plan operation.',
      };
    case 'PLAN_MISSING_SCOPE':
      return {
        ...base,
        error_kind: RUNTIME_MISCONFIG,
        message: 'Plan tools are missing Space context.',
        hint: 'Stop using plan tools in this run and report that the runtime did not provide organization_id or space_id.',
      };
    case 'PLAN_NOT_A_PLAN':
      return {
        ...base,
        error_kind: INVALID_PARAM_FORMAT,
        message: 'The target document is not a plan draft.',
        hint: 'Use a document_id returned by plan_create. Do not pass arbitrary TabDoc document IDs to plan_update_todos.',
      };
    case 'PLAN_INVALID_INPUT':
    case 'PLAN_INVALID_TODO':
    case 'PLAN_INVALID_TODOS':
    case 'PLAN_DUPLICATE_TODO_ID':
      return {
        ...base,
        error_kind: INVALID_PARAM_FORMAT,
        message: 'The plan request contains invalid fields.',
        hint: 'Keep todos as an array of objects with content and status, and reuse ids only when intentionally updating existing todos.',
      };
    default:
      return undefined;
  }
}

function translateThrownError(
  input: BackendErrorInput,
  fallback: string,
  upstreamCode: string | undefined,
): TranslatedBackendError {
  const raw = input.error instanceof Error ? input.error.message : String(input.error);
  if (/timeout|aborted|TimeoutError|AbortError/i.test(raw)) {
    return {
      error_kind: REQUEST_TIMEOUT,
      message: 'The request timed out while contacting the service.',
      hint: `Retry ${input.toolName} with a narrower request or wait a moment before trying again.`,
      upstream_code: upstreamCode,
    };
  }
  if (/fetch|network|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(raw)) {
    return {
      error_kind: NETWORK_FAILED,
      message: 'The service could not be reached.',
      hint: `Check network connectivity, then retry ${input.toolName}. If the host is offline, ask the user to reconnect.`,
      upstream_code: upstreamCode,
    };
  }
  return {
    error_kind: UPSTREAM_ERROR,
    message: sanitizeBackendText(raw, fallback),
    hint: `Retry ${input.toolName} once. If it fails again, ask the user for help instead of repeating it.`,
    upstream_code: upstreamCode,
  };
}

function buildNotFoundHint(input: BackendErrorInput): string {
  if (input.toolName === 'parse_document') {
    return 'Use the exact FileRecord UUID from the uploaded file chip. If you only have a local path, use read_file instead or ask the user to upload the document.';
  }
  if (input.toolName === 'skill_invoke') {
    return 'Run skills_search with keywords from the user request, then invoke one of the returned canonical skill keys.';
  }
  if (input.toolName.startsWith('credential_')) {
    return 'Run credential_lookup again to get a current credential_id before retrying credential_retrieve.';
  }
  return `Confirm the resource ID came from a recent successful tool result, then retry ${input.toolName}.`;
}

function buildInvalidInputHint(input: BackendErrorInput): string {
  if (input.toolName === 'parse_document') {
    return 'Pass a FileRecord UUID in file_id. Do not pass a local file path; use read_file for local files.';
  }
  if (input.toolName.startsWith('plan_')) {
    return 'Use document_id values returned by plan_create and keep todos as an array of objects with content and status.';
  }
  // ：skill_create 注册失败常被误标为 4xx invalid input；勿诱导 Agent 改 content 重试。
  if (input.toolName === 'skill_create') {
    return 'Backend rejected skill registration. Do not retry by rewriting content or description; verify Organization/Agent context or ask the user.';
  }
  return `Check the ${input.toolName} input schema and retry with the required fields in the expected format.`;
}

function extractBackendCode(body: unknown): string | undefined {
  const obj = asRecord(body);
  if (!obj) return undefined;
  const candidates = [
    obj.code,
    obj.error_code,
    asRecord(obj.data)?.error_code,
    asRecord(obj.error)?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      const code = candidate.trim();
      return containsBackendInternalLeak(code) ? undefined : code;
    }
    if (typeof candidate === 'number') return String(candidate);
  }
  return undefined;
}

function extractBackendMessage(body: unknown): string | undefined {
  const obj = asRecord(body);
  if (!obj) return undefined;
  const candidates = [
    obj.message,
    obj.error,
    obj.detail,
    asRecord(obj.data)?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  if (Array.isArray(obj.detail) && obj.detail.length > 0) {
    const first = asRecord(obj.detail[0]);
    if (typeof first?.msg === 'string' && first.msg.trim()) return first.msg;
  }
  return undefined;
}

function toSafeUpstreamCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return SAFE_UPSTREAM_CODES.has(code) ? code : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

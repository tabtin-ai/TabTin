import { describe, expect, it } from 'vitest';
import {
  containsBackendInternalLeak,
  sanitizeBackendText,
  translateBackendError,
} from '../src/tools/_backend-error-translator.js';

describe('backend error translator', () => {
  it('translates auth, permission, missing resource, and rate limits without leaking backend text', () => {
    expect(translateBackendError({
      status: 401,
      body: { message: 'caller must pass request_dict' },
      toolName: 'web_search',
      operation: 'search',
    })).toMatchObject({
      error_kind: 'auth_failed',
      upstream_status: 401,
    });

    expect(translateBackendError({
      status: 403,
      body: { message: 'Django permission class rejected queryset' },
      toolName: 'parse_document',
      operation: 'read',
    })).toMatchObject({
      error_kind: 'permission_denied',
      message: 'You do not have permission to access this resource.',
    });

    expect(translateBackendError({
      status: 404,
      body: { code: 'FILE_MISSING', message: 'DoesNotExist: FileRecord' },
      toolName: 'parse_document',
      operation: 'read',
    })).toMatchObject({
      error_kind: 'resource_not_found',
    });

    expect(translateBackendError({
      status: 429,
      body: { detail: 'serializer.errors too many requests' },
      toolName: 'web_search',
      operation: 'search',
    })).toMatchObject({
      error_kind: 'rate_limited',
    });
  });

  it('maps plan and credential backend codes to product semantics', () => {
    expect(translateBackendError({
      status: 409,
      body: { code: 'PLAN_NOT_DRAFT' },
      toolName: 'plan_update_todos',
      operation: 'update_todos',
    })).toMatchObject({
      error_kind: 'version_conflict',
      upstream_code: 'PLAN_NOT_DRAFT',
    });

    expect(translateBackendError({
      status: 410,
      body: { code: 'CREDENTIAL_EXPIRED' },
      toolName: 'credential_retrieve',
      operation: 'reveal',
    })).toMatchObject({
      error_kind: 'resource_not_found',
      upstream_code: 'CREDENTIAL_EXPIRED',
    });
  });

  it('maps service, timeout, and network failures', () => {
    expect(translateBackendError({
      status: 503,
      body: { message: 'Traceback: ValueError: boom' },
      toolName: 'memory_search',
      operation: 'search',
    })).toMatchObject({
      error_kind: 'upstream_error',
      message: 'The service is temporarily unavailable.',
    });

    expect(translateBackendError({
      status: 422,
      body: { detail: 'serializer.errors: request_dict is invalid' },
      toolName: 'memory_write',
      operation: 'write',
    })).toMatchObject({
      error_kind: 'invalid_param_format',
      message: 'The request parameters are not valid for this operation.',
    });

    expect(translateBackendError({
      error: new Error('AbortError: timeout'),
      toolName: 'web_search',
      operation: 'search',
    })).toMatchObject({
      error_kind: 'request_timeout',
    });

    expect(translateBackendError({
      error: new Error('fetch failed ECONNREFUSED'),
      toolName: 'web_search',
      operation: 'search',
    })).toMatchObject({
      error_kind: 'network_failed',
    });
  });

  it('detects and sanitizes backend implementation leaks', () => {
    expect(containsBackendInternalLeak('context_id is required by Django')).toBe(true);
    expect(sanitizeBackendText('serializer.errors: bad field', 'fallback message')).toBe('fallback message');
    expect(sanitizeBackendText('plain product message', 'fallback message')).toBe('plain product message');

    const translated = translateBackendError({
      status: 400,
      body: {
        code: 'ValidationError: BAD',
        error: 'serializer.errors: context_id is required',
        detail: 'Traceback: request_dict exploded',
      },
      toolName: 'web_search',
      operation: 'search',
    });
    expect(JSON.stringify(translated)).not.toMatch(/serializer\.errors|context_id|Traceback|ValidationError|request_dict/);
    expect(JSON.stringify(translated)).not.toContain('upstream_label');
  });

  it('maps search provider and billing backend codes for web_search', () => {
    expect(translateBackendError({
      status: 502,
      body: { code: 'SEARCH_ERROR', message: 'provider timeout' },
      toolName: 'web_search',
      operation: 'web search',
    })).toMatchObject({
      error_kind: 'upstream_error',
      message: 'The search provider could not complete the request.',
      upstream_code: 'SEARCH_ERROR',
      upstream_status: 502,
    });

    expect(translateBackendError({
      status: 402,
      body: { code: 'BILLING_ERROR', message: 'insufficient balance' },
      toolName: 'web_search',
      operation: 'web search',
    })).toMatchObject({
      error_kind: 'permission_denied',
      message: 'Web search is blocked by billing limits.',
      upstream_code: 'BILLING_ERROR',
    });

    expect(translateBackendError({
      status: 502,
      body: { code: 'search_billing_budget_exceeded', message: 'budget hit' },
      toolName: 'web_search',
      operation: 'web search',
    })).toMatchObject({
      error_kind: 'rate_limited',
      message: 'Web search is blocked by billing quota limits.',
    });

    expect(translateBackendError({
      status: 502,
      body: { code: 'search_provider_api_key_missing', message: 'no key' },
      toolName: 'web_search',
      operation: 'web search',
    })).toMatchObject({
      error_kind: 'runtime_misconfig',
      message: 'The search service is not configured.',
    });
  });

  it('only exposes whitelisted product-semantic upstream codes', () => {
    const unknown = translateBackendError({
      status: 404,
      body: {
        code: 'SQLSTATE_23505_PUBLIC_LOOKING',
        error: 'a backend label that is not a product contract',
      },
      toolName: 'parse_document',
      operation: 'read',
    });
    expect(JSON.stringify(unknown)).not.toContain('SQLSTATE_23505_PUBLIC_LOOKING');
    expect(JSON.stringify(unknown)).not.toContain('backend label');
    expect(unknown.upstream_code).toBeUndefined();

    const safe = translateBackendError({
      status: 409,
      body: { code: 'PLAN_NOT_DRAFT' },
      toolName: 'plan_update_todos',
      operation: 'update_todos',
    });
    expect(safe.upstream_code).toBe('PLAN_NOT_DRAFT');
  });
});

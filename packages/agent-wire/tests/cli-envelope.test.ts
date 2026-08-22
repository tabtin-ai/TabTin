/**
 * Wave 0 — cli-envelope contract tests.
 *
 * Locks in the envelope shape produced by `okResponse` / `errResponse` and
 * the `ErrorCode` taxonomy. These assertions are the load-bearing piece
 * of D-2 ("不考虑兼容性") — if a future change accidentally re-introduces
 * the legacy `{ success }` shape or breaks the trace_id pass-through,
 * these tests fail loudly.
 */

import { describe, it, expect } from 'vitest';
import {
  okResponse,
  errResponse,
  ERROR_CODES,
  isErrorCode,
  type CliErrorResponse,
  type CliOkResponse,
} from '../src/index.js';

describe('okResponse', () => {
  it('default shape has only ok + data (no spurious metadata fields)', () => {
    const r = okResponse({ items: [1, 2] });
    expect(r).toEqual({ ok: true, data: { items: [1, 2] } });
    expect(r).not.toHaveProperty('trace_id');
    expect(r).not.toHaveProperty('duration_ms');
    expect(r).not.toHaveProperty('error');
    expect(r).not.toHaveProperty('success');
  });

  it('places trace_id at the envelope top level (W5 audit-log path)', () => {
    const r = okResponse({ id: 'x' }, { trace_id: 'req-abc-123' });
    expect(r).toEqual({
      ok: true,
      data: { id: 'x' },
      trace_id: 'req-abc-123',
    });
  });

  it('places duration_ms at the envelope top level', () => {
    const r = okResponse({ id: 'x' }, { duration_ms: 42 });
    expect(r.duration_ms).toBe(42);
    expect(r).not.toHaveProperty('meta');
  });

  it('preserves empty-string trace_id (Python mirror parity)', () => {
    const r = okResponse({ id: 'x' }, { trace_id: '' });
    expect(r.trace_id).toBe('');
  });

  it('preserves null / undefined / primitive payloads as-is', () => {
    expect(okResponse(null)).toEqual({ ok: true, data: null });
    expect(okResponse(0)).toEqual({ ok: true, data: 0 });
    expect(okResponse('hello')).toEqual({ ok: true, data: 'hello' });
  });
});

describe('errResponse', () => {
  it('default shape: ok=false + error.code/message + retryable=false', () => {
    const r = errResponse('NOT_FOUND', 'organization not found');
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'organization not found',
        retryable: false,
      },
    });
    expect(r).not.toHaveProperty('success');
  });

  it('honors retryable / suggestions when provided', () => {
    const r = errResponse('RATE_LIMIT_EXCEEDED', 'too many requests', {
      retryable: true,
      suggestions: ['retry after 30s'],
    });
    expect(r.error.retryable).toBe(true);
    expect(r.error.suggestions).toEqual(['retry after 30s']);
  });

  it('drops empty suggestions array (does not pollute envelope)', () => {
    const r = errResponse('VALIDATION_ERROR', 'bad input', { suggestions: [] });
    expect(r.error).not.toHaveProperty('suggestions');
  });

  it('places trace_id at the envelope top level (parity with GatewayEnvelope)', () => {
    const r = errResponse('INTERNAL_ERROR', 'boom', { trace_id: 'req-deadbeef' });
    expect(r.trace_id).toBe('req-deadbeef');
    // Must NOT live under error — that was the v1 placement and the
    // Wave 0 review specifically asked us to move it.
    expect(r.error).not.toHaveProperty('trace_id');
  });

  it('omits trace_id when caller did not pass one', () => {
    const r = errResponse('TIMEOUT', 'slow');
    expect(r).not.toHaveProperty('trace_id');
  });

  it('preserves empty-string trace_id ("" !== undefined) — Python mirror parity', () => {
    // The Python ``err_response`` helper had a falsy-check bug that
    // dropped ''. Lock the TS invariant so the cross-language wire shape
    // never silently coerces ''→missing in one direction; W5 audit log
    // joins on this field across stacks.
    const r = errResponse('INTERNAL_ERROR', 'boom', { trace_id: '' });
    expect(r.trace_id).toBe('');
    expect(r).toHaveProperty('trace_id');
  });

  it('places duration_ms at the envelope top level', () => {
    const r = errResponse('UNAVAILABLE', 'down', { duration_ms: 42 });
    expect(r.duration_ms).toBe(42);
    expect(r).not.toHaveProperty('meta');
  });

  it('supports both trace_id and duration_ms together', () => {
    const r = errResponse('UNAVAILABLE', 'down', {
      trace_id: 'req-1',
      duration_ms: 42,
    });
    expect(r).toMatchObject({
      ok: false,
      trace_id: 'req-1',
      duration_ms: 42,
    });
  });

  it('accepts loose string codes for legacy / surface-local codes (CliErrorCode)', () => {
    // `TABDATA_VIEW_LOCKED` is a domain code — not in ERROR_CODES but still
    // must type-check via the `(string & {})` branch of CliErrorCode.
    const r = errResponse('TABDATA_VIEW_LOCKED', 'view is locked');
    expect(r.error.code).toBe('TABDATA_VIEW_LOCKED');
  });
});

describe('ERROR_CODES taxonomy', () => {
  it('contains the canonical Wave-0 generic codes', () => {
    // Sanity bound — the taxonomy is intentionally small. If this number
    // grows past ~24 we should revisit whether business / surface-local
    // codes are leaking into the canonical list.
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(12);
    expect(ERROR_CODES.length).toBeLessThanOrEqual(24);
  });

  it('includes all required canonical codes', () => {
    const required = [
      'AUTH_INVALID',
      'AUTH_EXPIRED',
      'UNAUTHORIZED',
      'PERMISSION_DENIED',
      'FORBIDDEN',
      'NOT_FOUND',
      'VALIDATION_ERROR',
      'CONFLICT',
      'RATE_LIMIT_EXCEEDED',
      'QUOTA_EXCEEDED',
      'TIMEOUT',
      'UNAVAILABLE',
      'CANCELLED',
      'NOT_IMPLEMENTED',
      'INTERNAL_ERROR',
      'SOFT_FAIL',
      'LEGACY_SHAPE',
    ] as const;
    for (const code of required) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('every code matches SCREAMING_SNAKE_CASE convention', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe('isErrorCode runtime guard', () => {
  it('accepts every value in ERROR_CODES', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('rejects domain / unknown codes', () => {
    expect(isErrorCode('TABDATA_VIEW_LOCKED')).toBe(false);
    expect(isErrorCode('not_a_code')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode({ code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('Envelope discrimination (renderer / preload-shim use case)', () => {
  it('ok envelope is statically distinguishable from err envelope', () => {
    // This block exercises the type discriminant pattern that the preload
    // shim relies on — `if (!r.ok) ...` MUST narrow `r` to CliErrorResponse.
    const r: CliOkResponse<number> | CliErrorResponse = okResponse(7);
    if (r.ok) {
      expect(r.data).toBe(7);
    } else {
      throw new Error('expected ok envelope');
    }

    const e: CliOkResponse<number> | CliErrorResponse = errResponse(
      'INTERNAL_ERROR',
      'x',
    );
    if (!e.ok) {
      expect(e.error.code).toBe('INTERNAL_ERROR');
    } else {
      throw new Error('expected err envelope');
    }
  });
});

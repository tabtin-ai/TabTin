/**
 * Wave 3 Task A — numeric TabcodeErrorCode / error_code 协议退役契约。
 *
 * 新失败 envelope 只含 error_kind + hint（及 op/context/path），不含 numeric
 * error_code；extractor / stream 字段统一读 error_kind；无双读 fallback。
 */
import { describe, expect, it } from 'vitest';

import { extractToolErrorCode } from '../src/engine/tooling/tool-error-code.js';
import {
  errorResultEnvelope,
  mapActionErrorToRuntimeKind,
} from '../src/tools/read-file-state.js';
import { TOOL_STALE_READ, OLD_STRING_NOT_FOUND } from '../src/engine/errors/error-kinds.js';

function parseEnvelope(result: { content: string; isError?: boolean }) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

describe('Wave3 error_kind-only tabcode envelope', () => {
  it('errorResultEnvelope emits error_kind + hint and never error_code', () => {
    const result = errorResultEnvelope({
      errorKind: TOOL_STALE_READ,
      message: 'File changed since last read',
      path: '/tmp/a.ts',
      op: 'edit_file',
    });
    expect(result.isError).toBe(true);
    const parsed = parseEnvelope(result);
    expect(parsed.error_kind).toBe(TOOL_STALE_READ);
    expect(typeof parsed.hint).toBe('string');
    expect(parsed.error_code).toBeUndefined();
    expect(Object.keys(parsed).some((k) => k === 'error_code')).toBe(false);
  });

  it('mapActionErrorToRuntimeKind bridges browser/action codes without inventing kinds', () => {
    expect(mapActionErrorToRuntimeKind({ code: 'stale_read', message: 'stale' }).errorKind).toBe(
      TOOL_STALE_READ,
    );
    expect(
      mapActionErrorToRuntimeKind({ code: 'old_string_not_found', message: 'nf' }).errorKind,
    ).toBe(OLD_STRING_NOT_FOUND);
    expect(
      mapActionErrorToRuntimeKind({ code: 'network_error', message: 'net' }).errorKind,
    ).toBe('network_failed');
    // unmapped → existing safe fallback (upstream_error), not a new literal
    expect(mapActionErrorToRuntimeKind({ code: 'element_not_found', message: 'x' }).errorKind).toBe(
      'upstream_error',
    );
  });

  it.each([
    ['missing_required_param', 'missing_required_param', 'missing required parameter'],
    ['invalid_parameter', 'invalid_param_format', 'invalid parameter'],
    ['timeout', 'request_timeout', 'timeout'],
    ['rate_limited', 'rate_limited', 'retry'],
  ])(
    'emits an actionable non-file-specific hint for action code %s',
    (code, expectedKind, expectedHint) => {
      const mapped = mapActionErrorToRuntimeKind({ code, message: `${code} failure` });
      const parsed = parseEnvelope(
        errorResultEnvelope({
          errorKind: mapped.errorKind,
          message: mapped.message,
          suggestion: mapped.suggestion,
        }),
      );

      expect(parsed.error_kind).toBe(expectedKind);
      expect(String(parsed.hint).toLowerCase()).toContain(expectedHint);
      expect(parsed.hint).not.toContain('unexpected upstream error');
      expect(parsed.hint).not.toContain('重新上传');
    },
  );

  it('extractToolErrorCode reads error_kind only (no numeric / error_code fallback)', () => {
    const kindOnly = {
      content: JSON.stringify({
        success: false,
        error_kind: TOOL_STALE_READ,
        hint: 're-read',
        error: 'stale',
      }),
      isError: true,
    };
    expect(extractToolErrorCode(kindOnly)).toBe(TOOL_STALE_READ);

    const legacyNumeric = {
      content: JSON.stringify({
        success: false,
        error_code: 7,
        error: 'stale',
      }),
      isError: true,
    };
    expect(extractToolErrorCode(legacyNumeric)).toBeUndefined();

    const legacyStringCode = {
      content: JSON.stringify({
        success: false,
        error_code: 'permission_denied',
        error: 'denied',
      }),
      isError: true,
    };
    expect(extractToolErrorCode(legacyStringCode)).toBeUndefined();
  });
});

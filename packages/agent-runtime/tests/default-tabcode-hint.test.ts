/**
 * defaultTabcodeHint 分流回归（ P2）：
 *   - aborted → 用户取消文案
 *   - file-pipeline 无 suggestion → generic upstream/file-operation（不得串成用户取消）
 *   - unknown kind → 同款 generic（不得串成用户取消）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import * as filePipelineErrors from '@tabtin/file-pipeline-errors';
import { errorResultEnvelope } from '../src/tools/read-file-state.js';

const USER_CANCEL_HINT =
  'The user cancelled this operation. Respect the user choice; do not auto-retry.';
const GENERIC_UPSTREAM_HINT =
  'The file operation failed with an unexpected upstream error. Tell the user the issue and consider retrying once.';

function parseHint(result: { content: unknown; isError: boolean }): string {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(result.content as string) as { hint: string };
  return parsed.hint;
}

describe('defaultTabcodeHint fallbacks (aborted / no-suggestion pipeline / unknown)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aborted → user-cancel hint（不走 generic upstream）', () => {
    const hint = parseHint(
      errorResultEnvelope({
        errorKind: 'aborted',
        message: 'Local read aborted (user cancelled).',
        path: '/tmp/cancelled.pdf',
      }),
    );
    expect(hint).toBe(USER_CANCEL_HINT);
    expect(hint).not.toContain('unexpected upstream');
  });

  it('file-pipeline 无 suggestion → generic upstream（不串用户取消）', () => {
    vi.spyOn(filePipelineErrors, 'formatFilePipelineError').mockReturnValue({
      errorKind: 'corrupted',
      message: 'Document is corrupted.',
      suggestion: undefined,
      i18nKey: 'corrupted',
    });

    const hint = parseHint(
      errorResultEnvelope({
        errorKind: 'corrupted',
        message: 'Document is corrupted.',
        path: '/tmp/broken.docx',
      }),
    );
    expect(hint).toBe(GENERIC_UPSTREAM_HINT);
    expect(hint).not.toMatch(/user cancelled|respect the user choice/i);
  });

  it('unknown kind → generic upstream（不串用户取消）', () => {
    const hint = parseHint(
      errorResultEnvelope({
        errorKind: 'totally_unknown_kind_for_hint_test',
        message: 'something unexpected',
      }),
    );
    expect(hint).toBe(GENERIC_UPSTREAM_HINT);
    expect(hint).not.toMatch(/user cancelled|respect the user choice/i);
  });

  it('三条文案互不串：aborted / no-suggestion pipeline / unknown', () => {
    const aborted = parseHint(
      errorResultEnvelope({
        errorKind: 'aborted',
        message: 'aborted',
      }),
    );

    vi.spyOn(filePipelineErrors, 'formatFilePipelineError').mockReturnValue({
      errorKind: 'corrupted',
      message: 'corrupted',
      suggestion: undefined,
      i18nKey: 'corrupted',
    });
    const noSuggestion = parseHint(
      errorResultEnvelope({
        errorKind: 'corrupted',
        message: 'corrupted',
      }),
    );
    vi.restoreAllMocks();

    const unknown = parseHint(
      errorResultEnvelope({
        errorKind: 'not_a_real_error_kind',
        message: 'x',
      }),
    );

    expect(aborted).toBe(USER_CANCEL_HINT);
    expect(noSuggestion).toBe(GENERIC_UPSTREAM_HINT);
    expect(unknown).toBe(GENERIC_UPSTREAM_HINT);
    expect(new Set([aborted, noSuggestion, unknown]).size).toBe(2);
    expect(aborted).not.toBe(noSuggestion);
    expect(aborted).not.toBe(unknown);
  });
});

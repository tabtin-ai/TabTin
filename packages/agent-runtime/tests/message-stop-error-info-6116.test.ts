/**
 * ：异常终止 message_stop.error_info 与 DONE.error_class 对齐。
 */
import { describe, expect, it } from 'vitest';

import {
  buildAbortMessageStopErrorInfo,
  buildBudgetExceededMessageStopErrorInfo,
  buildClassifiedTerminalErrorInfo,
  buildHardStopDonePayload,
  buildHardStopMessageStopErrorInfo,
  hardStopErrorClass,
} from '../src/engine/wire/done-payloads.js';

describe('#6116 message_stop error_info builders', () => {
  it('硬停 error_class 与 DONE 一致，且不写用户可见 error_message', () => {
    for (const source of ['tool_failure', 'tool_repetition', 'text_repetition'] as const) {
      const info = buildHardStopMessageStopErrorInfo(source);
      const done = buildHardStopDonePayload({
        source,
        usage: { input_tokens: 0, output_tokens: 0 },
        traceId: 't',
      });
      expect(info.error_class).toBe(hardStopErrorClass(source));
      expect(info.error_class).toBe(done.error_class);
      expect(info.error_message).toBeUndefined();
      expect(info.category).toBe('runtime_failed');
      expect(info.partial_reason).toBe('message_stop_fallback');
    }
  })

  it('ABORT 带 error_class，无英文兜底文案', () => {
    const info = buildAbortMessageStopErrorInfo();
    expect(info).toEqual({
      error_class: 'ABORT',
      category: 'aborted',
      partial_reason: 'aborted',
    });
  })

  it('预算墙 error_class 透传', () => {
    expect(buildBudgetExceededMessageStopErrorInfo('iteration_budget_exhausted').error_class)
      .toBe('iteration_budget_exhausted');
    expect(buildBudgetExceededMessageStopErrorInfo('MAX_CREDITS_EXCEEDED').category)
      .toBe('budget_exceeded');
  })

  it('内部分类映射到 wire 的 runtime_failed，同时保留原始分类供诊断', () => {
    expect(buildClassifiedTerminalErrorInfo({
      classified: {
        code: 'LLM_ERROR',
        category: 'internal',
        retryable: false,
        suggestedAction: 'contact_support',
        showAsAssistant: true,
        userMessage: '遇到了意外问题',
        originalError: new Error('provider failed'),
      },
      errorClass: 'LLM_ERROR',
      errorMessage: '遇到了意外问题',
      partialReason: 'message_stop_fallback',
    })).toMatchObject({
      category: 'runtime_failed',
      error_extras: { classified_category: 'internal' },
    });
  })
})

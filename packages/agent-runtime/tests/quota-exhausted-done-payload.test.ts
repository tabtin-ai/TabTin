/**
 * quota_only 点券用尽：本地 runtime DONE 必须带
 * error_category=organization_insufficient_credits + error_extras.topup_reason，
 * 供 Electron BillingErrorCard 按角色引导（与 Django billing_gateway 同口径）。
 */
import { describe, expect, it } from 'vitest';
import { AgentError } from '../src/engine/index.js';
import { classifyError } from '../src/engine/errors/error-classifier.js';
import {
  buildErrorDonePayload,
  pickErrorExtras,
} from '../src/engine/wire/done-payloads.js';

describe('quota exhausted DONE payload (local runtime path)', () => {
  it('classify + buildErrorDonePayload 透传 organization_insufficient_credits 与 topup_reason', () => {
    const err = new AgentError(
      '[organization_insufficient_credits] 本月 LLM 点券已用完',
      'LLM_BILLING_ERROR',
      {
        statusCode: 402,
        retryable: false,
        details: {
          fromProxySSE: true,
          user_message: '本月 LLM 点券已用完，请联系组织管理员充值或开启点券自动补充',
          error_type: 'organization_insufficient_credits',
          topup_reason: 'auto_topup_disabled',
        },
      },
    );

    const classified = classifyError(err);
    expect(classified.category).toBe('organization_insufficient_credits');
    expect(classified.suggestedAction).toBe('check_billing');
    expect(classified.code).toBe('LLM_BILLING_ERROR');

    const extras = pickErrorExtras(err.details);
    expect(extras).toEqual(expect.objectContaining({ topup_reason: 'auto_topup_disabled' }));

    const done = buildErrorDonePayload(
      err.code,
      err.message,
      { input_tokens: 0, output_tokens: 0 },
      'trace-test',
      classified,
      {
        content: classified.userMessage,
        error_metadata: {
          isErrorMessage: true,
          errorCategory: classified.category,
          suggestedAction: classified.suggestedAction,
        },
      },
    );

    expect(done.error_class).toBe('LLM_BILLING_ERROR');
    expect(done.error_category).toBe('organization_insufficient_credits');
    expect(done.suggested_action).toBe('check_billing');
    expect(done.error_extras).toEqual(
      expect.objectContaining({ topup_reason: 'auto_topup_disabled' }),
    );
  });

  it('organization_insufficient_credits 即使误标 LLM_ERROR 也能分到组织点券 category', () => {
    // 修复前 isProxySSEBillingError 漏了该 type，会落成 LLM_ERROR；
    // classifier 仍应按 error_type 路由到 BillingErrorCard 口径。
    const err = new AgentError(
      '[organization_insufficient_credits] 本月 LLM 点券已用完',
      'LLM_ERROR',
      {
        statusCode: 402,
        details: {
          fromProxySSE: true,
          user_message: '本月 LLM 点券已用完',
          error_type: 'organization_insufficient_credits',
          topup_reason: 'wallet_insufficient',
        },
      },
    );
    const classified = classifyError(err);
    expect(classified.category).toBe('organization_insufficient_credits');
    expect(classified.code).toBe('LLM_ERROR'); // 保留原 code
    const done = buildErrorDonePayload(
      classified.code,
      classified.userMessage,
      { input_tokens: 0, output_tokens: 0 },
      'trace-2',
      classified,
    );
    expect(done.error_category).toBe('organization_insufficient_credits');
    expect(done.error_extras).toEqual(
      expect.objectContaining({ topup_reason: 'wallet_insufficient' }),
    );
  });
});

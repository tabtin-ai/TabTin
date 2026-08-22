import { describe, expect, it } from 'vitest';

import { PersistMessageEventPayloadSchema } from '../src/events.js';

describe('PersistMessageEventPayloadSchema error_info_json', () => {
  it('保留空正文终态错误的结构化信息', () => {
    const payload = PersistMessageEventPayloadSchema.parse({
      message_id: 'message-error',
      role: 'assistant',
      blocks_json: [],
      stop_reason: 'error',
      partial: true,
      error_info_json: {
        error_class: 'LLM_BILLING_ERROR',
        category: 'organization_insufficient_credits',
        suggested_action: 'check_billing',
      },
    });

    expect(payload.error_info_json).toEqual(expect.objectContaining({
      error_class: 'LLM_BILLING_ERROR',
      category: 'organization_insufficient_credits',
    }));
  });
});

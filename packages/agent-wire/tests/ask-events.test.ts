import { describe, expect, it } from 'vitest';

import { StreamEvents } from '../src/events.js';

/**
 * ask 工具 stream event 单测（W4 R3 / 2026-05-11，三件套并存形态）。
 *
 * 历史：W7 拆三件套；W4 短暂合一为单 ask_user_required；W4 R3 拆回三件套并存——
 *   平台型产品里 ask_form / request_approval 各有独立产品语义不可合并。
 *   详见 200_审计/B_ask_approval_协议.md §六。
 */
describe('ask tool stream events (W4 R3: 三件套并存)', () => {
  it('defines ASK_USER_REQUIRED (兼容 ask_choice 场景)', () => {
    expect(StreamEvents.ASK_USER_REQUIRED).toBe('agent.stream.ask_user_required');
  });

  it('defines ASK_FORM_REQUIRED (多字段结构化表单)', () => {
    expect(StreamEvents.ASK_FORM_REQUIRED).toBe('agent.stream.ask_form_required');
  });

  it('defines REQUEST_APPROVAL_REQUIRED (destructive 操作授权 + risk_level)', () => {
    expect(StreamEvents.REQUEST_APPROVAL_REQUIRED).toBe('agent.stream.request_approval_required');
  });

  it('does NOT define ASK_CHOICE_REQUIRED (W4 R3: ask_choice 由 ASK_USER_REQUIRED 兼容)', () => {
    // 注意：ask_choice 在 W4 时期被合并到 ask_user，W4 R3 决定继续合并（B 报告
    // §六明示"ask_choice → ask_user 合一是合理对齐"）。仅 ask_form / request_approval
    // 拆回三件套形态。
    expect(Object.prototype.hasOwnProperty.call(StreamEvents, 'ASK_CHOICE_REQUIRED')).toBe(false);
    expect(Object.values(StreamEvents)).not.toContain('agent.stream.ask_choice_required');
  });
});

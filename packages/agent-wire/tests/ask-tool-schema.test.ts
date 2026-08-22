import { describe, expect, it } from 'vitest';

import {
  AskUserRequestSchema,
  AskUserResponseSchema,
  AskFormRequestSchema,
  AskFormResponseSchema,
  RequestApprovalRequestSchema,
  RequestApprovalResponseSchema,
  AskInteractionRequestSchema,
} from '../src/approval.js';

/**
 * ask 三件套 wire schema 单测（W4 R3 / 2026-05-11，三件套并存形态）。
 *
 * 历史：W7 拆三件套；W4 短暂合一为单 ask_user；W4 R3 拆回三件套并存
 *   （详见 200_审计/B_ask_approval_协议.md §六）。
 */

/** baseMeta 默认 ask_user 形态；ask_form / request_approval override intent + form_mode */
const baseMeta = {
  interaction_type: 'ask_user' as const,
  blocking_policy: 'hard' as const,
  intent: 'choose' as const,
  form_mode: 'questions' as const,
};

const askFormMeta = {
  interaction_type: 'ask_user' as const,
  blocking_policy: 'hard' as const,
  intent: 'collect' as const,
  form_mode: 'fields' as const,
};

const requestApprovalMeta = {
  interaction_type: 'ask_user' as const,
  blocking_policy: 'hard' as const,
  intent: 'approve' as const,
  form_mode: 'approval' as const,
};

const baseQuestion = {
  id: 'q1',
  prompt: 'Which?',
  // W4 R2 (P2-6, 2026-05-11): header 改 required。
  header: 'Pick',
  options: [
    { id: 'a', label: 'A', description: 'Use A.' },
    { id: 'b', label: 'B', description: 'Use B.' },
  ],
};

describe('AskUserRequestSchema (W4: 单 ask_user 工具)', () => {
  it('accepts minimal valid payload (questions[1] + 2 options)', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [baseQuestion],
    })).not.toThrow();
  });

  it('accepts optional login-wall context hint with target tab', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [baseQuestion],
      context_hint: { kind: 'login_wall', domain: 'example.com', tab_id: 'view-login-wall' },
    })).not.toThrow();
  });

  it('accepts optional other_option (same shape as option; id optional)', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [{
        ...baseQuestion,
        other_option: {
          label: '其他页面',
          description: '你告诉我具体页面和要验证的功能',
        },
        options: [
          ...baseQuestion.options,
          { id: '__other__', label: '其他页面', description: '你告诉我具体页面和要验证的功能' },
        ],
      }],
    })).not.toThrow();
  });

  it('accepts optional title + header + preview + multi-question', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      title: 'Choose stack',
      questions: [
        {
          id: 'q1',
          prompt: 'Which library?',
          header: 'Library',
          options: [
            { id: 'a', label: 'date-fns', description: 'Functional.' },
            { id: 'b', label: 'dayjs', description: 'Lightweight.', preview: 'dayjs().format("YYYY-MM-DD")' },
          ],
          allow_multiple: false,
        },
        {
          id: 'q2',
          prompt: 'Features?',
          header: 'Features',
          options: [
            { id: 'i18n', label: 'i18n', description: 'Internationalization.' },
            { id: 'a11y', label: 'a11y', description: 'Accessibility.' },
          ],
          allow_multiple: true,
          allow_free_text: true,
        },
      ],
    })).not.toThrow();
  });

  it('rejects payload with missing tool_name', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      ...baseMeta,
      questions: [baseQuestion],
    })).toThrow();
  });

  it('rejects payload with wrong tool_name (regression guard for old triade names)', () => {
    for (const oldName of ['ask_choice', 'ask_form', 'request_approval', 'ask_question']) {
      expect(() => AskUserRequestSchema.parse({
        request_id: 'r1',
        tool_name: oldName,
        ...baseMeta,
        questions: [baseQuestion],
      })).toThrow();
    }
  });

  it('rejects > 4 questions (max 4)', () => {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      ...baseQuestion,
      id: `q${i}`,
      prompt: `Question ${i}?`,
    }));
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions,
    })).toThrow();
  });

  it('rejects question with < 2 options', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [{
        id: 'q1',
        prompt: 'Which?',
        header: 'Pick',
        options: [{ id: 'a', label: 'A', description: 'Just A.' }],
      }],
    })).toThrow();
  });

  it('rejects option missing description', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [{
        id: 'q1',
        prompt: 'Which?',
        header: 'Pick',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', description: 'Use B.' },
        ],
      }],
    })).toThrow();
  });

  // W4 R2 (P2-6): header required —— 不传 / 空字符串 / >12 字符都拒绝。
  it('rejects question without header (W4 R2: header is required)', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [{
        id: 'q1',
        prompt: 'Which?',
        // header 缺失
        options: [
          { id: 'a', label: 'A', description: 'Use A.' },
          { id: 'b', label: 'B', description: 'Use B.' },
        ],
      }],
    })).toThrow();
  });

  it('rejects question with header > 12 chars', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [{
        id: 'q1',
        prompt: 'Which?',
        header: 'this-is-way-too-long-chip-tag',  // 超 12 字符
        options: [
          { id: 'a', label: 'A', description: 'Use A.' },
          { id: 'b', label: 'B', description: 'Use B.' },
        ],
      }],
    })).toThrow();
  });

  it('rejects extra fields (.strict() mode)', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [baseQuestion],
      // 故意加未知字段
      malicious_field: 'attacker injection',
    })).toThrow();
  });

  it('rejects missing interaction_type / blocking_policy', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      questions: [baseQuestion],
    })).toThrow();
  });

  it('accepts wire envelope transport fields (message_id / tool_call_id / etc.)', () => {
    expect(() => AskUserRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [baseQuestion],
      message_id: 'msg-1',
      tool_call_id: 'tc-1',
      interrupt_id: 'int-1',
      trace_id: 'trace-1',
      preset_id: 'preset-1',
    })).not.toThrow();
  });
});

describe('AskUserResponseSchema (W4)', () => {
  it('accepts answers with selected_options', () => {
    expect(() => AskUserResponseSchema.parse({
      answers: [
        { question_id: 'q1', selected_options: ['a'] },
        { question_id: 'q2', selected_options: ['x', 'y'], free_text: 'extra notes' },
      ],
    })).not.toThrow();
  });

  it('rejects extra response fields', () => {
    expect(() => AskUserResponseSchema.parse({
      answers: [{ question_id: 'q1', selected_options: ['a'] }],
      malicious: 'inject',
    })).toThrow();
  });

  it('rejects answers without question_id', () => {
    expect(() => AskUserResponseSchema.parse({
      answers: [{ selected_options: ['a'] }],
    })).toThrow();
  });
});

// ─── W4 R3: AskFormRequestSchema 三件套并存恢复测试 ──────────────────

describe('AskFormRequestSchema (W4 R3: 三件套并存)', () => {
  const baseFormFields = [
    { key: 'name', label: 'Name', type: 'input', placeholder: 'Project name' },
    { key: 'desc', label: 'Description', type: 'textarea' },
  ];

  it('accepts minimal valid form payload', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      ...askFormMeta,
      title: 'Project info',
      fields: baseFormFields,
    })).not.toThrow();
  });

  it('rejects emitted form payload missing key because runtime must enrich before wire', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      ...askFormMeta,
      title: 'Project info',
      fields: [{ label: 'Project name', type: 'input', placeholder: 'TabTin' }],
    })).toThrow();
  });

  it('rejects payload with wrong tool_name', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...askFormMeta,
      title: 'Project info',
      fields: baseFormFields,
    })).toThrow();
  });

  it('rejects payload missing intent / form_mode', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      interaction_type: 'ask_user',
      blocking_policy: 'hard',
      title: 'Project info',
      fields: baseFormFields,
    })).toThrow();
  });

  it('rejects empty fields array', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      ...askFormMeta,
      title: 'Project info',
      fields: [],
    })).toThrow();
  });

  it('accepts addons + submit_label + transport fields', () => {
    expect(() => AskFormRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      ...askFormMeta,
      title: 'Login',
      fields: baseFormFields,
      addons: [{ kind: 'attachment', label: 'Cred file' }],
      submit_label: 'Save',
      message_id: 'msg-1',
      tool_call_id: 'tc-1',
    })).not.toThrow();
  });
});

describe('AskFormResponseSchema (W4 R3)', () => {
  it('accepts arbitrary field_values record', () => {
    expect(() => AskFormResponseSchema.parse({
      field_values: { name: 'TabTin', count: 42, enabled: true },
    })).not.toThrow();
  });

  it('rejects extra response fields', () => {
    expect(() => AskFormResponseSchema.parse({
      field_values: { name: 'X' },
      injected: 'bad',
    })).toThrow();
  });
});

// ─── W4 R3: RequestApprovalRequestSchema 三件套并存恢复测试 ──────────

describe('RequestApprovalRequestSchema (W4 R3: 三件套并存)', () => {
  const baseApproval = {
    request_id: 'r1',
    tool_name: 'request_approval' as const,
    title: 'Confirm deletion',
    rationale: 'This will permanently delete 5 production rows.',
    risk_level: 'high' as const,
  };

  it('accepts minimal valid approval payload (high risk)', () => {
    expect(() => RequestApprovalRequestSchema.parse({
      ...baseApproval,
      ...requestApprovalMeta,
    })).not.toThrow();
  });

  it('accepts safe / review / high risk levels', () => {
    for (const risk of ['safe', 'review', 'high'] as const) {
      expect(() => RequestApprovalRequestSchema.parse({
        ...baseApproval,
        ...requestApprovalMeta,
        risk_level: risk,
      })).not.toThrow();
    }
  });

  it('rejects unknown risk level', () => {
    expect(() => RequestApprovalRequestSchema.parse({
      ...baseApproval,
      ...requestApprovalMeta,
      risk_level: 'critical',
    })).toThrow();
  });

  it('rejects missing rationale', () => {
    const { rationale: _omit, ...withoutRationale } = baseApproval;
    expect(() => RequestApprovalRequestSchema.parse({
      ...withoutRationale,
      ...requestApprovalMeta,
    })).toThrow();
  });

  it('accepts optional details + submit/decline labels', () => {
    expect(() => RequestApprovalRequestSchema.parse({
      ...baseApproval,
      ...requestApprovalMeta,
      details: { rows: 5, table: 'orders' },
      submit_label: 'Yes, delete',
      decline_label: 'Cancel',
    })).not.toThrow();
  });
});

describe('RequestApprovalResponseSchema (W4 R3)', () => {
  it('accepts approved=true', () => {
    expect(() => RequestApprovalResponseSchema.parse({ approved: true })).not.toThrow();
  });

  it('accepts approved=false', () => {
    expect(() => RequestApprovalResponseSchema.parse({ approved: false })).not.toThrow();
  });

  it('rejects missing approved field', () => {
    expect(() => RequestApprovalResponseSchema.parse({})).toThrow();
  });
});

// ─── W4 R3: AskInteractionRequestSchema discriminated union ──────────

describe('AskInteractionRequestSchema (W4 R3: 三件套 discriminated union)', () => {
  it('routes by tool_name discriminator: ask_user', () => {
    const parsed = AskInteractionRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_user',
      ...baseMeta,
      questions: [baseQuestion],
    });
    expect(parsed.tool_name).toBe('ask_user');
  });

  it('routes by tool_name discriminator: ask_form', () => {
    const parsed = AskInteractionRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_form',
      ...askFormMeta,
      title: 'Login',
      fields: [{ key: 'token', label: 'Token', type: 'input' }],
    });
    expect(parsed.tool_name).toBe('ask_form');
  });

  it('routes by tool_name discriminator: request_approval', () => {
    const parsed = AskInteractionRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'request_approval',
      ...requestApprovalMeta,
      title: 'Confirm',
      rationale: 'Will rm -rf /tmp/cache',
      risk_level: 'review',
    });
    expect(parsed.tool_name).toBe('request_approval');
  });

  it('rejects unknown tool_name (regression guard for retired triade names)', () => {
    expect(() => AskInteractionRequestSchema.parse({
      request_id: 'r1',
      tool_name: 'ask_choice', // historical name — split into ask_user
      ...baseMeta,
      questions: [baseQuestion],
    })).toThrow();
  });
});

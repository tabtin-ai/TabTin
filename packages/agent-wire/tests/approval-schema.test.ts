/**
 * approval-schema.test.ts — PRD 05 W1A-轮 2 + W1.5 batch 升格 协议契约锁定。
 *
 * 锁定项（v0.4 W1.5 后）：
 *   1. `StreamEvents.APPROVAL_REQUESTED` / `APPROVAL_RESOLVED` 字符串值与
 *      `APPROVAL_REQUESTED_EVENT_TYPE` / `APPROVAL_RESOLVED_EVENT_TYPE` 一致
 *   2. `ApprovalRequestedPayloadSchema` 接受 `batch_id` + `action_requests[]` 形态
 *      （v0.4 升格 batch；v0.3a 单 request_id 形态已删除）；roundtrip 字段无丢失
 *   3. `ApprovalResolvedPayloadSchema` 接受 `batch_id` + `decisions[]` 形态；
 *      五种 outcome 均合法；非法 outcome 拒绝
 *   4. `DecisionReasonSchema` discriminated union 每个分支都能 parse；非法 type 被拒
 *   5. `ApprovalScope` v0.3 命名为 thread（不是 session）
 *   6. `runtime_mode` 四态（含 batch）
 *   7. `approval_type` v0.4 后只有 'tool_permission'（plan_exit 已删除）
 *   8. `LocalRtUserResponsePayload` 升格 batch（`batch_id` + `decisions[]`）
 *
 * 破坏这些契约会让 W1A-轮 2 / W1.5 产出的协议不对齐；改动本文件必须伴随
 * v0.x schema 升级说明（PRD §8.6.5 schema_version bump 流程）。
 */

import { describe, it, expect } from 'vitest';
import {
  StreamEvents,
  APPROVAL_REQUESTED_EVENT_TYPE,
  APPROVAL_RESOLVED_EVENT_TYPE,
  ApprovalRequestedPayloadSchema,
  ApprovalResolvedPayloadSchema,
  ApprovalRequestedEventSchema,
  ApprovalResolvedEventSchema,
  ApprovalActionRequestSchema,
  ApprovalDecisionSchema,
  LocalRtUserResponsePayloadSchema,
  DecisionReasonSchema,
  ApprovalScopeSchema,
  RuntimeModeSchema,
  ApprovalOutcomeSchema,
} from '@tabtin/agent-wire';

void ApprovalActionRequestSchema; // 间接通过 payload 校验，导出供消费方使用
void ApprovalDecisionSchema;

describe('W1A-轮 2 — approval 事件常量锁定', () => {
  it('APPROVAL_REQUESTED 常量与 StreamEvents 一致', () => {
    expect(APPROVAL_REQUESTED_EVENT_TYPE).toBe(StreamEvents.APPROVAL_REQUESTED);
    expect(APPROVAL_REQUESTED_EVENT_TYPE).toBe(
      'agent.stream.approval_requested',
    );
  });

  it('APPROVAL_RESOLVED 常量与 StreamEvents 一致', () => {
    expect(APPROVAL_RESOLVED_EVENT_TYPE).toBe(StreamEvents.APPROVAL_RESOLVED);
    expect(APPROVAL_RESOLVED_EVENT_TYPE).toBe(
      'agent.stream.approval_resolved',
    );
  });
});

describe('ApprovalScopeSchema — v0.3 命名修订', () => {
  it('接受 once / thread / always', () => {
    expect(ApprovalScopeSchema.parse('once')).toBe('once');
    expect(ApprovalScopeSchema.parse('thread')).toBe('thread');
    expect(ApprovalScopeSchema.parse('always')).toBe('always');
  });

  it('拒绝旧命名 session（v0.3 改名为 thread）', () => {
    expect(() => ApprovalScopeSchema.parse('session')).toThrow();
  });
});

describe('RuntimeModeSchema — 四态（含 batch）', () => {
  it.each(['interactive', 'solo', 'scheduled', 'batch'])('接受 %s', (value) => {
    expect(RuntimeModeSchema.parse(value)).toBe(value);
  });

  it('拒绝未知 runtime_mode', () => {
    expect(() => RuntimeModeSchema.parse('offline')).toThrow();
  });
});

describe('ApprovalOutcomeSchema — 五态', () => {
  it.each([
    'allow',
    'deny',
    'cancelled',
    'expired',
    'cancelled_by_rollback',
  ])('接受 %s', (value) => {
    expect(ApprovalOutcomeSchema.parse(value)).toBe(value);
  });

  it('拒绝旧 allowed', () => {
    expect(() => ApprovalOutcomeSchema.parse('allowed')).toThrow();
  });
});

describe('DecisionReasonSchema — discriminated union', () => {
  it('plan_guard 分支合法（deny_code 取 plan_mode_write_forbidden 之一）', () => {
    const r = DecisionReasonSchema.parse({
      type: 'plan_guard',
      deny_code: 'plan_mode_write_forbidden',
      details: { foo: 'bar' },
    });
    expect(r.type).toBe('plan_guard');
  });

  it('plan_guard 分支拒绝旧 plan_exit_required（v0.4 W1.5 一刀切删除）', () => {
    expect(() =>
      DecisionReasonSchema.parse({
        type: 'plan_guard',
        deny_code: 'plan_exit_required',
        details: {},
      }),
    ).toThrow();
  });

  it('hardline_block 分支合法', () => {
    const r = DecisionReasonSchema.parse({
      type: 'hardline_block',
      pattern_name: 'rm -rf /',
      matched_text: 'rm -rf /',
    });
    expect(r.type).toBe('hardline_block');
  });

  it('operation_switch 分支合法（SwitchAction 三态）', () => {
    const r = DecisionReasonSchema.parse({
      type: 'operation_switch',
      switch_key: 'rm',
      switch_action: 'block',
    });
    expect(r.type).toBe('operation_switch');
  });

  it('memoized_thread 分支合法（v0.3 修订：session → thread）', () => {
    const r = DecisionReasonSchema.parse({
      type: 'memoized_thread',
      previous_reason: { type: 'user_interactive', scope: 'thread' },
    });
    expect(r.type).toBe('memoized_thread');
  });

  it('user_interactive 分支 scope 用新 thread 命名', () => {
    const r = DecisionReasonSchema.parse({
      type: 'user_interactive',
      scope: 'thread',
      rejection_message: 'user said no',
    });
    expect(r.type).toBe('user_interactive');
  });

  it('非法 type 拒绝（不在注册 tag 之一）', () => {
    expect(() =>
      DecisionReasonSchema.parse({
        type: 'memoized_session', // 旧命名 → 应拒绝
        previous_reason: null,
      }),
    ).toThrow();
  });

  // ── L-W6-16（2026-05-03 W6 M4）：W6 v3 judge 16 个新 type parse 契约锁定 ─────
  // SSoT: packages/security-policy/src/types-v3.ts DecisionReason union +
  //       packages/security-policy/src/judge.ts 实际 emit 字段。
  // 只要 judge 直接 emit 的 reason 对象能被本 schema parse 通过，
  // tool-orchestration 就不需要降级为 `{ type }` 强 cast。
  describe('W6 v3 judge 16 个新 type', () => {
    it('hardline_command 合法（pattern 字段必填）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'hardline_command',
        pattern: 'rm-rf-system-root',
      });
      expect(r.type).toBe('hardline_command');
    });

    it('hardline_path 合法（pattern 字段必填）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'hardline_path',
        pattern: 'system-etc-hosts',
      });
      expect(r.type).toBe('hardline_path');
    });

    it('sensitive_out_deny 合法（path + category）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'sensitive_out_deny',
        path: '/Users/me/.ssh/id_rsa',
        category: 'ssh',
      });
      expect(r.type).toBe('sensitive_out_deny');
      if (r.type === 'sensitive_out_deny') {
        expect(r.path).toBe('/Users/me/.ssh/id_rsa');
        expect(r.category).toBe('ssh');
      }
    });

    it('sensitive_in_ask 合法（path + category）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'sensitive_in_ask',
        path: '/Users/me/dev/project/.env',
        category: 'env',
      });
      expect(r.type).toBe('sensitive_in_ask');
    });

    it('memo_allow 合法（key + createdAt + specificity；camelCase createdAt 与 judge.ts emit 对齐）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'memo_allow',
        key: 'execute_command::rm:workspace-internal',
        createdAt: '2026-05-03T10:00:00Z',
        specificity: 'scoped',
      });
      expect(r.type).toBe('memo_allow');
      if (r.type === 'memo_allow') {
        expect(r.createdAt).toBe('2026-05-03T10:00:00Z');
        expect(r.specificity).toBe('scoped');
      }
    });

    it('memo_allow specificity 三态（exact / scoped / wildcard）均合法', () => {
      for (const spec of ['exact', 'scoped', 'wildcard'] as const) {
        const r = DecisionReasonSchema.parse({
          type: 'memo_allow',
          key: 'tool::subcmd:scope',
          createdAt: '2026-05-03T10:00:00Z',
          specificity: spec,
        });
        expect(r.type).toBe('memo_allow');
      }
    });

    it('memo_allow specificity 非法值拒绝（防止 drift）', () => {
      expect(() =>
        DecisionReasonSchema.parse({
          type: 'memo_allow',
          key: 'x',
          createdAt: '2026-05-03T10:00:00Z',
          specificity: 'partial', // 旧命名 / 非法
        }),
      ).toThrow();
    });

    it('memo_allow createdAt snake_case 形态（created_at）拒绝（字段名一字不差契约）', () => {
      // 这条锁定 "wire / judge / Python 镜像三端 camelCase 一致" 约定；
      // 若未来改回 snake_case 要同时更新 judge.ts + wire TS + Python + 三端 UI。
      expect(() =>
        DecisionReasonSchema.parse({
          type: 'memo_allow',
          key: 'x',
          created_at: '2026-05-03T10:00:00Z',
          specificity: 'exact',
        }),
      ).toThrow();
    });

    it('memo_deny 合法（key + createdAt + specificity）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'memo_deny',
        key: 'execute_command::git-push:*',
        createdAt: '2026-05-03T10:00:00Z',
        specificity: 'wildcard',
      });
      expect(r.type).toBe('memo_deny');
    });

    // M4.1 L-W6-24：scope_description 可选字段
    it('memo_allow 携带 scope_description 合法（L-W6-24 新增）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'memo_allow',
        key: 'execute_command::git-push:exact:a4f3b2c1',
        createdAt: '2026-05-03T10:00:00Z',
        specificity: 'exact',
        scope_description: '总是允许向远程仓库推送代码',
      });
      expect(r.type).toBe('memo_allow');
      if (r.type === 'memo_allow') {
        expect(r.scope_description).toBe('总是允许向远程仓库推送代码');
      }
    });

    it('memo_deny 携带 scope_description 合法（L-W6-24 新增）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'memo_deny',
        key: 'execute_command::rm:*',
        createdAt: '2026-05-03T10:00:00Z',
        specificity: 'wildcard',
        scope_description: '永不允许递归删除操作',
      });
      expect(r.type).toBe('memo_deny');
      if (r.type === 'memo_deny') {
        expect(r.scope_description).toBe('永不允许递归删除操作');
      }
    });

    it('memo_allow 不带 scope_description 仍合法（向后兼容）', () => {
      // 旧记忆条目无 scope_description，新 wire schema 应向后兼容
      const r = DecisionReasonSchema.parse({
        type: 'memo_allow',
        key: 'execute_command::npm:scoped:workspace',
        createdAt: '2026-05-02T08:00:00Z',
        specificity: 'scoped',
      });
      expect(r.type).toBe('memo_allow');
      if (r.type === 'memo_allow') {
        expect(r.scope_description).toBeUndefined();
      }
    });

    it('yolo_allow 合法（无附加字段）', () => {
      const r = DecisionReasonSchema.parse({ type: 'yolo_allow' });
      expect(r.type).toBe('yolo_allow');
    });

    it('workspace_in 合法（path + kind）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'workspace_in',
        path: '/Users/me/dev/project',
        kind: 'path',
      });
      expect(r.type).toBe('workspace_in');
      if (r.type === 'workspace_in') {
        expect(r.kind).toBe('path');
      }
    });

    it('workspace_out kind 两态（path / cwd）均合法', () => {
      for (const k of ['path', 'cwd'] as const) {
        const r = DecisionReasonSchema.parse({
          type: 'workspace_out',
          path: '/tmp/outside',
          kind: k,
        });
        expect(r.type).toBe('workspace_out');
      }
    });

    it('workspace_out kind 非法值拒绝（防止 drift）', () => {
      expect(() =>
        DecisionReasonSchema.parse({
          type: 'workspace_out',
          path: '/tmp/outside',
          kind: 'command', // 非法：只允许 path / cwd
        }),
      ).toThrow();
    });

    it('#985 destructive_in_workspace_ask 合法（path 必填）', () => {
      const r = DecisionReasonSchema.parse({
        type: 'destructive_in_workspace_ask',
        path: '/Users/me/dev/project/scratch.txt',
      });
      expect(r.type).toBe('destructive_in_workspace_ask');
      if (r.type === 'destructive_in_workspace_ask') {
        expect(r.path).toBe('/Users/me/dev/project/scratch.txt');
      }
    });

    it('#985 destructive_in_workspace_ask 缺 path 拒绝', () => {
      expect(() =>
        DecisionReasonSchema.parse({ type: 'destructive_in_workspace_ask' }),
      ).toThrow();
    });

    it('object_default_allow 合法', () => {
      const r = DecisionReasonSchema.parse({ type: 'object_default_allow' });
      expect(r.type).toBe('object_default_allow');
    });

    it('object_write_ask 合法', () => {
      const r = DecisionReasonSchema.parse({ type: 'object_write_ask' });
      expect(r.type).toBe('object_write_ask');
    });

    it('mcp_default_ask 合法（server 可选）', () => {
      const withServer = DecisionReasonSchema.parse({
        type: 'mcp_default_ask',
        server: 'stripe',
      });
      expect(withServer.type).toBe('mcp_default_ask');
      const withoutServer = DecisionReasonSchema.parse({
        type: 'mcp_default_ask',
      });
      expect(withoutServer.type).toBe('mcp_default_ask');
    });

    it('device_default_ask 合法（device_action 可选）', () => {
      const withAction = DecisionReasonSchema.parse({
        type: 'device_default_ask',
        device_action: 'screen_capture',
      });
      expect(withAction.type).toBe('device_default_ask');
      const withoutAction = DecisionReasonSchema.parse({
        type: 'device_default_ask',
      });
      expect(withoutAction.type).toBe('device_default_ask');
    });

    it('device_observe_allow 合法', () => {
      const r = DecisionReasonSchema.parse({ type: 'device_observe_allow' });
      expect(r.type).toBe('device_observe_allow');
    });

    it('plan_blocked 合法（mode 字段必填）', () => {
      const r = DecisionReasonSchema.parse({ type: 'plan_blocked', mode: 'plan' });
      expect(r.type).toBe('plan_blocked');
    });

    it('fallback_ask 合法（judge step 5 兜底）', () => {
      const r = DecisionReasonSchema.parse({ type: 'fallback_ask' });
      expect(r.type).toBe('fallback_ask');
    });
  });
});

// ─── ApprovalRequestedPayloadSchema · v0.4 batch 升格 ──────────────

describe('ApprovalRequestedPayloadSchema — batch 形态（v0.4）', () => {
  const baseActionRequest = {
    request_id: 'req-tool-1',
    tool_call_id: 'tc-1',
    tool_name: 'bash',
    tool_namespace: 'builtin',
    tool_input: { command: 'rm -rf build' },
    decision_reason: {
      type: 'operation_switch' as const,
      switch_key: 'rm',
      switch_action: 'confirm' as const,
    },
    allowed_scopes: ['once', 'thread', 'always'] as const,
    allowed_outcomes: ['allow', 'deny'] as const,
    risk_level: 'medium' as const,
  };

  const baseBatch = {
    batch_id: 'batch-1',
    approval_type: 'tool_permission' as const,
    action_requests: [baseActionRequest],
    runtime_mode: 'interactive' as const,
    expires_at: Date.now() + 60_000,
    schema_version: 1 as const,
  };

  it('最小必填字段通过（含 batch_id + action_requests[1]）', () => {
    const parsed = ApprovalRequestedPayloadSchema.parse(baseBatch);
    expect(parsed.batch_id).toBe('batch-1');
    expect(parsed.approval_type).toBe('tool_permission');
    expect(parsed.action_requests).toHaveLength(1);
    expect(parsed.action_requests[0].tool_name).toBe('bash');
  });

  it('多条 action_requests 合法（N=3 批量场景）', () => {
    const parsed = ApprovalRequestedPayloadSchema.parse({
      ...baseBatch,
      action_requests: [
        baseActionRequest,
        { ...baseActionRequest, request_id: 'req-2', tool_call_id: 'tc-2', tool_name: 'read_file' },
        { ...baseActionRequest, request_id: 'req-3', tool_call_id: 'tc-3', tool_name: 'list_directory' },
      ],
    });
    expect(parsed.action_requests).toHaveLength(3);
    expect(parsed.action_requests.map(a => a.tool_name)).toEqual([
      'bash', 'read_file', 'list_directory',
    ]);
  });

  it('action_requests 为空数组拒绝（min(1)）', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        action_requests: [],
      }),
    ).toThrow();
  });

  it('approval_type 只接受 tool_permission（v0.4 一刀切删除 plan_exit）', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        approval_type: 'plan_exit',
      }),
    ).toThrow();
  });

  it('带 ask_hint 通过（suggested_scope 用 thread 新命名）', () => {
    const parsed = ApprovalRequestedPayloadSchema.parse({
      ...baseBatch,
      action_requests: [{
        ...baseActionRequest,
        ask_hint: {
          summary: '即将删除构建产物',
          suggested_scope: 'thread' as const,
        },
      }],
    });
    expect(parsed.action_requests[0].ask_hint?.suggested_scope).toBe('thread');
  });

  it('roundtrip JSON stringify → parse 字段无丢失', () => {
    const parsed1 = ApprovalRequestedPayloadSchema.parse(baseBatch);
    const json = JSON.stringify(parsed1);
    const reparsed = ApprovalRequestedPayloadSchema.parse(JSON.parse(json));
    expect(reparsed.batch_id).toBe(parsed1.batch_id);
    expect(reparsed.action_requests[0].tool_input).toEqual(parsed1.action_requests[0].tool_input);
    expect(reparsed.action_requests[0].decision_reason).toEqual(parsed1.action_requests[0].decision_reason);
    expect(reparsed.action_requests[0].allowed_scopes).toEqual(parsed1.action_requests[0].allowed_scopes);
  });

  it('schema_version != 1 拒绝（防未来 bump 时错拿旧 payload）', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        schema_version: 2,
      }),
    ).toThrow();
  });

  it('空 batch_id 拒绝', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        batch_id: '',
      }),
    ).toThrow();
  });

  it('actionRequest 内 空 request_id 拒绝', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        action_requests: [{ ...baseActionRequest, request_id: '' }],
      }),
    ).toThrow();
  });

  it('actionRequest 内 空 tool_call_id 拒绝', () => {
    expect(() =>
      ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        action_requests: [{ ...baseActionRequest, tool_call_id: '' }],
      }),
    ).toThrow();
  });

  it('actionRequest risk_level wire 三态 + critical 归一为 high', () => {
    for (const lvl of ['low', 'medium', 'high'] as const) {
      const parsed = ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        action_requests: [{ ...baseActionRequest, risk_level: lvl }],
      });
      expect(parsed.action_requests[0].risk_level).toBe(lvl);
    }
    const criticalParsed = ApprovalRequestedPayloadSchema.parse({
      ...baseBatch,
      action_requests: [{ ...baseActionRequest, risk_level: 'critical' }],
    });
    expect(criticalParsed.action_requests[0].risk_level).toBe('high');
  });

  it('actionRequest risk_level 接受注册表 safe/review/strict 并归一为 wire', () => {
    const cases = [
      ['safe', 'low'],
      ['review', 'medium'],
      ['strict', 'high'],
    ] as const;
    for (const [input, expected] of cases) {
      const parsed = ApprovalRequestedPayloadSchema.parse({
        ...baseBatch,
        action_requests: [{ ...baseActionRequest, risk_level: input }],
      });
      expect(parsed.action_requests[0].risk_level).toBe(expected);
    }
  });

  it('passthrough — 未声明字段（未来扩展）保留', () => {
    const parsed = ApprovalRequestedPayloadSchema.parse({
      ...baseBatch,
      future_feature_x: 'y',
    });
    expect((parsed as Record<string, unknown>).future_feature_x).toBe('y');
  });
});

describe('W1.5 必填字段负测试 — 钉死 batch 契约意图', () => {
  const baseAr = {
    request_id: 'req-1',
    tool_call_id: 'tc-1',
    tool_name: 'bash',
    decision_reason: {
      type: 'hardline_confirm' as const,
      pattern_name: 'write .env',
      matched_text: '/app/.env',
    },
    allowed_scopes: ['once'] as const,
    allowed_outcomes: ['allow', 'deny'] as const,
    risk_level: 'medium' as const,
  };

  const valid = {
    batch_id: 'batch-1',
    approval_type: 'tool_permission' as const,
    action_requests: [baseAr],
    runtime_mode: 'interactive' as const,
    expires_at: 1700_000_000_000,
    schema_version: 1 as const,
  };

  it('缺 batch_id 被拒', () => {
    const { batch_id: _id, ...rest } = valid;
    void _id;
    expect(() => ApprovalRequestedPayloadSchema.parse(rest)).toThrow();
  });

  it('缺 action_requests 被拒', () => {
    const { action_requests: _ar, ...rest } = valid;
    void _ar;
    expect(() => ApprovalRequestedPayloadSchema.parse(rest)).toThrow();
  });

  it('actionRequest 内缺 decision_reason 被拒', () => {
    const { decision_reason: _dr, ...arRest } = baseAr;
    void _dr;
    expect(() => ApprovalRequestedPayloadSchema.parse({
      ...valid,
      action_requests: [arRest as Record<string, unknown>],
    })).toThrow();
  });

  it('actionRequest 内缺 allowed_scopes 被拒', () => {
    const { allowed_scopes: _as, ...arRest } = baseAr;
    void _as;
    expect(() => ApprovalRequestedPayloadSchema.parse({
      ...valid,
      action_requests: [arRest as Record<string, unknown>],
    })).toThrow();
  });

  it('actionRequest 内缺 allowed_outcomes 被拒', () => {
    const { allowed_outcomes: _ao, ...arRest } = baseAr;
    void _ao;
    expect(() => ApprovalRequestedPayloadSchema.parse({
      ...valid,
      action_requests: [arRest as Record<string, unknown>],
    })).toThrow();
  });

  it('actionRequest 内缺 risk_level 默认 medium（ 旧 payload 兼容）', () => {
    const { risk_level: _rl, ...arRest } = baseAr;
    void _rl;
    const parsed = ApprovalRequestedPayloadSchema.parse({
      ...valid,
      action_requests: [arRest as Record<string, unknown>],
    });
    expect(parsed.action_requests[0].risk_level).toBe('medium');
  });

  it('缺 runtime_mode 被拒', () => {
    const { runtime_mode: _rm, ...rest } = valid;
    void _rm;
    expect(() => ApprovalRequestedPayloadSchema.parse(rest)).toThrow();
  });

  it('缺 expires_at 被拒', () => {
    const { expires_at: _ex, ...rest } = valid;
    void _ex;
    expect(() => ApprovalRequestedPayloadSchema.parse(rest)).toThrow();
  });

  it('缺 schema_version 被拒（双端严格对齐）', () => {
    const { schema_version: _sv, ...rest } = valid;
    void _sv;
    expect(() => ApprovalRequestedPayloadSchema.parse(rest)).toThrow();
  });

  it('允许 actionRequest.allowed_scopes 为空数组（Solo 某些场景 runtime 可能无 scope 可选）', () => {
    const parsed = ApprovalRequestedPayloadSchema.parse({
      ...valid,
      action_requests: [{ ...baseAr, allowed_scopes: [] }],
    });
    expect(parsed.action_requests[0].allowed_scopes).toEqual([]);
  });

  it('ApprovalResolvedPayload 缺 schema_version 被拒', () => {
    expect(() =>
      ApprovalResolvedPayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [{
          request_id: 'r',
          tool_call_id: 't',
          outcome: 'allow',
        }],
      }),
    ).toThrow();
  });
});

describe('W1A-轮 2 Review · skill_context / batch_context / decision_reason 扩展', () => {
  const baseAr = {
    request_id: 'r',
    tool_call_id: 't',
    tool_name: 'pytest',
    decision_reason: {
      type: 'skill_trust_downgrade' as const,
      skill_id: 'sk-1',
      from_preset: 'collaborative',
      to_preset: 'cautious',
    },
    allowed_scopes: ['once'] as const,
    allowed_outcomes: ['allow', 'deny'] as const,
    risk_level: 'high' as const,
  };

  const baseReq = {
    batch_id: 'batch-1',
    approval_type: 'tool_permission' as const,
    action_requests: [baseAr],
    runtime_mode: 'interactive' as const,
    expires_at: 1700_000_000_000,
    schema_version: 1 as const,
  };

  it('actionRequest 携带 skill_context 合法', () => {
    const p = ApprovalRequestedPayloadSchema.parse({
      ...baseReq,
      action_requests: [{
        ...baseAr,
        skill_context: {
          skill_id: 'sk-marketplace-1',
          source: 'marketplace',
          permissions_approved: true,
        },
      }],
    });
    expect(p.action_requests[0].skill_context?.source).toBe('marketplace');
  });

  it('actionRequest 携带 batch_context 合法（passthrough）', () => {
    const p = ApprovalRequestedPayloadSchema.parse({
      ...baseReq,
      runtime_mode: 'batch',
      action_requests: [{
        ...baseAr,
        batch_context: {
          batch_id: 'batch-ai-fill-123',
          current_row_index: 1,
          total_count: 10000,
          memoization_hint: 'first_in_batch',
          future_m4b_field: { some: 'extension' },
        },
      }],
    });
    const ctx = p.action_requests[0].batch_context;
    expect(ctx?.batch_id).toBe('batch-ai-fill-123');
    expect(ctx?.memoization_hint).toBe('first_in_batch');
    // passthrough 子字段保留
    expect((ctx as Record<string, unknown>).future_m4b_field).toEqual({ some: 'extension' });
  });

  it('ApprovalResolvedPayload 携带 rollback_event_id 合法', () => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{
        request_id: 'r',
        tool_call_id: 't',
        outcome: 'cancelled_by_rollback',
      }],
      rollback_event_id: 'rb-evt-abc',
      schema_version: 1,
    });
    expect(p.rollback_event_id).toBe('rb-evt-abc');
  });

  it('DecisionReason 新增 rule_high_risk_allowlist_miss 分支合法', () => {
    const r = DecisionReasonSchema.parse({
      type: 'rule_high_risk_allowlist_miss',
      preset_name: 'cautious',
      risk_signal: 'allowlist_miss',
      matched_text: 'pytest && coverage report',
    });
    expect(r.type).toBe('rule_high_risk_allowlist_miss');
  });

  it('DecisionReason snake_case 对齐 — 旧 camelCase 字段被拒', () => {
    expect(() =>
      DecisionReasonSchema.parse({
        type: 'hardline_block',
        patternName: 'rm -rf /', // 旧 camelCase
        matchedText: 'rm -rf /',
      }),
    ).toThrow();

    // 新 snake_case 通过
    const r = DecisionReasonSchema.parse({
      type: 'hardline_block',
      pattern_name: 'rm -rf /',
      matched_text: 'rm -rf /',
    });
    expect(r.type).toBe('hardline_block');
  });
});

describe('ApprovalRequestedEventSchema — 整体 event shape', () => {
  it('type + payload 完整校验', () => {
    const event = ApprovalRequestedEventSchema.parse({
      type: 'agent.stream.approval_requested',
      payload: {
        batch_id: 'batch-1',
        approval_type: 'tool_permission',
        action_requests: [{
          request_id: 'req-1',
          tool_call_id: 'tc-1',
          tool_name: 'write_file',
          decision_reason: {
            type: 'hardline_confirm',
            pattern_name: 'write .env',
            matched_text: '/app/.env',
          },
          allowed_scopes: ['once', 'thread'],
          allowed_outcomes: ['allow', 'deny'],
          risk_level: 'high',
        }],
        runtime_mode: 'batch',
        expires_at: Date.now() + 60_000,
        schema_version: 1,
      },
    });
    expect(event.type).toBe(APPROVAL_REQUESTED_EVENT_TYPE);
  });

  it('type 字段字符串被严格校验', () => {
    expect(() =>
      ApprovalRequestedEventSchema.parse({
        type: 'agent.stream.review_required',
        payload: {},
      }),
    ).toThrow();
  });
});

// ─── ApprovalResolvedPayloadSchema · v0.4 batch 升格 ───────────────

describe('ApprovalResolvedPayloadSchema — batch 形态（v0.4）', () => {
  const baseDecision = {
    request_id: 'req-1',
    tool_call_id: 'tc-1',
    outcome: 'allow' as const,
  };

  it.each([
    'allow',
    'deny',
    'cancelled',
    'expired',
    'cancelled_by_rollback',
  ] as const)('outcome=%s 合法', (outcome) => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{ ...baseDecision, outcome }],
      schema_version: 1,
    });
    expect(p.decisions[0].outcome).toBe(outcome);
  });

  it('多条 decisions 合法（与 action_requests 顺序对齐）', () => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [
        baseDecision,
        { request_id: 'req-2', tool_call_id: 'tc-2', outcome: 'deny', rejection_message: 'no' },
        { request_id: 'req-3', tool_call_id: 'tc-3', outcome: 'allow', scope: 'thread' },
      ],
      schema_version: 1,
    });
    expect(p.decisions).toHaveLength(3);
    expect(p.decisions.map(d => d.outcome)).toEqual(['allow', 'deny', 'allow']);
  });

  it('decisions 为空数组拒绝（min(1)）', () => {
    expect(() =>
      ApprovalResolvedPayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [],
        schema_version: 1,
      }),
    ).toThrow();
  });

  it('allow 带 scope=thread 合法', () => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{ ...baseDecision, scope: 'thread' }],
      schema_version: 1,
    });
    expect(p.decisions[0].scope).toBe('thread');
  });

  it('deny 带 rejection_message 合法', () => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{ ...baseDecision, outcome: 'deny', rejection_message: 'not safe' }],
      schema_version: 1,
    });
    expect(p.decisions[0].rejection_message).toBe('not safe');
  });

  it('携带 approver_identity 合法', () => {
    const p = ApprovalResolvedPayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{
        ...baseDecision,
        scope: 'once',
        approver_identity: {
          user_id: 'u-1',
          client_info: 'Electron/0.1',
          timestamp: 1700_000_000_000,
        },
      }],
      schema_version: 1,
    });
    expect(p.decisions[0].approver_identity?.user_id).toBe('u-1');
  });

  it('roundtrip JSON 不丢字段', () => {
    const input = {
      batch_id: 'batch-r',
      decisions: [{
        request_id: 'req-r',
        tool_call_id: 'tc-r',
        outcome: 'cancelled_by_rollback' as const,
        scope: 'thread' as const,
        rejection_message: 'rollback to T-1',
        approver_identity: {
          user_id: 'sys',
          client_info: 'rollback-pipeline',
          timestamp: 1700_001_000_000,
        },
      }],
      schema_version: 1 as const,
    };
    const p = ApprovalResolvedPayloadSchema.parse(input);
    const json = JSON.stringify(p);
    const reparsed = ApprovalResolvedPayloadSchema.parse(JSON.parse(json));
    expect(reparsed).toEqual(p);
  });

  it('非法 outcome 拒绝', () => {
    expect(() =>
      ApprovalResolvedPayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [{ ...baseDecision, outcome: 'approved' }],
        schema_version: 1,
      }),
    ).toThrow();
  });

  it('decision 内 空 request_id 拒绝', () => {
    expect(() =>
      ApprovalResolvedPayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [{ ...baseDecision, request_id: '' }],
        schema_version: 1,
      }),
    ).toThrow();
  });

  it('空 batch_id 拒绝', () => {
    expect(() =>
      ApprovalResolvedPayloadSchema.parse({
        batch_id: '',
        decisions: [baseDecision],
        schema_version: 1,
      }),
    ).toThrow();
  });
});

describe('ApprovalResolvedEventSchema — 整体 event shape', () => {
  it('type 严格校验', () => {
    const event = ApprovalResolvedEventSchema.parse({
      type: 'agent.stream.approval_resolved',
      payload: {
        batch_id: 'batch-1',
        decisions: [{
          request_id: 'r',
          tool_call_id: 't',
          outcome: 'allow',
        }],
        schema_version: 1,
      },
    });
    expect(event.type).toBe(APPROVAL_RESOLVED_EVENT_TYPE);
  });

  it('错误 type 拒绝', () => {
    expect(() =>
      ApprovalResolvedEventSchema.parse({
        type: 'agent.stream.review_resolved',
        payload: {
          batch_id: 'batch-1',
          decisions: [{ request_id: 'r', tool_call_id: 't', outcome: 'allow' }],
          schema_version: 1,
        },
      }),
    ).toThrow();
  });
});

// ─── LocalRtUserResponsePayload · v0.4 batch 升格 ──────────────────

describe('LocalRtUserResponsePayloadSchema — batch 上行响应（v0.4）', () => {
  it('batch_id + decisions[1] 合法', () => {
    const p = LocalRtUserResponsePayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [{
        request_id: 'req-1',
        tool_call_id: 'tc-1',
        outcome: 'allow',
        scope: 'once',
      }],
    });
    expect(p.batch_id).toBe('batch-1');
    expect(p.decisions[0].outcome).toBe('allow');
  });

  it('多条 decisions 合法', () => {
    const p = LocalRtUserResponsePayloadSchema.parse({
      batch_id: 'batch-1',
      decisions: [
        { request_id: 'req-1', tool_call_id: 'tc-1', outcome: 'allow', scope: 'thread' },
        { request_id: 'req-2', tool_call_id: 'tc-2', outcome: 'deny', rejection_message: 'no' },
      ],
    });
    expect(p.decisions).toHaveLength(2);
  });

  it('decisions 仅接受 allow / deny（不接受 cancelled / expired —— 后者是服务端 outcome）', () => {
    expect(() =>
      LocalRtUserResponsePayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [{ request_id: 'r', tool_call_id: 't', outcome: 'cancelled' }],
      }),
    ).toThrow();
  });

  it('空 decisions 拒绝（min(1)）', () => {
    expect(() =>
      LocalRtUserResponsePayloadSchema.parse({
        batch_id: 'batch-1',
        decisions: [],
      }),
    ).toThrow();
  });

  it('空 batch_id 拒绝', () => {
    expect(() =>
      LocalRtUserResponsePayloadSchema.parse({
        batch_id: '',
        decisions: [{ request_id: 'r', tool_call_id: 't', outcome: 'allow' }],
      }),
    ).toThrow();
  });
});

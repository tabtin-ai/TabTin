/**
 * PR4-yolo Daemon 路径 wire 字段端到端覆盖（与 fix/yolo-daemon-wire-and-contextvar 配套）。
 *
 * 钉死 ``PromptForwardPayloadSchema`` 接受：
 *   - ``agent_mode: 'yolo'``（Task 2 wire 白名单 / Daemon resolveAgentMode）
 *   - ``is_group_space: boolean``（Task 1 / Task 4 H5 修复链路）
 *
 * 这是 Django Python 端 ``prompt_forward_service.forward_prompt`` 与 Daemon TS
 * 端 ``daemon.ts routeToLocalAgentHost`` 共享的合同——schema 拒掉这俩字段会
 * 直接让 daemon Zod ``safeParse`` 失败，整条 prompt.forward 静默 drop。
 */
import { describe, it, expect } from 'vitest';
import { PromptForwardPayloadSchema } from '@tabtin/agent-wire';

const BASE = {
  task_id: 'task-1',
  prompt: 'hello',
  attachments: [],
  agent_config: { type: 'claude-code' },
  workspace_id: 'workspace-1',
};

describe('PromptForwardPayloadSchema — execution workspace', () => {
  it('requires workspace_id for every executable prompt', () => {
    const { workspace_id: _workspaceId, ...withoutWorkspace } = BASE;
    expect(PromptForwardPayloadSchema.safeParse(withoutWorkspace).success).toBe(false);
  });
});

describe('PromptForwardPayloadSchema — structured /skill activation', () => {
  it('accepts a canonical skill key with optional args', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      skill_slash_invoke: {
        skill_key: 'app:office/meeting-notes',
        args: '整理今天的会议',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skill_slash_invoke?.skill_key).toBe('app:office/meeting-notes');
    }
  });
});

describe('PromptForwardPayloadSchema — authoritative run identity', () => {
  it('accepts a Django-issued UUID and rejects malformed run ids', () => {
    const runId = '5a4db13f-b50c-4b46-b031-358c04f64c42';
    const valid = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      run_id: runId,
    });
    expect(valid.success).toBe(true);
    if (valid.success) expect(valid.data.run_id).toBe(runId);

    expect(PromptForwardPayloadSchema.safeParse({
      ...BASE,
      run_id: 'runtime-local-id',
    }).success).toBe(false);
  });
});

describe('PromptForwardPayloadSchema — long-term free-text preferences', () => {
  it('preserves personal_rules and custom_rules as separate free-text fields', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      personal_rules: '个人：始终中文',
      custom_rules: 'Agent：始终英文',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.personal_rules).toBe('个人：始终中文');
      expect(result.data.custom_rules).toBe('Agent：始终英文');
    }
  });
});

describe('PromptForwardPayloadSchema — agent_mode=yolo', () => {
  it('accepts agent_mode="yolo" (PR4 Daemon 路径 wire)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      agent_mode: 'yolo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_mode).toBe('yolo');
    }
  });

  it('still accepts traditional modes', () => {
    for (const mode of ['agent', 'plan', 'ask', 'study', 'group']) {
      const result = PromptForwardPayloadSchema.safeParse({
        ...BASE,
        agent_mode: mode,
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('PromptForwardPayloadSchema — is_group_space', () => {
  it('accepts is_group_space=true (DR-15 互斥信号)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      is_group_space: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_group_space).toBe(true);
    }
  });

  it('accepts is_group_space=false (solo Space 显式信号，避免下游 fail-open)', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      is_group_space: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_group_space).toBe(false);
    }
  });

  it('rejects non-boolean is_group_space (e.g. string "true")', () => {
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      is_group_space: 'true' as any,
    });
    expect(result.success).toBe(false);
  });

  it('omits is_group_space when not present (optional · 向后兼容老 Django)', () => {
    const result = PromptForwardPayloadSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_group_space).toBeUndefined();
    }
  });
});

describe('PromptForwardPayloadSchema — working_dir_type (work_mode 数据源)', () => {
  // work_type 主线：Django prompt_forward_service 从 Agent.working_dir_type 写入
  // 此字段，daemon.ts 解出后透传到 buildSystemPrompt 的 `<work_mode>` 段。
  // schema 拒掉它 → 整条 prompt.forward safeParse 失败 / 字段被 strip →
  // `<work_mode>` 段对 Daemon 路径永远空转。
  it('accepts working_dir_type for code/doc/mixed', () => {
    for (const t of ['code', 'doc', 'mixed']) {
      const result = PromptForwardPayloadSchema.safeParse({
        ...BASE,
        working_dir_type: t,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.working_dir_type).toBe(t);
      }
    }
  });

  it('omits working_dir_type when not present (optional · 向后兼容老 Django)', () => {
    const result = PromptForwardPayloadSchema.safeParse(BASE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.working_dir_type).toBeUndefined();
    }
  });
});

describe('PromptForwardPayloadSchema — combined yolo + group_space', () => {
  it('shape valid even when group_space=true + yolo (PRD §1.4 由下游 build-policy 强制降级)', () => {
    // wire schema 不做语义校验（yolo + group_space 互斥逻辑落在 build-policy 内）—
    // 这里只验证 schema 接受这种组合，让下游有信号可读。
    const result = PromptForwardPayloadSchema.safeParse({
      ...BASE,
      agent_mode: 'yolo',
      is_group_space: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('PromptForwardPayloadSchema — agent mention priority', () => {
  it('accepts interrupt_active without changing legacy payloads', () => {
    expect(PromptForwardPayloadSchema.parse({
      ...BASE,
      interrupt_active: true,
    }).interrupt_active).toBe(true);
    expect(PromptForwardPayloadSchema.parse(BASE).interrupt_active).toBeUndefined();
  });
});

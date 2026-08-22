/**
 * Skill 权限边界：skill_create 在受限模式必须被拒，skill_invoke 可只读激活。
 *
 * 背景（总控 §7.5 灰色地带工具清单）：
 *   - `skill_create` 写入 Skill 文件，必须由受限模式拒绝
 *   - `skill_invoke` 只读取并注入 Skill 指令，后续实际工具独立判权
 *
 * 本测试守护两件事：
 *   1. `skill_create` 在 ask/plan/study 都按 default deny 路径走 → 软拒
 *   2. `skill_invoke` 在 ask/plan/study 按只读工具放行
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAgentModeToolAccess,
  isToolAllowedByPolicy,
  AGENT_MODE_CONFIGS,
} from '@tabtin/agent-modes';
import type { AgentModeName, ToolLike } from '@tabtin/agent-modes';

const RESTRICTED_MODES: AgentModeName[] = ['ask', 'plan', 'study'];

describe('Skill 在受限模式下的权限边界', () => {
  it('skill_create 不在 contract allow 列表（任何受限模式 isToolAllowedByPolicy false）', () => {
    // skill_create isReadOnly=false（实际工具实现 — 它写入 .tabtin/skills/ 文件）
    const tool: ToolLike = { name: 'skill_create', isReadOnly: false };
    for (const mode of RESTRICTED_MODES) {
      const policy = AGENT_MODE_CONFIGS[mode].toolPolicy;
      expect(
        isToolAllowedByPolicy(tool, policy),
        `${mode} mode should not allow skill_create`,
      ).toBe(false);
    }
  });

  for (const mode of RESTRICTED_MODES) {
    it(`${mode} mode → skill_create → deny mode_disallowed_tool`, () => {
      const result = evaluateAgentModeToolAccess({
        tool: { name: 'skill_create', isReadOnly: false },
        toolInput: { name: 'attack', script: 'rm -rf /' },
        agentMode: mode,
        sessionId: 'sess-1',
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.error.deny_code).toBe('mode_disallowed_tool');
        expect(result.error.error_kind).toBe('mode_restricted');
        expect(result.error.tool_name).toBe('skill_create');
        // P1-5 修复（2026-05-27）：plan / study 模式 remediation 改为
        // `use_plan_create`（引导先写 plan 文档，end turn 等用户点 PlanProposalCard
        // 执行），不再劝用户切 agent 模式。
        // F11 修复（2026-05-28）：ask 模式改为 `request_user_switch`，明确
        // "模型自己不能切，让用户在界面手动切"——switch_mode 工具在 ask 模式
        // contract 不可见，旧的 `switch_mode` action 会误导模型尝试调一个看不到的工具。
        const expectedAction =
          mode === 'ask' ? 'request_user_switch' : 'use_plan_create';
        expect(result.error.remediation.action).toBe(expectedAction);
      }
    });

    it(`${mode} mode → skill_invoke 只读入口 → allow`, () => {
      const result = evaluateAgentModeToolAccess({
        tool: { name: 'skill_invoke', isReadOnly: true },
        toolInput: { canonical_key: 'foo' },
        agentMode: mode,
        sessionId: 'sess-1',
      });
      expect(result.allowed).toBe(true);
    });
  }

  it('agent 模式 skill_create → allow（policy=all）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'skill_create', isReadOnly: false },
      toolInput: {},
      agentMode: 'agent',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(true);
  });
});

// ─── P1-5 修复（2026-05-27）：plan / study 模式 remediation 改为 use_plan_create ──
//
// **背景**：旧实现 plan 模式调 write_file 被拒时 remediation.action='switch_mode'
// + 'Ask the user to switch to agent mode' —— 模型按提示劝用户切 agent 模式，
// 违背 plan 模式产品意图（plan 的核心动作是先调 plan_create 落 TabDoc +
// PlanProposalCard，让用户点"执行"按钮自动切到 agent 执行，而不是让用户手动切）。
//
// 修法：plan / study 模式的 remediation 改为 `use_plan_create`；ask 模式
// 保留 `switch_mode`（合理：ask 是纯问答，写工具就是模式不对）。

describe('Phase 2 path-aware + P1-5 remediation', () => {
  it('plan 模式 write_file(.ts) 拒 → mode_disallowed_path + change_path/switch_mode', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: '/ws/a.ts', contents: '...' },
      agentMode: 'plan',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.deny_code).toBe('mode_disallowed_path');
      expect(['switch_mode', 'change_path']).toContain(result.error.remediation.action);
    }
  });

  it('plan 模式 write_file(.md) → allow（Phase 2 草稿路径）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: '/ws/draft.md', contents: '...' },
      agentMode: 'plan',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(true);
  });

  it('study 模式 write_file(.ts) 拒 → mode_disallowed_path', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: '/ws/a.ts', contents: '...' },
      agentMode: 'study',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.deny_code).toBe('mode_disallowed_path');
    }
  });

  // F11 修复（2026-05-28）：ask 模式 contract 不放行 switch_mode 工具，
  // remediation.action 改为 `request_user_switch`，不再让模型误以为可调
  // switch_mode（plan 模式专属工具），明确提示用户手动切换。
  it('ask 模式 write_file 拒 → remediation.action=request_user_switch（不暗示 switch_mode 可调）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: '/ws/a.ts', contents: '...' },
      agentMode: 'ask',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.remediation.action).toBe('request_user_switch');
      expect(result.error.remediation.target_mode_id).toBe('agent');
      // hint 必须明确"manually"且明示模型自己不能切
      expect(result.error.remediation.hint).toMatch(/manually|cannot switch/i);
      // hint 不应再写"ask them to switch" / "call switch_mode"等可能被模型
      // 误解为"调 switch_mode 工具"的措辞
      expect(result.error.remediation.hint).not.toMatch(/\bswitch_mode\b/);
    }
  });

  it('plan 模式 delete_file 仍得 use_plan_create；edit_file(.ts) 走 path deny', () => {
    const deleteResult = evaluateAgentModeToolAccess({
      tool: { name: 'delete_file', isReadOnly: false },
      toolInput: { path: '/ws/a.md' },
      agentMode: 'plan',
      sessionId: 'sess-1',
    });
    expect(deleteResult.allowed).toBe(false);
    if (!deleteResult.allowed) {
      expect(deleteResult.error.remediation.action).toBe('use_plan_create');
    }

    const editResult = evaluateAgentModeToolAccess({
      tool: { name: 'edit_file', isReadOnly: false },
      toolInput: { path: '/ws/a.ts' },
      agentMode: 'plan',
      sessionId: 'sess-1',
    });
    expect(editResult.allowed).toBe(false);
    if (!editResult.allowed) {
      expect(editResult.error.deny_code).toBe('mode_disallowed_path');
    }
  });
});

// ─── P1-6 修复（2026-05-27）：mode 白名单 vs target_check 顺序 ──
//
// **背景**：旧顺序 target_check 在所有受限模式下都先跑。一旦 ask 模式下
// 用户从 plan 切过来但 active plan 还没清掉，模型调
// `tabdoc_update_document(document_id=active_plan_id)` 会走 target check 直接
// allow——但 ask 模式 contract 明确 deny `tabdoc_update_document`！
//
// 修法：target check **仅在 plan / study 模式**才跑。其他受限模式（ask）下
// PLAN_TARGET_GUARDED_TOOLS 不享受豁免，必须通过 mode 白名单。

describe('P1-6: ask 模式 tabdoc_update_document 始终走 mode_disallowed_tool（不被 target_check 放行）', () => {
  // 用 mock tracker 模拟"ask 模式下还有残留 active plan"的场景（典型：
  // 用户从 plan 切到 ask，但 active-plan-tracker 没及时清）。
  const tracker = { getActivePlan: () => 'abc-plan-id' };

  it('ask 模式 + tabdoc_update_document(document_id=active_plan_id) → deny mode_disallowed_tool', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'tabdoc_update_document', isReadOnly: false },
      toolInput: { document_id: 'abc-plan-id' },
      agentMode: 'ask',
      sessionId: 'sess-1',
      activePlanTracker: tracker,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      // P1-6 关键断言：是 mode_disallowed_tool 而不是 wrong_target_document /
      // no_active_plan / allow——证明 mode 白名单先于 target_check 生效。
      expect(result.error.deny_code).toBe('mode_disallowed_tool');
      expect(result.error.tool_name).toBe('tabdoc_update_document');
    }
  });

  it('ask 模式 + tabdoc_replace_content → 同样走 mode_disallowed_tool', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'tabdoc_replace_content', isReadOnly: false },
      toolInput: { document_id: 'abc-plan-id', content: 'x' },
      agentMode: 'ask',
      sessionId: 'sess-1',
      activePlanTracker: tracker,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.deny_code).toBe('mode_disallowed_tool');
    }
  });

  it('plan 模式 + tabdoc_update_document(document_id=active_plan_id) → allow（合法 target_check 豁免保留）', () => {
    // P1-6 反面验证：plan 模式下 target_check 仍生效——保证合法的"模型先调
    // plan_create → 再调 tabdoc_update_document 改 active plan 草稿"流程不被
    // 误伤。
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'tabdoc_update_document', isReadOnly: false },
      toolInput: { document_id: 'abc-plan-id' },
      agentMode: 'plan',
      sessionId: 'sess-1',
      activePlanTracker: tracker,
    });
    expect(result.allowed).toBe(true);
  });

  it('plan 模式 + tabdoc_update_document(wrong id) → wrong_target_document（仍然 deny，但不是 mode_disallowed_tool）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: { name: 'tabdoc_update_document', isReadOnly: false },
      toolInput: { document_id: 'wrong-id' },
      agentMode: 'plan',
      sessionId: 'sess-1',
      activePlanTracker: tracker,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.error.deny_code).toBe('wrong_target_document');
    }
  });
});

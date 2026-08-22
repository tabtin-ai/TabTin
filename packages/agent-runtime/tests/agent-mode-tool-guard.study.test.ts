/**
 * D9 study 模式工具策略矩阵
 *
 * Study 模式跟随 plan 共享 agent-mode-tool-guard 主策略；差异：
 *   - `present_to_user` 显式 allow（plan 模式默认 isReadOnly=true 也走 default-allow）
 *   - 其余与 plan 一致：写工具拒、plan-family 允、MCP readonly 允
 *
 * 本测试集守护 filterToolsForMode 退化为 identity 后 study 不会被误伤。
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAgentModeToolAccess,
  AGENT_MODE_CONFIGS,
} from '@tabtin/agent-modes';
import type { ToolLike } from '@tabtin/agent-modes';

function makeTool(name: string, isReadOnly: boolean): ToolLike {
  return { name, isReadOnly };
}

describe('D9 Study 模式工具策略 · 跟随 plan + present_to_user 显式 allow', () => {
  it('study contract 显式 allow present_to_user（区别 plan / ask）', () => {
    const studyPolicy = AGENT_MODE_CONFIGS.study.toolPolicy;
    expect(studyPolicy.allowToolNames).toContain('present_to_user');
  });

  describe('与 plan 一致的拒绝项', () => {
    const writes = ['write_file', 'edit_file', 'delete_file', 'tabdoc_update_document', 'agent', 'skill_invoke'];
    for (const tool of writes) {
      it(`deny ${tool}`, () => {
        const result = evaluateAgentModeToolAccess({
          tool: makeTool(tool, false),
          toolInput: {},
          agentMode: 'study',
          sessionId: 'sess-1',
        });
        expect(result.allowed).toBe(false);
      });
    }
  });

  describe('与 plan 一致的放行项', () => {
    it('plan_create / plan_update_todos / todo 都放行', () => {
      for (const name of ['plan_create', 'plan_update_todos', 'todo']) {
        const result = evaluateAgentModeToolAccess({
          tool: makeTool(name, false),
          toolInput: {},
          agentMode: 'study',
          sessionId: 'sess-1',
        });
        expect(result.allowed, name).toBe(true);
      }
    });

    it('read-only 工具默认放行（read_file / web_search / parse_document）', () => {
      for (const name of ['read_file', 'web_search', 'parse_document']) {
        const result = evaluateAgentModeToolAccess({
          tool: makeTool(name, true),
          toolInput: {},
          agentMode: 'study',
          sessionId: 'sess-1',
        });
        expect(result.allowed, name).toBe(true);
      }
    });

    it('run_terminal_command 放行（contract allow + L16 input 级 allowlist）', () => {
      const result = evaluateAgentModeToolAccess({
        tool: makeTool('run_terminal_command', false),
        toolInput: { command: 'tabtin doc list' },
        agentMode: 'study',
        sessionId: 'sess-1',
      });
      expect(result.allowed).toBe(true);
    });
  });

  it('study mode 拒 mcp_call_tool 写工具，但放行 readonly mcp_*（D11）', () => {
    const writeMcp = evaluateAgentModeToolAccess({
      tool: makeTool('mcp_call_tool', false),
      toolInput: {},
      agentMode: 'study',
      sessionId: 'sess-1',
    });
    expect(writeMcp.allowed).toBe(false);

    const readonlyMcp = evaluateAgentModeToolAccess({
      tool: makeTool('mcp_search_docs', true),
      toolInput: {},
      agentMode: 'study',
      sessionId: 'sess-1',
    });
    expect(readonlyMcp.allowed).toBe(true);
  });

  it('study 模式 present_to_user 显式放行（不依赖 default-allow-read-only）', () => {
    // present_to_user 在生产工具实现 isReadOnly=true；这里测无论 isReadOnly 是
    // 什么值都允许（contract allowList 优先）
    for (const isReadOnly of [true, false]) {
      const result = evaluateAgentModeToolAccess({
        tool: { name: 'present_to_user', isReadOnly },
        toolInput: {},
        agentMode: 'study',
        sessionId: 'sess-1',
      });
      expect(result.allowed, `present_to_user isReadOnly=${isReadOnly}`).toBe(true);
    }
  });
});

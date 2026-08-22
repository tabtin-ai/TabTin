/**
 * D11 mcpReadOnlyOnly 三分支矩阵
 *
 * 验证 `evaluateAgentModeToolAccess` 在 ask / plan / study 模式下对 `mcp_*` 工具
 * 按 isReadOnly 做三分支决策（总控 §3 D11）：
 *
 *   - `mcp_*` + isReadOnly=true  → allow（mcpReadOnlyOnly 例外）
 *   - `mcp_*` + isReadOnly=false → deny（mode_disallowed_tool）
 *   - 非 mcp 工具 → 走常规 policy（与 mcp 字段无关）
 *
 * 这是 v3 决策落地的 P0 验收点 —— 不能把 readonly MCP 也一刀切拒
 * （会破坏用户的 MCP 集成工作流）。
 */

import { describe, it, expect } from 'vitest';
import { evaluateAgentModeToolAccess } from '@tabtin/agent-modes';
import type { AgentModeName, ToolLike } from '@tabtin/agent-modes';

function makeMcpTool(isReadOnly: boolean): ToolLike {
  // 实际生产环境的 mcp_call_tool 只有 isReadOnly=false 一个变体（见
  // ElectronToolProvider.adaptMcpTool）；本测试用 `mcp_search_docs` 等假名
  // 模拟"动态 MCP 工具被声明 readonly"的未来场景。
  return { name: 'mcp_search_docs', isReadOnly };
}

const RESTRICTED_MODES: AgentModeName[] = ['ask', 'plan', 'study'];

describe('D11 mcpReadOnlyOnly · 三分支矩阵', () => {
  for (const mode of RESTRICTED_MODES) {
    describe(`${mode} mode`, () => {
      it('mcp_* + isReadOnly=true → allow（mcpReadOnlyOnly 例外）', () => {
        const result = evaluateAgentModeToolAccess({
          tool: makeMcpTool(true),
          toolInput: { server: 's', tool: 'list' },
          agentMode: mode,
          sessionId: 'sess-1',
        });
        expect(result.allowed, `${mode} should allow readonly mcp`).toBe(true);
      });

      it('mcp_* + isReadOnly=false → deny mode_disallowed_tool', () => {
        const result = evaluateAgentModeToolAccess({
          tool: makeMcpTool(false),
          toolInput: { server: 's', tool: 'write' },
          agentMode: mode,
          sessionId: 'sess-1',
        });
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
          expect(result.error.deny_code).toBe('mode_disallowed_tool');
          expect(result.error.error_kind).toBe('mode_restricted');
          expect(result.error.tool_name).toBe('mcp_search_docs');
        }
      });

      it('mcp_call_tool（contract 显式 denyList，无视 isReadOnly）始终 deny', () => {
        // mcp_call_tool 在 contract denyToolNames 显式列出 → 即使理论上 isReadOnly=true
        // 也按 deny 走（denyToolNames 优先于 mcpReadOnlyOnly 例外）
        const result = evaluateAgentModeToolAccess({
          tool: { name: 'mcp_call_tool', isReadOnly: true } as ToolLike,
          toolInput: {},
          agentMode: mode,
          sessionId: 'sess-1',
        });
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
          expect(result.error.deny_code).toBe('mode_disallowed_tool');
        }
      });
    });
  }

  it('agent 模式：mcp_* + isReadOnly=false → allow（无 mcpReadOnlyOnly 限制）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: makeMcpTool(false),
      toolInput: {},
      agentMode: 'agent',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(true);
  });

  it('yolo 模式：mcp_* + isReadOnly=false → allow（继承 agent 工具集）', () => {
    const result = evaluateAgentModeToolAccess({
      tool: makeMcpTool(false),
      toolInput: {},
      agentMode: 'yolo',
      sessionId: 'sess-1',
    });
    expect(result.allowed).toBe(true);
  });
});

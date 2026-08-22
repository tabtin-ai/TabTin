/**
 * tool-orchestration-risk-level.test.ts —  orchestration 读 Tool.riskLevel 优先级。
 *
 * decidePermissionsBatch / decideAsksViaChannel 是模块私有函数；本测试锁定
 * 与 orchestration 同源的 `inferWireRiskLevelFromTool` 契约：Tool.riskLevel
 * 优先于 isReadOnly 启发式。
 *
 *  批次 13：原 `action-tools-adapter` 已删除（生产链路零消费——action-tools
 * 集成实际走 ShellCap / tabcode-adapter 直连 `@tabtin/action-tools`）。本测试改用
 * 内联 Tool fixture，风险等级覆盖不变。
 */

import { describe, it, expect } from 'vitest';
import { inferWireRiskLevelFromTool } from '../contracts/wire-risk.js';
import type {
  Tool,
  ToolResult,
} from '../contracts/tools.js';

/** 内联构造带 riskLevel / isReadOnly 组合的 Tool（替代已删除的 adaptActionTool）。 */
function makeTool(name: string, opts: { riskLevel?: Tool['riskLevel']; isReadOnly: boolean }): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    isReadOnly: opts.isReadOnly,
    riskLevel: opts.riskLevel,
    async execute(): Promise<ToolResult> {
      return { content: '{}', isError: false };
    },
  };
}

describe('tool-orchestration risk level — inferWireRiskLevelFromTool 与 Tool 字段', () => {
  it('strict 工具（如 agent）即使 isReadOnly=false 也应为 high', () => {
    const tool = makeTool('agent', { riskLevel: 'strict', isReadOnly: false });
    expect(tool.riskLevel).toBe('strict');
    expect(inferWireRiskLevelFromTool(tool)).toBe('high');
  });

  it('safe 工具 riskLevel 优先于 isReadOnly=false 误判', () => {
    const tool = makeTool('web_search', { riskLevel: 'safe', isReadOnly: true });
    expect(tool.isReadOnly).toBe(true);
    expect(inferWireRiskLevelFromTool(tool)).toBe('low');
  });

  it('review 工具 → medium（非旧 isReadOnly 硬编码）', () => {
    const tool = makeTool('write_file', { riskLevel: 'review', isReadOnly: false });
    expect(tool.isReadOnly).toBe(false);
    expect(inferWireRiskLevelFromTool(tool)).toBe('medium');
  });

  it('无 risk_level 字段时保持 isReadOnly 启发式（旧客户端兼容）', () => {
    const tool = makeTool('legacy_tool', { isReadOnly: false });
    expect(tool.riskLevel).toBeUndefined();
    expect(inferWireRiskLevelFromTool(tool)).toBe('medium');
  });
});

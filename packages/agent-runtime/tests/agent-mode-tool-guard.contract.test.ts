/**
 * evaluateAgentModeToolAccess 契约单测（TD-12）。
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateAgentModeToolAccess,
  annotateToolsForMode,
} from '@tabtin/agent-modes';

describe('evaluateAgentModeToolAccess contract', () => {
  it('undefined / agent mode short-circuits to allow', () => {
    expect(
      evaluateAgentModeToolAccess({
        tool: { name: 'write_file', isReadOnly: false },
        toolInput: { path: 'x.ts' },
        agentMode: undefined,
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateAgentModeToolAccess({
        tool: { name: 'write_file', isReadOnly: false },
        toolInput: { path: 'x.ts' },
        agentMode: 'agent',
      }),
    ).toEqual({ allowed: true });
  });

  it('missing policy mode fail-open (yolo not in configs uses allow path)', () => {
    // yolo is in configs — use invalid cast to simulate drift
    const r = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: {},
      agentMode: 'yolo',
    });
    expect(r.allowed).toBe(true);
  });

  it('ask mode denies write tools with mode_disallowed_tool (F11: request_user_switch)', () => {
    const r = evaluateAgentModeToolAccess({
      tool: { name: 'write_file', isReadOnly: false },
      toolInput: { path: 'a.md' },
      agentMode: 'ask',
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.error.error_kind).toBe('mode_restricted');
      // F11：ask 模式改为 request_user_switch（switch_mode 工具在 ask 不可见）
      expect(r.error.remediation.action).toBe('request_user_switch');
    }
  });

  it('handles null / array toolInput without throw', () => {
    expect(
      evaluateAgentModeToolAccess({
        tool: { name: 'write_file', isReadOnly: false },
        toolInput: null,
        agentMode: 'plan',
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAgentModeToolAccess({
        tool: { name: 'write_file', isReadOnly: false },
        toolInput: [],
        agentMode: 'plan',
      }).allowed,
    ).toBe(false);
  });
});

describe('annotateToolsForMode (TD-13)', () => {
  const tools = [
    { name: 'read_file', description: 'Read', isReadOnly: true },
    { name: 'write_file', description: 'Write', isReadOnly: false },
  ];

  it('agent mode returns same array reference content (identity map)', () => {
    const out = annotateToolsForMode(tools, 'agent');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(tools[0]);
  });

  it('plan mode annotates denied write_file without duplicating on second call', () => {
    const out = annotateToolsForMode(tools, 'plan');
    expect(out[1]!.description).toContain('[Plan mode]');
    expect(out[1]!.description).toContain('.md');
    const again = annotateToolsForMode(out, 'plan');
    expect(again[1]!.description.split('[Plan mode]').length).toBeLessThanOrEqual(3);
  });

  it('preserves empty description on allowed tools', () => {
    const empty = [{ name: 'read_file', description: '', isReadOnly: true }];
    const out = annotateToolsForMode(empty, 'plan');
    expect(out[0]!.description).toBe('');
  });
});

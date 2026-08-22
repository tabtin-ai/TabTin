/**
 * Tests for proxy-provider 出口防御纵深 — `sanitizeOpenAIMessageToolCalls`。
 *
 * **背景（dogfood P0 修复 2026-04-30）**：
 * 入口 `select-recent-history.ts:sanitizeHistoricalToolName` 已净化历史
 * ToolUseBlock.name；本测试验证 proxy-provider 出口的 OpenAI 格式
 * `tool_calls.function.name` 兜底净化逻辑——任何未走入口净化的路径
 * 仍能在出口被自动修复 + warning 提示开发者。
 *
 * 与入口 sanitize 对称的关键不变量：
 *   - 合规名（snake_case / dashes）原样不动
 *   - 不合规名（点号 / CJK / 空格）被 in-place sanitize
 *   - 已退休旧 FC 名收敛为 unknown_tool，不再喂回模型
 *   - 函数永不抛错（messages 是用户历史，不可控）
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sanitizeOpenAIMessageToolCalls,
  sanitizeToolPairing,
} from '../src/providers/proxy-provider.js';

// helper：构造一条 assistant + tool_calls 消息（OpenAI 格式 minimal）
function makeAssistantWithToolCall(callId: string, fnName: string): any {
  return {
    role: 'assistant',
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name: fnName, arguments: '{}' },
      },
    ],
  };
}

describe('sanitizeOpenAIMessageToolCalls — 出口防御纵深', () => {
  it('messages 全部合规：不修改、不 warning', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      makeAssistantWithToolCall('c1', 'tabdoc_create_document'),
      makeAssistantWithToolCall('c2', 'plan_update_todos'),
    ];
    const before = JSON.stringify(messages);
    const { sanitized, warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toEqual([]);
    expect(sanitized).toBe(messages); // in-place 同引用
    expect(JSON.stringify(messages)).toBe(before); // 内容未改
  });

  it('单条 tool_calls.function.name 含点号：自动 sanitize + 1 条 warning', () => {
    const messages = [
      makeAssistantWithToolCall('c1', 'plan.create'),
    ];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({ from: 'plan.create', to: 'plan_create' });
    // in-place 修改：messages 引用已被改
    expect(messages[0].tool_calls[0].function.name).toBe('plan_create');
    // tool_calls.id 不变（id 跟 name 解耦）
    expect(messages[0].tool_calls[0].id).toBe('c1');
  });

  it('退休旧名收敛为 unknown_tool', () => {
    const messages = [
      makeAssistantWithToolCall('c1', 'bash'),
      makeAssistantWithToolCall('c2', 'plan.exit'),
    ];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toEqual([
      { from: 'bash', to: 'unknown_tool' },
      { from: 'plan.exit', to: 'unknown_tool' },
    ]);
    expect(messages[0].tool_calls[0].function.name).toBe('unknown_tool');
    expect(messages[1].tool_calls[0].function.name).toBe('unknown_tool');
  });

  //  回归：在役工具名（tabcode 7 件套等）绝不允许被出口净化改写。
  // 历史事故：RETIRED_MESSAGE_TOOL_NAMES 误含 write_file/read_file/delete_file，
  // 模型历史里的成功调用被改写成 unknown_tool，kimi-k2.6 陷入「纠错→再调→
  // 又被改写」死循环（同 input write_file 11 连发，13 分钟烧到用户手动 abort）。
  it('在役工具名（write_file / read_file / delete_file）原样保留，不改写不告警', () => {
    const messages = [
      makeAssistantWithToolCall('c1', 'write_file'),
      makeAssistantWithToolCall('c2', 'read_file'),
      makeAssistantWithToolCall('c3', 'delete_file'),
    ];
    const before = JSON.stringify(messages);
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toEqual([]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('多条不合规：全部 sanitize、按数量 warning', () => {
    const messages = [
      makeAssistantWithToolCall('c1', 'plan.create'),
      makeAssistantWithToolCall('c2', 'tabdoc.update_document'),
      makeAssistantWithToolCall('c3', 'system.relaunch_app'),
    ];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.to)).toEqual([
      'plan_create',
      'tabdoc_update_document',
      'system_relaunch_app',
    ]);
    // 全部就地修复（与新工具名一致）
    expect(messages[0].tool_calls[0].function.name).toBe('plan_create');
    expect(messages[1].tool_calls[0].function.name).toBe('tabdoc_update_document');
    expect(messages[2].tool_calls[0].function.name).toBe('system_relaunch_app');
  });

  it('messages 为空 / null / undefined：不抛错、warnings 为空', () => {
    expect(sanitizeOpenAIMessageToolCalls([]).warnings).toEqual([]);
    expect(sanitizeOpenAIMessageToolCalls(null as any).warnings).toEqual([]);
    expect(sanitizeOpenAIMessageToolCalls(undefined as any).warnings).toEqual([]);
  });

  it('tool_calls 为 null / undefined / 非数组：跳过、不抛错', () => {
    const messages = [
      { role: 'user', content: 'plain user msg' },
      { role: 'assistant', content: 'no tools' }, // 无 tool_calls 字段
      { role: 'assistant', tool_calls: null },
      { role: 'assistant', tool_calls: undefined },
      { role: 'assistant', tool_calls: 'not-an-array' as any },
      { role: 'assistant', tool_calls: [] },
    ];
    expect(() => sanitizeOpenAIMessageToolCalls(messages)).not.toThrow();
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toEqual([]);
  });

  it('单 message 含多个 tool_calls：每个独立净化', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'plan.create', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'good_tool', arguments: '{}' } },
          { id: 'c3', type: 'function', function: { name: 'tabdoc.update_document', arguments: '{}' } },
        ],
      },
    ];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toHaveLength(2); // 只有 2 条不合规
    expect(messages[0].tool_calls[0].function.name).toBe('plan_create');
    expect(messages[0].tool_calls[1].function.name).toBe('good_tool'); // 合规不动
    expect(messages[0].tool_calls[2].function.name).toBe('tabdoc_update_document');
  });

  it('CJK / 空格 / 路径分隔符：全部归一为 _', () => {
    const messages = [
      makeAssistantWithToolCall('c1', '读取技能'),
      makeAssistantWithToolCall('c2', 'has space'),
      makeAssistantWithToolCall('c3', 'app/foo/bar'),
    ];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toHaveLength(3);
    // 全部满足上游正则
    const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
    for (const msg of messages) {
      expect(msg.tool_calls[0].function.name).toMatch(TOOL_NAME_RE);
    }
  });

  it('超长名（> 64 字符）：截断到 64', () => {
    const longName = 'x.'.repeat(40); // 长 80，且含点号
    const messages = [makeAssistantWithToolCall('c1', longName)];
    const { warnings } = sanitizeOpenAIMessageToolCalls(messages);
    expect(warnings).toHaveLength(1);
    expect(messages[0].tool_calls[0].function.name.length).toBe(64);
  });

  it('function.name 缺失或非字符串：跳过、不抛错', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c1', type: 'function', function: { arguments: '{}' } as any }, // 无 name
          { id: 'c2', type: 'function', function: { name: null, arguments: '{}' } as any },
          { id: 'c3', type: 'function', function: { name: 123, arguments: '{}' } as any },
          { id: 'c4', type: 'function', function: { name: '', arguments: '{}' } as any },
        ],
      },
    ];
    expect(() => sanitizeOpenAIMessageToolCalls(messages)).not.toThrow();
  });
});

describe('sanitizeToolPairing — OpenAI tool/result 顺序兜底', () => {
  it('丢弃非紧邻 assistant.tool_calls 的 orphan tool 消息', () => {
    const messages = [
      { role: 'assistant', content: 'plain' },
      { role: 'tool', tool_call_id: 'call_1', content: 'late result' },
      { role: 'user', content: 'next' },
    ];

    const sanitized = sanitizeToolPairing(messages as any);

    expect(sanitized).toEqual([
      { role: 'assistant', content: 'plain' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('保留紧跟在 assistant.tool_calls 后的合法 tool 结果', () => {
    const messages = [
      makeAssistantWithToolCall('call_1', 'good_tool'),
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'next' },
    ];

    const sanitized = sanitizeToolPairing(messages as any);

    expect(sanitized).toBe(messages);
  });

  it('移除没有紧邻 tool 结果响应的 assistant.tool_calls', () => {
    const messages = [
      makeAssistantWithToolCall('call_1', 'good_tool'),
      { role: 'user', content: 'next' },
    ];

    const sanitized = sanitizeToolPairing(messages as any);

    expect(sanitized).toEqual([
      { role: 'assistant', tool_calls: undefined, content: '' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('多 tool_calls 只保留已被紧邻 tool 结果响应的调用', () => {
    const messages = [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'tool_one', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'tool_two', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'next' },
    ];

    const sanitized = sanitizeToolPairing(messages as any);

    expect(sanitized).toEqual([
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'tool_one', arguments: '{}' } },
        ],
        content: '',
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'next' },
    ]);
  });
});

// ───  provider 出口 pairing 观测化兜底 ──────────────────────────

describe('sanitizeToolPairing — 修复发生时可观测', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('实际修了配对时打 console.warn，warn 内容带修复计数', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages = [
      makeAssistantWithToolCall('call_a', 'tool_one'),
      { role: 'user', content: 'next' },
      { role: 'tool', tool_call_id: 'call_ghost', content: 'orphan result' },
    ];

    sanitizeToolPairing(messages as any);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnText = String(warnSpy.mock.calls[0]![0]);
    expect(warnText).toContain('[proxy-provider] tool pairing repaired at provider boundary');
    expect(warnText).toContain('dropped 1 orphan tool message(s)');
    expect(warnText).toContain('1 orphan tool_calls entr(ies)');
  });

  it('配对已合法时不打 warn（正常路径零噪音）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages = [
      makeAssistantWithToolCall('call_b', 'tool_one'),
      { role: 'tool', tool_call_id: 'call_b', content: 'ok' },
      { role: 'user', content: 'next' },
    ];

    const sanitized = sanitizeToolPairing(messages as any);

    expect(sanitized).toBe(messages);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

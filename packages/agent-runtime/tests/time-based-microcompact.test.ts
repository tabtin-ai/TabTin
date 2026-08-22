/**
 * 连续对话成熟化 · 事 3 —— time-based microcompact 单元测试 + 端到端场景。
 *
 * 覆盖方案 §五 场景 2："两小时前的结果过期"：
 *   - 构造"assistant 调了工具、tool_result 写入时间很久以前"的历史
 *   - gap 超阈值触发 time-based
 *   - 断言 tool_result.content 被替换为 `[Old tool result content cleared]`
 *   - 断言 tool_use_id 保留、tool_use block 未被删
 *
 * 另外补单元测：
 *   - disabled / no_timestamp / below_threshold / no_compactable_tools 四种
 *     `reason` 的判定正确
 *   - keepRecent 语义（保留最近 N 个 compactable 不清）
 *   - 非白名单工具不被动
 *   - 幂等（已是占位字符串的 result 再跑一次不变）
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateTimeBasedTrigger,
  maybeTimeBasedMicrocompact,
  isCompactableTool,
  COMPACTABLE_TOOLS_DEFAULT,
  DEFAULT_TIME_BASED_MC_CONFIG,
  TIME_BASED_MC_CLEARED_MESSAGE,
  inferLastAssistantTimestamp,
} from '../src/compact/time-based-microcompact.js';
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeAsstWithToolUse(id: string, name: string, text = 'calling'): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_use', id, name, input: {} },
    ],
  };
}

function makeUserWithToolResult(id: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  };
}

// ─── 1. isCompactableTool / SSoT ─────────────────────────────────────

describe('事 3 · COMPACTABLE_TOOLS SSoT 对齐', () => {
  it('本地白名单包含全部 20+ 项（不是旧的 9 项）', () => {
    // 关键项都在：与云端对齐，这是 SSoT 的可验证标志
    const required = [
      'file_read', 'file_edit', 'file_write',
      'execute_in_terminal', 'ssh_execute',
      'document_read', 'parse_document', 'code_grep', 'code_glob', 'request_snapshot',
      // 新加的 12+ 项
      'read_file', 'Read', 'FileRead', 'ReadFile',
      'shell', 'bash', 'terminal', 'Shell', 'execute_command', 'run_terminal_command', 'Bash',
      'grep', 'Grep', 'search', 'glob', 'Glob', 'find', 'SemanticSearch',
      'grep_search', 'glob_search',
      'web_search', 'web_fetch', 'WebSearch', 'WebFetch',
      'edit_file', 'write_file', 'Edit', 'Write', 'FileEdit', 'FileWrite',
      'rag_search', 'memory_search', 'list_conversations', 'read_conversation',
      'credential_lookup',
    ];
    for (const tool of required) {
      expect(COMPACTABLE_TOOLS_DEFAULT.has(tool)).toBe(true);
    }
    // 总项数至少 20（避免回归到 9）
    expect(COMPACTABLE_TOOLS_DEFAULT.size).toBeGreaterThanOrEqual(20);
  });

  it('前缀匹配 web_scraper_* 家族（含旧点号 / 连字符兜底）', () => {
    // 新名（snake_case，dogfood P0 改名后唯一规范形式）
    expect(isCompactableTool('web_scraper_scrape_url')).toBe(true);
    expect(isCompactableTool('web_scraper_extract_fields')).toBe(true);
    // 旧名兜底（防御纵深 —— 老 session 历史 sanitize 前可能出现）
    expect(isCompactableTool('web_scraper.crawl')).toBe(true);
    expect(isCompactableTool('web-scraper.fetch')).toBe(true);
    expect(isCompactableTool('Web_Scraper.misc')).toBe(true); // 大小写不敏感
  });

  it('非白名单工具（todo / Task）不是 compactable', () => {
    expect(isCompactableTool('todo')).toBe(false);
    expect(isCompactableTool('Task')).toBe(false);
    expect(isCompactableTool('agent')).toBe(false);
    expect(isCompactableTool('')).toBe(false);
  });
});

// ─── 2. evaluateTimeBasedTrigger ─────────────────────────────────────

describe('事 3 · evaluateTimeBasedTrigger reason 分支', () => {
  const baseMessages: Message[] = [
    { role: 'user', content: 'hi' },
    makeAsstWithToolUse('t1', 'file_read'),
    makeUserWithToolResult('t1', 'data'),
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];

  it('disabled: enabled=false → reason=disabled，不触发', () => {
    const r = evaluateTimeBasedTrigger({
      messages: baseMessages,
      config: { enabled: false, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: Date.now() - 10 * 60_000,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('no_timestamp: enabled 但无 lastAssistantTimestamp → 不触发（保守默认）', () => {
    const r = evaluateTimeBasedTrigger({
      messages: baseMessages,
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: undefined,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('no_timestamp');
  });

  it('below_threshold: gap 小于阈值 → reason=below_threshold', () => {
    const now = 1_700_000_000_000;
    const r = evaluateTimeBasedTrigger({
      messages: baseMessages,
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: now - 10 * 60_000, // 10 分钟 < 30
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.gapMinutes).toBeCloseTo(10, 1);
  });

  it('no_compactable_tools: 消息里没 tool_result → reason=no_compactable_tools', () => {
    const now = 1_700_000_000_000;
    const r = evaluateTimeBasedTrigger({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: now - 60 * 60_000, // 60 分钟 > 30
      now,
    });
    expect(r.triggered).toBe(false);
    expect(r.reason).toBe('no_compactable_tools');
  });

  it('triggered: 全部条件满足 → reason=triggered', () => {
    const now = 1_700_000_000_000;
    const r = evaluateTimeBasedTrigger({
      messages: baseMessages,
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: now - 2 * 60 * 60_000, // 2 小时
      now,
    });
    expect(r.triggered).toBe(true);
    expect(r.reason).toBe('triggered');
    expect(r.gapMinutes).toBeCloseTo(120, 1);
  });
});

// ─── 3. maybeTimeBasedMicrocompact — 核心语义 ────────────────────────

describe('事 3 · maybeTimeBasedMicrocompact — 方案场景 2 端到端', () => {
  it('两小时前的 tool_result content 被替换，tool_use_id 保留，tool_use block 未删', () => {
    const now = 1_700_000_000_000;
    const twoHoursAgo = now - 2 * 60 * 60_000;

    const messages: Message[] = [
      { role: 'user', content: '帮我查天气' },
      makeAsstWithToolUse('tool_weather_1', 'web_search', '调用天气 API'),
      makeUserWithToolResult('tool_weather_1', '北京 25°C 晴天（两小时前查询）'),
      { role: 'assistant', content: [{ type: 'text', text: '北京今天 25°C' }] },
    ];

    const result = maybeTimeBasedMicrocompact(messages, {
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 0 },
      lastAssistantTimestamp: twoHoursAgo,
      now,
    });

    expect(result.triggered).toBe(true);
    expect(result.clearedCount).toBe(1);
    expect(result.gapMinutes).toBeCloseTo(120, 1);

    // 验证 tool_result content 被替换
    const userWithResult = result.messages[2];
    expect(typeof userWithResult.content).not.toBe('string');
    const resultBlock = (userWithResult.content as Array<ToolResultBlock>)[0];
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.tool_use_id).toBe('tool_weather_1'); // ✓ id 保留
    expect(resultBlock.content).toBe(TIME_BASED_MC_CLEARED_MESSAGE); // ✓ content 替换

    // 验证 tool_use block 完全不动
    const asstWithUse = result.messages[1];
    const blocks = asstWithUse.content as Array<ToolUseBlock | { type: 'text'; text: string }>;
    const toolUse = blocks.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect(toolUse).toBeDefined();
    expect(toolUse.id).toBe('tool_weather_1');
    expect(toolUse.name).toBe('web_search');
  });

  it('keepRecent 语义：保留最近 N 条 compactable 不清', () => {
    const now = 1_700_000_000_000;
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'file_read'),
      makeUserWithToolResult('t1', 'old-1'),
      makeAsstWithToolUse('t2', 'file_read'),
      makeUserWithToolResult('t2', 'old-2'),
      makeAsstWithToolUse('t3', 'file_read'),
      makeUserWithToolResult('t3', 'recent-1'),
      makeAsstWithToolUse('t4', 'file_read'),
      makeUserWithToolResult('t4', 'recent-2'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const result = maybeTimeBasedMicrocompact(messages, {
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 2 },
      lastAssistantTimestamp: now - 60 * 60_000,
      now,
    });

    // 4 条 compactable - keepRecent(2) = 2 条被清
    expect(result.clearedCount).toBe(2);
    const getResultContent = (idx: number) => {
      const blocks = result.messages[idx].content as Array<ToolResultBlock>;
      return blocks[0].content;
    };
    expect(getResultContent(2)).toBe(TIME_BASED_MC_CLEARED_MESSAGE); // t1 清
    expect(getResultContent(4)).toBe(TIME_BASED_MC_CLEARED_MESSAGE); // t2 清
    expect(getResultContent(6)).toBe('recent-1'); // t3 保留
    expect(getResultContent(8)).toBe('recent-2'); // t4 保留
  });

  it('非白名单工具永不被清，即使 gap 很大', () => {
    const now = 1_700_000_000_000;
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'todo'), // 非白名单
      makeUserWithToolResult('t1', 'todo list'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const result = maybeTimeBasedMicrocompact(messages, {
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 0 },
      lastAssistantTimestamp: now - 10 * 60 * 60_000, // 10 小时，极大 gap
      now,
    });

    // trigger 仍然 evaluate=true，但 no compactable tool → clearedCount=0
    expect(result.clearedCount).toBe(0);
    const blocks = result.messages[2].content as Array<ToolResultBlock>;
    expect(blocks[0].content).toBe('todo list'); // 原样保留
  });

  it('幂等：已是占位字符串的 result 再跑一次不重复改', () => {
    const now = 1_700_000_000_000;
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'file_read'),
      makeUserWithToolResult('t1', TIME_BASED_MC_CLEARED_MESSAGE),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const result = maybeTimeBasedMicrocompact(messages, {
      config: { enabled: true, gapThresholdMinutes: 30, keepRecent: 0 },
      lastAssistantTimestamp: now - 60 * 60_000,
      now,
    });

    // triggered=true 但 clearedCount=0（因为已是 cleared 字符串）
    expect(result.triggered).toBe(true);
    expect(result.clearedCount).toBe(0);
    // 内容不变（引用等价——未 mutate）
    expect(result.messages[2]).toBe(messages[2]);
  });

  it('disabled 配置：不触发、不改动消息', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'file_read'),
      makeUserWithToolResult('t1', 'data'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const result = maybeTimeBasedMicrocompact(messages, {
      config: { enabled: false, gapThresholdMinutes: 30, keepRecent: 0 },
      lastAssistantTimestamp: Date.now() - 60 * 60_000,
    });

    expect(result.triggered).toBe(false);
    expect(result.clearedCount).toBe(0);
    expect(result.messages).toBe(messages); // 同引用
  });
});

// ─── 4. inferLastAssistantTimestamp ──────────────────────────────────

describe('事 3 · inferLastAssistantTimestamp 兜底', () => {
  it('消息没带 timestamp 字段 → 返回 undefined', () => {
    const ts = inferLastAssistantTimestamp([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
    expect(ts).toBeUndefined();
  });

  it('消息 duck-typed 挂了 _timestamp → 返回它', () => {
    const msg: Message & { _timestamp?: number } = {
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
      _timestamp: 1_700_000_000_000,
    };
    const ts = inferLastAssistantTimestamp([
      { role: 'user', content: 'q' },
      msg,
    ]);
    expect(ts).toBe(1_700_000_000_000);
  });
});

// ─── 5. 默认配置合理性 ───────────────────────────────────────────────

describe('事 3 · DEFAULT_TIME_BASED_MC_CONFIG 语义', () => {
  it('默认 enabled=false（保守 opt-in）', () => {
    expect(DEFAULT_TIME_BASED_MC_CONFIG.enabled).toBe(false);
  });

  it('默认 gapThresholdMinutes 在 [10, 60] 合理区间', () => {
    const v = DEFAULT_TIME_BASED_MC_CONFIG.gapThresholdMinutes;
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(60);
  });

  it('默认 keepRecent 与云端 DEFAULT_KEEP_RECENT=4 对齐', () => {
    expect(DEFAULT_TIME_BASED_MC_CONFIG.keepRecent).toBe(4);
  });
});

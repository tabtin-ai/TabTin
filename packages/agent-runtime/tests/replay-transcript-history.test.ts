import { describe, expect, it } from 'vitest';

import type {
  ContentBlock,
  Message,
} from '../src/engine/contracts/conversation.js';
import type { RuntimeHistoryMessage } from '../src/history/types.js';
import { estimateTokens } from '../src/compact/index.js';
import { buildReplayHistoryFromTranscript } from '../src/history/replay-transcript-history.js';

/**
 * W6 transcript 全量重放纯函数单测。
 *
 * 复刻 dogfood session a3e5dba6 的真实退化现场：旧「从 UI 投影重建」路径会把
 * 第一条 assistant 的 tool_use 压成 `[工具调用]` 占位文字（338→387 退化），并在
 * 跨轮产生孤儿 tool_result。transcript 重放以 messages.jsonl 结构为权威，应保留
 * tool_use↔tool_result 配对、不退化、不产生孤儿。
 */

function assistantBlocks(msg: RuntimeHistoryMessage): ContentBlock[] {
  expect(Array.isArray(msg.content)).toBe(true);
  return msg.content as ContentBlock[];
}

function blockTypes(msg: RuntimeHistoryMessage): string[] {
  return assistantBlocks(msg).map((b) => b.type);
}

describe('buildReplayHistoryFromTranscript', () => {
  it('空 transcript → 空 history', () => {
    expect(buildReplayHistoryFromTranscript([])).toEqual([]);
  });

  it('#11022 丢掉续跑落盘的空 user 文本块，保留相邻真 user', () => {
    const history = buildReplayHistoryFromTranscript([
      { role: 'user', content: '通过网络搜索整理下未来七天上海的天气预报' },
      { role: 'assistant', content: [{ type: 'text', text: '[LLM_ERROR] 网络连接不稳定' }] },
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: '[LLM_RATE_LIMIT] 服务繁忙' }] },
      { role: 'user', content: '看下是什么' },
    ]);

    expect(history).toEqual([
      { role: 'user', content: '通过网络搜索整理下未来七天上海的天气预报' },
      { role: 'assistant', content: [{ type: 'text', text: '[LLM_ERROR] 网络连接不稳定' }] },
      { role: 'assistant', content: [{ type: 'text', text: '[LLM_RATE_LIMIT] 服务繁忙' }] },
      { role: 'user', content: '看下是什么' },
    ]);
  });

  it('正：保留 tool_use 结构，不退化成 [工具调用] 占位文字', () => {
    // T1 现场：user → assistant(thinking+tool_use) → user(tool_result) → assistant(总结)
    const transcript: Message[] = [
      { role: 'user', content: '打开小红书' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '打开浏览器' },
          { type: 'tool_use', id: 'run_terminal_command_0', name: 'run_terminal_command', input: { command: 'tabtin browser open https://www.xiaohongshu.com' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'run_terminal_command_0', content: '{"exit_code":1}' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '收尾' },
          { type: 'text', text: '已为你打开 **小红书** 🎉' },
        ],
      },
    ];

    const history = buildReplayHistoryFromTranscript(transcript);

    // #1 user 文本
    expect(history[0]).toEqual({ role: 'user', content: '打开小红书' });
    // #2 assistant 保留 tool_use（thinking 被丢），不退化
    expect(blockTypes(history[1]!)).toEqual(['tool_use']);
    const toolUse = assistantBlocks(history[1]!)[0] as Extract<ContentBlock, { type: 'tool_use' }>;
    expect(toolUse.id).toBe('run_terminal_command_0');
    expect(toolUse.name).toBe('run_terminal_command');
    // #3 user tool_result 配对保留
    expect(blockTypes(history[2]!)).toEqual(['tool_result']);
    // #4 assistant 文本总结保留（thinking 丢）
    expect(blockTypes(history[3]!)).toEqual(['text']);
  });

  it('正：thinking 块一律丢弃', () => {
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    expect(blockTypes(history[0]!)).toEqual(['text']);
  });

  it('反：纯 thinking 的 assistant → 整条丢弃（不留空消息）', () => {
    const transcript: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    expect(history).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('正：tool_result 保留 raw（不再被 projection 改写， ②）', () => {
    const raw = 'RAW STDOUT '.repeat(50);
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc_1', name: 'run_terminal_command', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: raw },
        ],
      },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    const tr = assistantBlocks(history[1]!)[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.tool_use_id).toBe('tc_1');
    expect(tr.content).toBe(raw);
  });

  it('正：run_terminal_command tool_result 保留 raw（不再占位/摘要）', () => {
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc_2', name: 'run_terminal_command', input: { command: 'echo hi' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_2', content: 'REAL STDOUT hi' },
        ],
      },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    const tr = assistantBlocks(history[1]!)[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.content).toBe('REAL STDOUT hi');
    expect(tr.content as string).not.toContain('Tool Projection');
  });

  it('正：超长 raw tool_result 不在重放层截断（storage 50K 截断兜底）', () => {
    const big = 'x'.repeat(8000);
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'wf_1', name: 'write_file', input: { path: 'a.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'wf_1', content: big },
        ],
      },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    const tr = assistantBlocks(history[1]!)[0] as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.content).toBe(big);
  });

  it('反：assistant tool_use 缺配对 tool_result → 整条丢弃（不产生孤儿）', () => {
    const transcript: Message[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'orphan_1', name: 'run_terminal_command', input: {} },
        ],
      },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    // 半拉子 assistant 被 filterUnresolvedToolUses 丢弃
    expect(history).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('正：历史 environment context调到 user 之前，与 live [ctx,user] 顺序一致', () => {
    // transcript 落盘顺序是 [user, ctx]（recordUserMessage 在 query 前、env context
    // 在 query 中）；replay 应交换回 [ctx, user]，与 live 注入顺序一致以保 prompt cache。
    const envText = '<context type="environment">\ncurrent_datetime: 2026-06-30 14:00\nfocused: 文档X\n</context>';
    const transcript: Message[] = [
      { role: 'user', content: '打开小红书' },
      { role: 'user', content: envText },
      { role: 'assistant', content: [{ type: 'text', text: '已打开' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    // 顺序交换：env context 在前，真 user 在后
    expect(history[0]).toEqual({ role: 'user', content: envText });
    expect(history[1]).toEqual({ role: 'user', content: '打开小红书' });
    expect(blockTypes(history[2]!)).toEqual(['text']);
  });

  it('正：block 数组形态的 user 消息折回 string（，与 live 结构一致）', () => {
    // restoreMessages 把 user 重建成 [{type:text}] 数组；replay 应折回 string，
    // 与 live 的 string content 字节一致（否则一轮 string 一轮 json 破 cache）。
    const transcript: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '现在的页面是什么' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 't' }, { type: 'text', text: '答' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    expect(history[0]).toEqual({ role: 'user', content: '现在的页面是什么' });
  });

  it('反：含 tool_result 的 user 消息保持 block 数组（不能折成 string）', () => {
    const transcript: Message[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tc', name: 'run_terminal_command', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc', content: 'ok' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    expect(Array.isArray(history[1]!.content)).toBe(true);
    expect((history[1]!.content as ContentBlock[])[0]!.type).toBe('tool_result');
  });

  it('正：多轮各自的 [user,ctx] 都被交换成 [ctx,user]', () => {
    const ctx1 = '<context type="environment">\nfocused: A\n</context>';
    const ctx2 = '<context type="environment">\nfocused: B\n</context>';
    const transcript: Message[] = [
      { role: 'user', content: 'q1' },
      { role: 'user', content: ctx1 },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
      { role: 'user', content: ctx2 },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    expect(history.map((m) => (typeof m.content === 'string' ? m.content : '[blocks]'))).toEqual([
      ctx1, 'q1', '[blocks]', ctx2, 'q2', '[blocks]',
    ]);
  });

  it('正：多轮交替全程结构守恒（复刻 T1→T3 链路）', () => {
    const transcript: Message[] = [
      { role: 'user', content: '打开小红书' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'run_terminal_command', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: '已打开' }] },
      { role: 'user', content: '页面上有什么内容' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run_terminal_command', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'md' }] },
      { role: 'assistant', content: [{ type: 'text', text: '页面内容...' }] },
    ];
    const history = buildReplayHistoryFromTranscript(transcript);
    // 8 条结构全保留，无合并、无丢弃
    expect(history.length).toBe(8);
    expect(history.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
  });

  it('反：UI 富内容产物不进入模型重放历史', () => {
    const transcript: Message[] = [
      { role: 'user', content: '把页面保存成本地文件' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '已保存到本地文件' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tabtin_rich_content',
            kind: 'file',
            summary: 'Claude (AI) - Wikipedia 页面内容',
            payload: {
              artifact_kind: 'local_file',
              relative_path: 'Claude_AI_Wikipedia.md',
              filename: 'Claude_AI_Wikipedia.md',
            },
          } as unknown as ContentBlock,
        ],
      },
    ];

    const history = buildReplayHistoryFromTranscript(transcript);

    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: '把页面保存成本地文件' });
    expect(blockTypes(history[1]!)).toEqual(['text']);
    expect(() => estimateTokens(history as Message[])).not.toThrow();
  });

  it('正：同一 assistant 消息内只过滤 UI 富内容，保留文本', () => {
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '文件已生成' },
          {
            type: 'tabtin_rich_content',
            kind: 'file',
            summary: '文件卡片',
            payload: { relative_path: 'result.md' },
          } as unknown as ContentBlock,
        ],
      },
    ];

    const history = buildReplayHistoryFromTranscript(transcript);

    expect(history).toHaveLength(1);
    expect(blockTypes(history[0]!)).toEqual(['text']);
    expect(() => estimateTokens(history as Message[])).not.toThrow();
  });

  it('正：嵌套 tool_result.content 内过滤 UI 富内容，保留模型可见文本', () => {
    const transcript: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'open_file:1', name: 'open_file', input: { relative_path: 'result.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'open_file:1',
            content: [
              { type: 'text', text: 'opened result.md' },
              {
                type: 'tabtin_rich_content',
                kind: 'file',
                summary: '文件卡片',
                payload: { relative_path: 'result.md' },
              } as unknown as ContentBlock,
            ],
          },
        ],
      },
    ];

    const history = buildReplayHistoryFromTranscript(transcript);
    const resultBlock = assistantBlocks(history[1]!)[0] as Extract<ContentBlock, { type: 'tool_result' }>;

    expect(Array.isArray(resultBlock.content)).toBe(true);
    expect((resultBlock.content as ContentBlock[]).map((block) => block.type)).toEqual(['text']);
    expect(() => estimateTokens(history as Message[])).not.toThrow();
  });
});

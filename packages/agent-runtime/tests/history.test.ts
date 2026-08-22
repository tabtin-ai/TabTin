/**
 * @tabtin/agent-runtime/history — 独立单测。
 *
 * 直接用 HistorySourceMessage 最小字段集构造 fixture，
 * 验证共享包不隐式依赖 ChatMessage 上才有的额外字段。
 */

import { describe, expect, it, vi } from 'vitest';
import type { HistorySourceMessage, RuntimeHistoryMessage } from '../src/history/types';
import { selectRecentHistoryForRuntime } from '../src/history/select-recent-history';
import { filterUnresolvedToolUses } from '../src/history/filter-unresolved-tool-uses';
import { isCrossTurnMemoryEnabled } from '../src/history/cross-turn-memory';
import { buildInitialMessages, buildUserMessageWithAttachments } from '../src/history/build-initial-messages';
import { DEFAULT_MAX_HISTORY_MESSAGES, TOOL_RESULT_MAX_CHARS } from '../src/history/types';

// ── Fixture helpers (minimal HistorySourceMessage) ──────────────────

function mkUser(id: string, text: string): HistorySourceMessage {
  return { id, role: 'user', content: text };
}

function mkAssistant(id: string, text: string, toolCalls?: Array<{
  tool_call_id: string; tool_name: string; input?: unknown; output?: unknown;
}>): HistorySourceMessage {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  if (toolCalls) {
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_call',
        tool_call_id: tc.tool_call_id,
        tool_name: tc.tool_name,
        input: tc.input ?? {},
        output: tc.output ?? 'result',
      });
    }
  }
  return {
    id,
    role: 'assistant',
    content: text,
    blocks_json: blocks.length > 0 ? blocks : undefined,
  };
}

// ── selectRecentHistoryForRuntime ───────────────────────────────────

describe('selectRecentHistoryForRuntime (HistorySourceMessage input)', () => {
  it('#9460：持久化 system 上下文只在 LLM 边界投影为 user', () => {
    const result = selectRecentHistoryForRuntime([
      {
        id: 'env-1',
        role: 'system',
        content: '<context type="environment">workspace</context>',
        message_kind: 'environment_context',
      },
      mkUser('u1', '继续'),
    ], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      includeSourceMessageIds: true,
    });

    expect(result).toEqual([
      {
        role: 'user',
        content: '<context type="environment">workspace</context>',
        sourceMessageId: 'env-1',
      },
      { role: 'user', content: '继续', sourceMessageId: 'u1' },
    ]);
  });

  it('#9460：system 注入进入模型历史，普通 UI 系统通知不进入', () => {
    const result = selectRecentHistoryForRuntime([
      {
        id: 'skill-1', role: 'system', content: 'skill body',
        message_kind: 'llm', metadata: { source: 'skill_invoke' },
      },
      {
        id: 'push-1', role: 'system', content: 'background complete',
        message_kind: 'llm', metadata: { triggered_by: 'push-notification' },
      },
      {
        id: 'archive-1', role: 'system', content: 'external archive boundary',
        message_kind: 'external_archive_context',
      },
      {
        id: 'parent-1', role: 'system', content: 'parent guidance',
        message_kind: 'llm', metadata: { triggered_by: 'parent_midflight' },
      },
      {
        id: 'unknown-trigger', role: 'system', content: 'do not inject',
        message_kind: 'llm', metadata: { triggered_by: 'future-human-trigger' },
      },
      { id: 'notice-1', role: 'system', content: 'member joined', message_kind: 'llm' },
    ], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      includeSourceMessageIds: true,
    });

    expect(result.map(item => item.sourceMessageId)).toEqual([
      'skill-1',
      'push-1',
      'archive-1',
      'parent-1',
    ]);
    expect(result.every(item => item.role === 'user')).toBe(true);
  });

  it('识别 compaction_summary 检查点，只装填摘要和边界后的消息', () => {
    const msgs: HistorySourceMessage[] = [
      mkUser('u1', '旧问题'),
      mkAssistant('a1', '旧回答'),
      {
        id: 'summary-1',
        role: 'system',
        content: '已总结旧问题和旧回答',
        message_kind: 'compaction_summary',
        metadata: { compacted_up_to_message_id: 'a1' },
        blocks_json: [{ type: 'text', text: '已总结旧问题和旧回答' }],
      },
      mkUser('u2', '新问题'),
      mkAssistant('a2', '新回答'),
    ];

    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    });

    expect(result.map(item => item.role)).toEqual(['user', 'user', 'assistant']);
    expect(String(result[0]?.content)).toContain('已总结旧问题和旧回答');
    expect(result.some(item => item.content === '旧问题')).toBe(false);
    expect(result.some(item => item.content === '旧回答')).toBe(false);
    expect(result.some(item => item.content === '新问题')).toBe(true);
  });

  it('#4999：hitl_interaction 消息绝不进 LLM 历史', () => {
    const msgs: HistorySourceMessage[] = [
      mkUser('u1', '帮我跑个命令'),
      {
        id: 'hitl-1',
        role: 'assistant',
        content: '',
        message_kind: 'hitl_interaction',
        metadata: {
          hitl: { kind: 'tool_approval', request_key: 'batch-1', status: 'pending' },
        },
      },
      mkAssistant('a1', '已执行完成'),
      mkUser('u2', '谢谢'),
    ];

    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
      includeSourceMessageIds: true,
    });

    expect(result.some(item => item.sourceMessageId === 'hitl-1')).toBe(false);
    expect(result.map(item => item.sourceMessageId)).toEqual(['u1', 'a1', 'u2']);
  });

  it('#8550：system_prompt_context 绝不进 LLM 历史（避免与本轮 system 双灌）', () => {
    const msgs: HistorySourceMessage[] = [
      {
        id: 'sys-1',
        role: 'user',
        content: '<identity>\nsystem rules\n</identity>',
        message_kind: 'system_prompt_context',
      },
      mkUser('u1', '第一轮提问'),
      mkAssistant('a1', '第一轮回答'),
      mkUser('u2', '第二轮提问'),
    ];

    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
      includeSourceMessageIds: true,
    });

    expect(result.some(item => item.sourceMessageId === 'sys-1')).toBe(false);
    expect(result.some(item => String(item.content).includes('<identity>'))).toBe(false);
    expect(result.map(item => item.sourceMessageId)).toEqual(['u1', 'a1', 'u2']);
  });

  it('includeSourceMessageIds=true 时保留来源消息 id', () => {
    const result = selectRecentHistoryForRuntime([mkUser('u1', '你好')], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      includeSourceMessageIds: true,
    });

    expect(result[0]?.sourceMessageId).toBe('u1');
  });

  it('基本多轮文本对话', () => {
    const msgs = [mkUser('u1', '你好'), mkAssistant('a1', '你好！'), mkUser('u2', '谢谢')];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'user', content: '你好' });
    expect(result[2]).toEqual({ role: 'user', content: '谢谢' });
  });

  it('maxMessages 截断', () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(mkUser(`u${i}`, `msg-${i}`));
      msgs.push(mkAssistant(`a${i}`, `reply-${i}`));
    }
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 4, excludeCurrentTurn: false,
    });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  // ── W4.3.2 P0 真根因层 2 修复：currentUserMessageId 严格匹配 ──
  //
  // 旧行为：excludeCurrentTurn=true 时把任何 `temp-*` id 都剔除，
  // 误杀前几轮还没拿到 server_id 的 temp-ai-* assistant 消息（dogfood W4
  // 第二轮 history 全空的真根因）。详见 docs/cross-turn-memory-decoupling.md
  // line 19 + select-recent-history.ts isCurrentTurnPlaceholder 注释。
  //
  // 新行为：只剔除 `id === currentUserMessageId` 的那一条；temp-* id 保留。
  // 调用方（sendMessageAction）总是传 currentUserMessageId，所以本轮 user
  // 仍精确剔除；turn N-1 还没 ack 的 temp-* messages 不再被误杀。

  it('W4.3.2：currentUserMessageId 精确匹配剔除当前 user，前几轮 temp-* 保留', () => {
    const msgs = [
      mkUser('temp-user-PREV-789', '第一轮 user'),  // turn 1 user 还没 ack
      mkAssistant('temp-ai-PREV-789', '回复', undefined),  // turn 1 ai 还没 ack
      mkUser('temp-user-CURRENT', '本轮 user'),  // 当前轮 user
      mkAssistant('temp-ai-CURRENT', ''),  // 当前轮 ai 占位（空 content → 装填阶段自然返回 []）
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'temp-user-CURRENT',
    });
    // turn 1 user/ai 完整保留（修复前会全部丢光）
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]).toEqual({ role: 'user', content: '第一轮 user' });
    expect(result[1]!.role).toBe('assistant');
    // 当前 user (id=temp-user-CURRENT) 被精确匹配排除
    expect(result.some(r => r.role === 'user' && r.content === '本轮 user')).toBe(false);
    // 当前 ai 占位（temp-ai-CURRENT，content=''）虽然没被排除，但 content 空 → expandAssistantFromBlocks 返回 []
    // 实际不在 result 里（没有 fallback text 可装填）
  });

  it('W4.3.2：excludeCurrentTurn=true 但漏传 currentUserMessageId → dev warn + 不剔除本轮（契约新行为）', () => {
    // Review 团队 P1：漏传 id 时旧行为是 startsWith temp-* 兜底剔除，新行为
    // 是不剔除（语义反向）。函数加 console.warn 让运维察觉契约漂移。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const msgs = [
      mkUser('temp-user-T1', 'turn 1'),
      mkAssistant('temp-ai-T1', 'reply 1'),
      mkUser('temp-user-CURRENT', '本轮 user'),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      // 故意漏传 currentUserMessageId
    });
    // warn 触发
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]![0]).toContain('excludeCurrentTurn=true 但漏传');
    // 全部 user/assistant 都被装填（含本轮 user）
    expect(result.length).toBe(3);
    warnSpy.mockRestore();
  });

  it('#2645：strictCurrentTurn=true 且漏传 currentUserMessageId → fail-fast 抛错', () => {
    const msgs = [
      mkUser('temp-user-T1', 'turn 1'),
      mkAssistant('temp-ai-T1', 'reply 1'),
      mkUser('temp-user-CURRENT', '本轮 user'),
    ];
    // 严格模式：契约漂移（excludeCurrentTurn=true 但漏传 id）应抛错而非静默 warn
    expect(() =>
      selectRecentHistoryForRuntime(msgs, {
        maxMessages: 10,
        excludeCurrentTurn: true,
        strictCurrentTurn: true,
        // 故意漏传 currentUserMessageId
      }),
    ).toThrow(/excludeCurrentTurn=true 但漏传/);
  });

  it('#2645：strictCurrentTurn=true 但正常传 currentUserMessageId → 不抛错，正常剔除本轮', () => {
    const msgs = [
      mkUser('temp-user-T1', 'turn 1'),
      mkAssistant('temp-ai-T1', 'reply 1'),
      mkUser('temp-user-CURRENT', '本轮 user'),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      strictCurrentTurn: true,
      currentUserMessageId: 'temp-user-CURRENT',
    });
    // 本轮 user 被剔除，只剩前两条
    expect(result.length).toBe(2);
    expect(result.some((m) => m.id === 'temp-user-CURRENT')).toBe(false);
  });

  it('skill_invoke 注入的长 Skill 正文跨轮装填时替换成摘要', () => {
    const longSkillBody = 'x'.repeat(5000);
    const msgs = [
      mkUser(
        'skill-msg-1',
        `<skill_instructions key="app:tabweb/browser-operator" section="网页列表直接落表" title="网页列表直接落表">\n${longSkillBody}\n</skill_instructions>`,
      ),
      mkAssistant('a1', '我会按这个 skill 执行。'),
    ];

    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: false,
    });

    expect(result[0]?.role).toBe('user');
    expect(result[0]?.content).toContain('Skill instructions previously activated');
    expect(result[0]?.content).toContain('key=app:tabweb/browser-operator');
    expect(result[0]?.content).not.toContain('section=网页列表直接落表');
    expect(result[0]?.content).toContain('same key');
    expect(result[0]?.content).not.toContain(longSkillBody.slice(0, 100));
  });

  it('W4.3.2：dogfood 现场重放——turn 1 全是 temp-* id 时仍能装填完整 history', () => {
    // 复现 dogfood session 3596343a 现场——server sync 没回填，turn 1 ChatMessage
    // 全是 temp-*。修复前 history.length === 0；修复后 history.length === 3
    // (user "ls" + assistant tool_use + user tool_result)。
    const msgs = [
      mkUser('temp-user-T1', 'ls 列出来我的当前文件夹'),
      mkAssistant('temp-ai-T1', '当前文件夹包含...', [
        { tool_call_id: 'list_directory:0', tool_name: 'list_directory', input: { path: '/p' }, output: '{"success":true}' },
      ]),
      mkUser('temp-user-T2', '那你阅读一下这个 skill'),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'temp-user-T2',
    });
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result[0]).toEqual({ role: 'user', content: 'ls 列出来我的当前文件夹' });
    // turn 1 assistant 含 tool_use + text
    const t1Asst = result.find(r => r.role === 'assistant' && Array.isArray(r.content));
    expect(t1Asst).toBeDefined();
    const asstBlocks = t1Asst!.content as Array<Record<string, unknown>>;
    expect(asstBlocks.some(b => b.type === 'tool_use')).toBe(true);
    // turn 1 tool_result 跟在 assistant 之后
    const trMsg = result.find(r => r.role === 'user' && Array.isArray(r.content));
    expect(trMsg).toBeDefined();
    const trBlocks = trMsg!.content as Array<Record<string, unknown>>;
    expect(trBlocks.some(b => b.type === 'tool_result')).toBe(true);
    // 当前轮 user 不在 history 里
    expect(result.some(r => r.role === 'user' && r.content === '那你阅读一下这个 skill')).toBe(false);
  });

  it('tool_call 展开为 tool_use + tool_result 对', () => {
    const msgs = [
      mkUser('u1', '查一下'),
      mkAssistant('a1', '正在查。', [{
        tool_call_id: 'tc1', tool_name: 'grep', input: { q: 'foo' }, output: 'found',
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    expect(result).toHaveLength(3);
    expect(result[1]!.role).toBe('assistant');
    const asstContent = result[1]!.content as Array<Record<string, unknown>>;
    expect(asstContent.some(b => b.type === 'tool_use')).toBe(true);
    expect(result[2]!.role).toBe('user');
    const userContent = result[2]!.content as Array<Record<string, unknown>>;
    expect(userContent.some(b => b.type === 'tool_result')).toBe(true);
  });

  it('Anthropic 格式 tool_use + 独立 tool_result 正确展开（库里真实格式）', () => {
    // 回归：库里 content_blocks_json 存的是 Anthropic 格式（tool_use / tool_result
    // 分两块），不是旧单块 tool_call。装填必须识别它们，否则跨轮历史 / 压缩会
    // 丢掉全部工具上下文（ dogfood：26 条消息只算出 532 token）。
    const msgs: HistorySourceMessage[] = [
      mkUser('u1', '打开维基页面并采集'),
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        blocks_json: [
          { type: 'thinking', thinking: '先打开页面' },
          { type: 'tool_use', id: 'toolu_open', name: 'browser_open', input: { url: 'https://example.com' } },
          { type: 'tool_result', tool_use_id: 'toolu_open', content: 'PAGE_TITLE: Example Domain' },
        ] as unknown as HistorySourceMessage['blocks_json'],
      },
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });

    const assistant = result.find(m => m.role === 'assistant');
    const toolUse = (assistant?.content as Array<Record<string, unknown>>).find(b => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ id: 'toolu_open', name: 'browser_open' });

    // tool_result 必须作为跟随的 user 消息出现，且 content 被保留（不再丢失）。
    const toolResultMsg = result.find(m => (
      m.role === 'user'
      && Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some(b => b.type === 'tool_result')
    ));
    expect(toolResultMsg).toBeTruthy();
    const tr = (toolResultMsg!.content as Array<Record<string, unknown>>)
      .find(b => b.type === 'tool_result') as Record<string, unknown>;
    expect(tr.tool_use_id).toBe('toolu_open');
    expect(String(tr.content)).toContain('Example Domain');
  });

  it('canonical result：run_terminal_command 跨轮保留 raw stdout，不被 projection 改写', () => {
    const rawStdout = 'RAW_TERMINAL_STDOUT_SHOULD_REACH_MODEL '.repeat(100);
    const result = selectRecentHistoryForRuntime([
      {
        id: 'a-projected-terminal',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-projected',
            tool_name: 'run_terminal_command',
            input: { command: 'tabtin table create --name 36kr' },
            output: rawStdout,
          },
          {
            type: 'metadata',
            kind: 'model_projection',
            projection_type: 'tool',
            tool_call_id: 'toolu-projected',
            tool_name: 'run_terminal_command',
            quality: 'complete',
            text: [
              'Tool Projection (run_terminal_command)',
              'Status: completed.',
              'Created table_id=table-36kr with 98/100 records.',
              'raw_ref=tool-log://thread-projection/toolu-projected',
            ].join('\n'),
          },
        ],
      },
    ], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-projection',
    });

    const serialized = JSON.stringify(result);
    // raw 是历史正式记录；projection 块只是归档产物，不再替换模型可见内容。
    expect(serialized).toContain('RAW_TERMINAL_STDOUT_SHOULD_REACH_MODEL');
    expect(serialized).not.toContain('Tool Projection (run_terminal_command)');
  });

  it('canonical result：raw 缺失时才回退 projection 归档文本恢复线索', () => {
    const result = selectRecentHistoryForRuntime([
      {
        id: 'a-missing-output-terminal',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-missing-output',
            tool_name: 'run_terminal_command',
            input: { command: 'tabtin table create --name 36kr' },
            output: null,
          },
          {
            type: 'metadata',
            kind: 'model_projection',
            projection_type: 'tool',
            tool_call_id: 'toolu-missing-output',
            tool_name: 'run_terminal_command',
            quality: 'complete',
            text: [
              'Tool Projection (run_terminal_command)',
              'Created table_id=table-36kr with 98/100 records.',
              'raw_ref=tool-log://thread-missing-output/toolu-missing-output',
            ].join('\n'),
          },
        ],
      },
    ], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-missing-output',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('table_id=table-36kr');
    expect(serialized).toContain('raw_ref=tool-log://thread-missing-output/toolu-missing-output');
  });

  it('canonical result：read_raw_ref 取证结果跨轮保留', () => {
    const rawEvidence = 'RAW_REF_EVIDENCE_BODY_SHOULD_REACH_NEXT_TURN '.repeat(10);
    const result = selectRecentHistoryForRuntime([
      {
        id: 'a-raw-ref-read',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-read-raw-ref',
            tool_name: 'read_raw_ref',
            input: {
              raw_ref: 'tool-log://thread-raw-ref/toolu-terminal',
              grep: 'table_id',
              max_chars: 1000,
            },
            output: JSON.stringify({
              success: true,
              raw_ref: 'tool-log://thread-raw-ref/toolu-terminal',
              content: rawEvidence,
            }),
          },
        ],
      },
    ], {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-raw-ref',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('RAW_REF_EVIDENCE_BODY_SHOULD_REACH_NEXT_TURN');
    expect(serialized).not.toContain('Raw evidence read omitted from cross-turn history');
  });

  it('legacy task_episode 历史降级为短文本摘要，并替换同 command 终端 transcript', () => {
    const command = 'tabtin browser collect table --url "https://example.com" --target tabdata --format json';
    const rawTranscript = ('LOW_LEVEL_COMMAND_TRANSCRIPT ' + 'x'.repeat(200) + '\n').repeat(80);
    const result = selectRecentHistoryForRuntime([
      mkUser('u-ep', '做成表'),
      {
        id: 'a-tool',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-ep',
            tool_name: 'run_terminal_command',
            input: { command },
            output: rawTranscript,
          },
        ],
      },
      {
        id: 'a-ep',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'rich_content',
            kind: 'task_episode',
            summary: 'Created example table',
            payload: {
              episode_id: 'episode-legacy',
              episode_type: 'browser_to_table',
              goal: 'Create a table from the page',
              status: 'succeeded',
              technical_evidence_refs: [
                { kind: 'terminal_command', label: 'Raw command', ref: command },
              ],
            },
          },
        ],
      },
      mkUser('u-follow', '继续'),
    ], {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-follow',
      sessionId: 'thread-legacy-ep',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('Task Episode Summary (browser_to_table)');
    expect(serialized).toContain('status=succeeded');
    expect(serialized).toContain('Create a table from the page');
    //  canonical result：raw transcript 是历史正式记录，episode 摘要
    // 只作为独立文本块并存，不再替换 tool_result。
    expect(serialized).toContain('LOW_LEVEL_COMMAND_TRANSCRIPT');
  });

  it('legacy failed task_episode 不把同 command 终端 transcript 当 episode summary 回灌', () => {
    const command = 'tabtin browser collect table --url "https://example.com" --target tabdata --format json';
    const result = selectRecentHistoryForRuntime([
      mkUser('u-fail', '做成表'),
      {
        id: 'a-fail-tool',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-fail',
            tool_name: 'run_terminal_command',
            input: { command },
            output: 'FAIL_TRANSCRIPT_SHOULD_NOT_APPEAR_AS_EPISODE_SUMMARY',
          },
        ],
      },
      {
        id: 'a-fail-ep',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'rich_content',
            kind: 'task_episode',
            summary: 'Could not create table',
            payload: {
              episode_id: 'episode-fail',
              episode_type: 'browser_to_table',
              goal: 'Create a table from the page',
              status: 'failed',
              technical_evidence_refs: [
                { kind: 'terminal_command', label: 'Raw command', ref: command },
              ],
            },
          },
        ],
      },
      mkUser('u-follow-fail', '继续'),
    ], {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-follow-fail',
      sessionId: 'thread-fail-ep',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain('Task Episode Summary (browser_to_table)');
    expect(serialized).toContain('status=failed');
    //  canonical result：raw output 原样保留在 tool_result；失败 episode
    // 依旧不会把 transcript 当 episode summary 回灌（blockedCommands 语义不变）。
    const failToolResult = result.find(m => (
      m.role === 'user'
      && Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some(b => b.type === 'tool_result')
    ));
    const failContent = (failToolResult!.content as Array<Record<string, unknown>>)
      .find(b => b.type === 'tool_result') as { content: string };
    expect(failContent.content).toBe('FAIL_TRANSCRIPT_SHOULD_NOT_APPEAR_AS_EPISODE_SUMMARY');
  });

  // ── 历史 tool_name 净化（dogfood P0 修复，2026-04-30）────────────
  //
  // 旧 session 的 messages.jsonl / blocks_json 里可能保留带点号的工具名
  // （如 `plan.create` / `system.relaunch_app`）。LLM 上游对 tool_use.name
  // 也走 `^[a-zA-Z0-9_-]{1,64}$` 正则——直接喂回会被 reject。
  // select-recent-history.ts 的 sanitizeHistoricalToolName 把仍存在的点号旧名
  // 替换为当前 canonical 名；已退休旧名收敛为 unknown_tool。
  it('历史 tool_name 含点号时净化为下划线（旧 session 平滑过渡）', () => {
    const msgs = [
      mkUser('u1', '帮我做个 plan'),
      mkAssistant('a1', '好的', [{
        tool_call_id: 'tc-old-plan',
        tool_name: 'plan.create',
        input: { name: '老 plan' },
        output: '{"document_id":"d1"}',
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const asstBlocks = result[1]!.content as Array<Record<string, unknown>>;
    const toolUse = asstBlocks.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; id: string; name: string }
      | undefined;
    expect(toolUse).toBeDefined();
    // 名字被净化成 plan_create —— 与新工具名一致，LLM 看跨轮历史认知连续
    expect(toolUse!.name).toBe('plan_create');
    // 原 tool_call_id 不变，确保 tool_use ↔ tool_result 配对仍成立
    expect(toolUse!.id).toBe('tc-old-plan');
  });

  it('历史 tool_name 含 CJK / 空格 也净化（兜底安全）', () => {
    const msgs = [
      mkUser('u1', 'q'),
      mkAssistant('a1', '好', [{
        tool_call_id: 'tc-cjk',
        tool_name: '读取技能',
        input: {}, output: 'r',
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const asstBlocks = result[1]!.content as Array<Record<string, unknown>>;
    const toolUse = asstBlocks.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string } | undefined;
    expect(toolUse).toBeDefined();
    // 全部非法字符替换成下划线
    expect(toolUse!.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('历史 tool_name 为当前合法 snake_case 时原样保留（不误改）', () => {
    const msgs = [
      mkUser('u1', 'q'),
      mkAssistant('a1', '好', [{
        tool_call_id: 'tc-ok',
        tool_name: 'read_file',
        input: { path: '/x' }, output: 'r',
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const asstBlocks = result[1]!.content as Array<Record<string, unknown>>;
    const toolUse = asstBlocks.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string } | undefined;
    expect(toolUse!.name).toBe('read_file');
  });

  it('历史 tool_name 为退休旧名时收敛为 unknown_tool', () => {
    const msgs = [
      mkUser('u1', 'q'),
      mkAssistant('a1', '好', [{
        tool_call_id: 'tc-retired',
        tool_name: 'file_read',
        input: { path: '/x' }, output: 'r',
      }]),
      mkAssistant('a2', '继续', [{
        tool_call_id: 'tc-retired-plan',
        tool_name: 'plan.exit',
        input: {}, output: 'r',
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const firstBlocks = result[1]!.content as Array<Record<string, unknown>>;
    const firstToolUse = firstBlocks.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string } | undefined;
    const secondBlocks = result[3]!.content as Array<Record<string, unknown>>;
    const secondToolUse = secondBlocks.find(b => b.type === 'tool_use') as
      | { type: 'tool_use'; name: string } | undefined;
    expect(firstToolUse!.name).toBe('unknown_tool');
    expect(secondToolUse!.name).toBe('unknown_tool');
  });

  it('tool_name 为空时丢弃 tool_call block', () => {
    const msgs = [
      mkUser('u1', 'q'),
      {
        id: 'a1', role: 'assistant', content: '有文本',
        blocks_json: [
          { type: 'text', text: '有文本' },
          { type: 'tool_call', tool_call_id: 'tc1', tool_name: '', input: {} },
        ],
      } as HistorySourceMessage,
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    expect(result).toHaveLength(2);
    const asstContent = result[1]!.content as Array<Record<string, unknown>>;
    expect(asstContent).toHaveLength(1);
    expect(asstContent[0]!.type).toBe('text');
  });

  it('空输入返回空数组', () => {
    expect(selectRecentHistoryForRuntime([], { maxMessages: 10, excludeCurrentTurn: false })).toEqual([]);
  });

  it('DEFAULT_MAX_HISTORY_MESSAGES 已禁用滑动窗口（Infinity）', () => {
    // ：滑动窗口禁用——截断交给 runtime CompactionOrchestrator，前端不再固定砍条数。
    expect(DEFAULT_MAX_HISTORY_MESSAGES).toBe(Number.POSITIVE_INFINITY);
  });

  it('TOOL_RESULT_MAX_CHARS 为 40_000（：30KB stdout + envelope 开销留余量）', () => {
    expect(TOOL_RESULT_MAX_CHARS).toBe(40_000);
  });
});

// ─── 阶段 6 议题 2：跨轮 stale 检测 + 替换为指针 ─────────────────────
//
// **Bug A 实证**：用户上午 9 点 @ 表问"销售数据"——renderer 把表 schema
// 拼到 user message 字面字符串，落盘到 content_blocks_json。上午 10 点用户
// 改了表（删列加行）。下午 3 点问"刚才那张表的平均值"——
//
//   旧实现：装填 history 时 extractUserText 原样捞出早上 9 点的快照 →
//           Agent 看到旧 schema 字面字符串 + 采样数据 → 算的是基于过时数据
//           的均值 → Agent 不知道。**没有任何"数据可能已变"提示**。
//
//   新实现：renderer 注入时套 `<context type="referenced"
//           stale_after_turn="msg-9am">` 外壳；下午 3 点装填 history
//           （currentUserMessageId="msg-3pm"）→ select-recent-history 扫到
//           wrapper 的 stale_after_turn="msg-9am" ≠ "msg-3pm" → 把 body
//           替换为指针 `[此轮曾引用资源（数据可能已变），如需最新请重新 @
//           引用]`。Agent 至少知道"这是旧快照"。
//
// 下面 5 个 case 锁定关键行为。

describe('阶段 6 议题 2：跨轮 stale 检测 + 替换', () => {
  it('case 1：无引用 → 透传不变', () => {
    const history = [
      mkUser('u-old', '帮我看看代码'),
      mkAssistant('a-old', '好的'),
    ];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-new',
    });
    expect(result[0]!.content).toBe('帮我看看代码');
  });

  it('case 2：当前轮 wrapper（stale_after_turn === currentUserMessageId）→ 保留', () => {
    const userText =
      '看下这张表\n\n' +
      '<context type="referenced" stale_after_turn="u-current">\n' +
      '## 表: 营销表\n字段：name, sales\n' +
      '</context>';
    const history = [{ id: 'u-current', role: 'user' as const, content: userText }];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
      currentUserMessageId: 'u-current',
    });
    // 同轮 wrapper 不替换
    expect(result[0]!.content).toContain('## 表: 营销表');
    expect(result[0]!.content).toContain('字段：name, sales');
    expect(result[0]!.content).not.toContain('数据可能已变');
  });

  it('case 3：隔轮 referenced wrapper → 替换为指针', () => {
    const oldUserText =
      '看下这张表\n\n' +
      '<context type="referenced" stale_after_turn="u-9am">\n' +
      '## 表: 营销表\n字段：name, sales\n采样：...\n' +
      '</context>';
    const history = [
      { id: 'u-9am', role: 'user' as const, content: oldUserText },
      mkAssistant('a-9am', '看到了，3 个字段'),
    ];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-3pm',
    });
    // body 已被替换为指针
    const replaced = result[0]!.content as string;
    expect(replaced).not.toContain('字段：name, sales');
    expect(replaced).not.toContain('采样：...');
    expect(replaced).toContain('[此轮曾引用资源（数据可能已变），如需最新请重新 @ 引用]');
    // 用户原文 "看下这张表" 仍保留
    expect(replaced).toContain('看下这张表');
    // wrapper 外壳仍保留（让二次扫描能识别）
    expect(replaced).toContain('<context type="referenced" stale_after_turn="u-9am">');
  });

  it('case 4：隔轮 attached wrapper → 替换为指针 + 保留 filename', () => {
    const oldUserText =
      '看下这文档\n\n' +
      '<context type="attached" filename="财务报告.pdf" stale_after_turn="u-old">\n' +
      '[文档: 财务报告.pdf]\n本季度营收增长 15%...\n' +
      '</context>';
    const history = [
      { id: 'u-old', role: 'user' as const, content: oldUserText },
    ];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-now',
    });
    const replaced = result[0]!.content as string;
    expect(replaced).not.toContain('本季度营收增长 15%');
    expect(replaced).toContain('[此轮曾引用附件 财务报告.pdf（数据可能已变），如需最新请重新上传]');
    // filename attr 在 wrapper 外壳里仍保留
    expect(replaced).toContain('filename="财务报告.pdf"');
  });

  it('case 4b：隔轮 attached wrapper 有 file_id → 保留原件复用入口', () => {
    const oldUserText =
      '打开这个附件\n\n' +
      '<context type="attached" file_id="file-1" filename="preview.html" stale_after_turn="u-old">\n' +
      '[文档: preview.html]\n有损摘要\n' +
      '</context>';
    const history = [
      { id: 'u-old', role: 'user' as const, content: oldUserText },
    ];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-now',
    });
    const replaced = result[0]!.content as string;
    expect(replaced).not.toContain('有损摘要');
    expect(replaced).toContain('如需原文件请调用 save_attachment');
    expect(replaced).toContain('file_id="file-1"');
  });

  it('case 5：多 wrapper 混合（referenced + attached）跨轮 → 全部替换', () => {
    const oldUserText =
      '看下这表和文档\n\n' +
      '<context type="referenced" stale_after_turn="u-old">\n' +
      '表 schema 旧版本\n' +
      '</context>\n\n' +
      '<context type="attached" filename="预算.xlsx" stale_after_turn="u-old">\n' +
      '[文档: 预算.xlsx]\n旧预算数据\n' +
      '</context>';
    const history = [
      { id: 'u-old', role: 'user' as const, content: oldUserText },
    ];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-now',
    });
    const replaced = result[0]!.content as string;
    expect(replaced).not.toContain('表 schema 旧版本');
    expect(replaced).not.toContain('旧预算数据');
    expect(replaced).toContain('[此轮曾引用资源（数据可能已变），如需最新请重新 @ 引用]');
    expect(replaced).toContain('[此轮曾引用附件 预算.xlsx（数据可能已变），如需最新请重新上传]');
  });

  it('case 6：老形态字符串前缀 `Referenced context data:` → 不识别 → 透传（向后兼容）', () => {
    // 老消息没套 SSoT wrapper，跨轮检测无锚点可比 → 保持治理前的行为
    const oldText = '看下这张表\n\n---\nReferenced context data:\n## 表 schema 旧字面字符串';
    const history = [{ id: 'u-old', role: 'user' as const, content: oldText }];
    const result = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-now',
    });
    expect(result[0]!.content).toBe(oldText);
  });
});

// ── tool output 截断 ────────────────────────────────────────────────

describe('tool output 截断 (TOOL_RESULT_MAX_CHARS)', () => {
  it('短 output 不截断', () => {
    const shortOutput = 'x'.repeat(100);
    const msgs = [
      mkUser('u1', '查一下'),
      mkAssistant('a1', '好的', [{
        tool_call_id: 'tc1', tool_name: 'grep', output: shortOutput,
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false, sessionId: 'sess-1',
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMsg).toBeDefined();
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result');
    expect(trBlock).toBeDefined();
    expect(trBlock!.content).toBe(shortOutput);
  });

  it('长 output 截断到 TOOL_RESULT_MAX_CHARS + 尾注', () => {
    const longOutput = 'A'.repeat(TOOL_RESULT_MAX_CHARS + 3000);
    const msgs = [
      mkUser('u1', '读文件'),
      mkAssistant('a1', '正在读…', [{
        tool_call_id: 'tc-long', tool_name: 'read_file', output: longOutput,
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false, sessionId: 'sess-42',
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    expect(toolResultMsg).toBeDefined();
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result') as Record<string, unknown>;
    const content = trBlock.content as string;
    expect(content.length).toBeLessThan(longOutput.length);
    expect(content).toContain('[输出已截断');
    expect(content).toContain(`原始 ${longOutput.length} 字符`);
    expect(content).toContain('tool-logs/sess-42/tc-long.md');
    expect(content.startsWith('A'.repeat(TOOL_RESULT_MAX_CHARS))).toBe(true);
  });

  it('长 output 无 sessionId 时尾注不含 tool-logs 路径', () => {
    const longOutput = 'B'.repeat(TOOL_RESULT_MAX_CHARS + 1000);
    const msgs = [
      mkUser('u1', '搜索'),
      mkAssistant('a1', '搜索中…', [{
        tool_call_id: 'tc-nosess', tool_name: 'grep', output: longOutput,
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result') as Record<string, unknown>;
    const content = trBlock.content as string;
    expect(content).toContain('[输出已截断');
    expect(content).toContain(`原始 ${longOutput.length} 字符`);
    expect(content).not.toContain('tool-logs/');
  });

  it('output=null 仍生成 archived 占位（行为不变）', () => {
    const msgs: HistorySourceMessage[] = [
      mkUser('u1', '旧查询'),
      {
        id: 'a1', role: 'assistant', content: '结果',
        blocks_json: [
          { type: 'text', text: '结果' },
          { type: 'tool_call', tool_call_id: 'tc-null', tool_name: 'search', input: {}, output: null },
        ],
      },
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false, sessionId: 'sess-old',
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result') as Record<string, unknown>;
    const content = trBlock.content as string;
    expect(content).toContain('工具输出已归档');
    expect(content).toContain('tool-logs/sess-old/tc-null.md');
    expect(content).not.toContain('[输出已截断');
  });

  it('非 string 的大对象 output 经 JSON.stringify 后截断', () => {
    const bigObj = { data: 'Z'.repeat(TOOL_RESULT_MAX_CHARS + 5000), nested: { key: 'value' } };
    const msgs = [
      mkUser('u1', '分析'),
      mkAssistant('a1', '分析中…', [{
        tool_call_id: 'tc-obj', tool_name: 'api_call', output: bigObj,
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false, sessionId: 'sess-obj',
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result') as Record<string, unknown>;
    const content = trBlock.content as string;
    expect(content).toContain('[输出已截断');
    expect(content).toContain('tool-logs/sess-obj/tc-obj.md');
    const expectedLen = JSON.stringify(bigObj).length;
    expect(content).toContain(`原始 ${expectedLen} 字符`);
  });

  it('同一条 assistant 多个超长 tool_call 各自独立截断', () => {
    const msgs = [
      mkUser('u1', '批量操作'),
      mkAssistant('a1', '执行中…', [
        { tool_call_id: 'tc-m1', tool_name: 'read_file', output: 'R'.repeat(TOOL_RESULT_MAX_CHARS + 4000) },
        { tool_call_id: 'tc-m2', tool_name: 'grep', output: 'G'.repeat(TOOL_RESULT_MAX_CHARS + 3000) },
      ]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false, sessionId: 'sess-multi',
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlocks = blocks.filter(b => b.type === 'tool_result');
    expect(trBlocks).toHaveLength(2);
    for (const tr of trBlocks) {
      const content = tr.content as string;
      expect(content).toContain('[输出已截断');
    }
    const tr1 = trBlocks.find(b => b.tool_use_id === 'tc-m1') as Record<string, unknown>;
    expect((tr1.content as string)).toContain(`原始 ${TOOL_RESULT_MAX_CHARS + 4000} 字符`);
    const tr2 = trBlocks.find(b => b.tool_use_id === 'tc-m2') as Record<string, unknown>;
    expect((tr2.content as string)).toContain(`原始 ${TOOL_RESULT_MAX_CHARS + 3000} 字符`);
  });

  it('恰好等于 TOOL_RESULT_MAX_CHARS 的 output 不截断', () => {
    const exactOutput = 'C'.repeat(TOOL_RESULT_MAX_CHARS);
    const msgs = [
      mkUser('u1', '边界'),
      mkAssistant('a1', '回复', [{
        tool_call_id: 'tc-exact', tool_name: 'tool', output: exactOutput,
      }]),
    ];
    const result = selectRecentHistoryForRuntime(msgs, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const toolResultMsg = result.find(m => m.role === 'user' && Array.isArray(m.content));
    const blocks = toolResultMsg!.content as Array<Record<string, unknown>>;
    const trBlock = blocks.find(b => b.type === 'tool_result') as Record<string, unknown>;
    expect(trBlock.content).toBe(exactOutput);
  });
});

// ── filterUnresolvedToolUses ────────────────────────────────────────

describe('filterUnresolvedToolUses', () => {
  it('无 tool_use 时 reference equal 返回', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(filterUnresolvedToolUses(msgs)).toBe(msgs);
  });

  it('全部配对时 reference equal 返回', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'ok' }] },
    ];
    expect(filterUnresolvedToolUses(msgs)).toBe(msgs);
  });

  it('全部未配对的 assistant 被丢弃', () => {
    const msgs: RuntimeHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'orphan', name: 'x', input: {} }] },
    ];
    const result = filterUnresolvedToolUses(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe('user');
  });
});

// ── isCrossTurnMemoryEnabled ────────────────────────────────────────

describe('isCrossTurnMemoryEnabled', () => {
  it('无参数默认 true', () => {
    expect(isCrossTurnMemoryEnabled()).toBe(true);
  });

  it('agentConfig.cross_turn_memory=false → false', () => {
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: false })).toBe(false);
  });

  it('envReader 返回 "1" → false', () => {
    expect(isCrossTurnMemoryEnabled(undefined, () => '1')).toBe(false);
  });

  it('envReader 抛错不炸链路', () => {
    expect(isCrossTurnMemoryEnabled(undefined, () => { throw new Error('boom'); })).toBe(true);
  });
});

// ── buildInitialMessages ────────────────────────────────────────────

describe('buildInitialMessages', () => {
  const userMsg = { role: 'user' as const, content: '新消息' };

  it('history 为空 → undefined', () => {
    expect(buildInitialMessages(undefined, userMsg)).toBeUndefined();
    expect(buildInitialMessages([], userMsg)).toBeUndefined();
  });

  it('history 非空 → [...history, userMessage]', () => {
    const history: RuntimeHistoryMessage[] = [
      { role: 'user', content: '旧消息' },
      { role: 'assistant', content: '旧回复' },
    ];
    const result = buildInitialMessages(history, userMsg);
    expect(result).toHaveLength(3);
    expect(result![2]).toEqual(userMsg);
  });
});

// ── buildUserMessageWithAttachments ─────────────────────────────────

describe('buildUserMessageWithAttachments', () => {
  it('无附件 → 纯文本 content', () => {
    const msg = buildUserMessageWithAttachments('hello');
    expect(msg).toEqual({ role: 'user', content: 'hello' });
  });

  it('file 附件 → ContentBlock[] 含 DocumentBlock（ 原生直传）', () => {
    const msg = buildUserMessageWithAttachments('hello', [{
      type: 'file',
      url: 'http://x/a.pdf',
      filename: 'a.pdf',
      mime_type: 'application/pdf',
    }]);
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'hello' });
    expect(blocks[1]).toEqual({
      type: 'document',
      source: { type: 'url', url: 'http://x/a.pdf' },
      title: 'a.pdf',
      mime_type: 'application/pdf',
    });
  });

  it('docx/xlsx 等 Office file 同样装配 DocumentBlock', () => {
    const msg = buildUserMessageWithAttachments('看表格', [{
      type: 'file',
      url: 'https://cdn.example/sheet.xlsx',
      filename: 'sheet.xlsx',
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[1]).toMatchObject({
      type: 'document',
      source: { type: 'url', url: 'https://cdn.example/sheet.xlsx' },
      title: 'sheet.xlsx',
    });
  });

  it('仅 file_id 无 url 的 file 附件不进 LLM DocumentBlock（落库仍走 FileBlock ）', () => {
    const msg = buildUserMessageWithAttachments('看附件', [{
      type: 'file',
      filename: 'notes.txt',
    }]);
    expect(msg).toEqual({ role: 'user', content: '看附件' });
  });

  it('file 无 url → 不转 DocumentBlock', () => {
    const msg = buildUserMessageWithAttachments('hello', [{ type: 'file', filename: 'x.bin' }]);
    expect(msg).toEqual({ role: 'user', content: 'hello' });
  });

  it('image 附件 → ContentBlock[] 含 ImageBlock', () => {
    const msg = buildUserMessageWithAttachments('hello', [{ type: 'image', url: 'http://img.png' }]);
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: 'hello' });
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'url', url: 'http://img.png' } });
  });

  it('#8525：image 附件带 file_id 时写入顶层字段（本机 transcript 换链）', () => {
    const msg = buildUserMessageWithAttachments('hello', [{
      type: 'image',
      file_id: 'fid-img-1',
      url: 'http://img.png',
      filename: 'shot.png',
      mime_type: 'image/png',
    }]);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks[1]).toMatchObject({
      type: 'image',
      file_id: 'fid-img-1',
      filename: 'shot.png',
      mime_type: 'image/png',
      source: { type: 'url', url: 'http://img.png' },
    });
  });

  it('video 附件 → ContentBlock[] 含 VideoBlock ', () => {
    const msg = buildUserMessageWithAttachments('看这段视频', [
      { type: 'video', url: 'https://cdn.example.com/demo.mp4' },
    ]);
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'text', text: '看这段视频' });
    expect(blocks[1]).toMatchObject({
      type: 'video',
      source: { type: 'url', url: 'https://cdn.example.com/demo.mp4' },
    });
  });

  it('空文本 + image 附件 → 仅构造 image block，避免空 text part', () => {
    const msg = buildUserMessageWithAttachments('', [{ type: 'image', url: 'http://img.png' }]);
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'url', url: 'http://img.png' } });
  });

  it('空白文本 + image 附件 → 同样不构造空 text part', () => {
    const msg = buildUserMessageWithAttachments('   ', [{ type: 'image', url: 'http://img.png' }]);
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image', source: { type: 'url', url: 'http://img.png' } });
  });

  it('image 无 url → 不转 block', () => {
    const msg = buildUserMessageWithAttachments('hello', [{ type: 'image' }]);
    expect(msg).toEqual({ role: 'user', content: 'hello' });
  });
});

// ── W4.3 P0 修复：expandAssistantFromBlocks 顺序保留 ────────────────
//
// 与上面 "tool_call 展开为 tool_use + tool_result 对" 的现有测试不同，
// 这组测试聚焦"text 与 tool_use 在 blocks_json 中的相对位置在
// 展开后必须严格保留"——dogfood W4 第三轮 thinking "用户同时请求
// 两件事" bug 的根因之一。

describe('W4.3 P0 — expandAssistantFromBlocks 保留 blocks_json 出现顺序', () => {
  function asstWithCustomBlocks(id: string, blocks: Array<Record<string, unknown>>): HistorySourceMessage {
    return { id, role: 'assistant', content: '', blocks_json: blocks };
  }

  it('blocks_json: [text₁, tool_call, text₂] → assistant 中三块顺序保留', () => {
    const msg = asstWithCustomBlocks('a1', [
      { type: 'text', text: '我打算读 file1' },
      { type: 'tool_call', tool_call_id: 'tc1', tool_name: 'read_file', input: { path: 'f1' }, output: 'content of f1' },
      { type: 'text', text: '我已经读完了 file1，内容是...' },
    ]);
    const result = selectRecentHistoryForRuntime([msg], {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    expect(result).toHaveLength(2); // 1 assistant + 1 user(tool_result)
    const asstContent = result[0]!.content as Array<Record<string, unknown>>;
    expect(asstContent).toHaveLength(3);
    expect(asstContent[0]).toMatchObject({ type: 'text', text: '我打算读 file1' });
    expect(asstContent[1]).toMatchObject({ type: 'tool_use', id: 'tc1' });
    expect(asstContent[2]).toMatchObject({ type: 'text', text: '我已经读完了 file1，内容是...' });
  });

  it('blocks_json: [text₁, tool_call₁, text₂, tool_call₂, text₃] → 5 块全保序', () => {
    const msg = asstWithCustomBlocks('a1', [
      { type: 'text', text: 'A' },
      { type: 'tool_call', tool_call_id: 'tc1', tool_name: 'x', input: {}, output: 'r1' },
      { type: 'text', text: 'B' },
      { type: 'tool_call', tool_call_id: 'tc2', tool_name: 'y', input: {}, output: 'r2' },
      { type: 'text', text: 'C' },
    ]);
    const result = selectRecentHistoryForRuntime([msg], {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    expect(result).toHaveLength(2);
    const asstContent = result[0]!.content as Array<Record<string, unknown>>;
    expect(asstContent.map((b) => b.type)).toEqual(['text', 'tool_use', 'text', 'tool_use', 'text']);
    expect(asstContent[0]).toMatchObject({ type: 'text', text: 'A' });
    expect(asstContent[1]).toMatchObject({ type: 'tool_use', id: 'tc1' });
    expect(asstContent[2]).toMatchObject({ type: 'text', text: 'B' });
    expect(asstContent[3]).toMatchObject({ type: 'tool_use', id: 'tc2' });
    expect(asstContent[4]).toMatchObject({ type: 'text', text: 'C' });
  });

  it('旧 bug 复现对照：W4.3 之前 [text₁, tool_call, text₂] 会被压成 text₁+text₂ 在头部', () => {
    // 这条测试存在的目的：作为 regression guard——如果未来有人改回"text 用 unshift
    // 收集到头部"的旧实现，这条测试会失败。
    const msg = asstWithCustomBlocks('a1', [
      { type: 'text', text: '我打算读 file1' },
      { type: 'tool_call', tool_call_id: 'tc1', tool_name: 'read_file', input: {}, output: 'content' },
      { type: 'text', text: '我已经读完了 file1' },
    ]);
    const result = selectRecentHistoryForRuntime([msg], {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const asstContent = result[0]!.content as Array<Record<string, unknown>>;
    // ❌ 旧实现会让第一个块是 "我打算读 file1\n\n我已经读完了 file1" 合并文本
    //    （unshift({type:'text', text:textPieces.join('\n\n')})）
    // ✅ 新实现：第一个块是单独的 "我打算读 file1"
    const firstBlock = asstContent[0] as { type: string; text?: string };
    expect(firstBlock.type).toBe('text');
    expect(firstBlock.text).not.toContain('我已经读完了 file1');
    expect(firstBlock.text).toBe('我打算读 file1');
  });
});

// ── W4.3 P0 修复：dogfood 多轮场景端到端值流验证 ───────────────────
//
// 模拟 dogfood 真实场景：用户跟 Agent 多轮对话，每轮 Agent 都调一次工具
// （read_file），给出 final answer。第三轮 user message 不能被错误合并
// 到第二轮 tool_result message 里。

describe('W4.3 P0 — dogfood 跨轮 user message 不被合并到 tool_result（端到端值流）', () => {
  it('3 轮场景：装填 history → buildInitialMessages → 模拟传给 normalizer 后 turn₂ tool_result 不吞 turn₃ user', async () => {
    // 模拟 Renderer chat-store 里持久化的 ChatMessage 序列（按时间升序）。
    // turn₁: user "你好" → assistant "你好" (无工具)
    // turn₂: user "读 file1" → assistant 含 tool_use + final answer
    // turn₃: user "读 file2 / 一句话概括" (本轮，excludeCurrentTurn=true 排除占位)
    const historicalMessages: HistorySourceMessage[] = [
      mkUser('u-turn1', '你好'),
      mkAssistant('a-turn1', '你好！请问有什么可以帮您？'),
      mkUser('u-turn2', '读 claude_sandbox_report.md'),
      // 关键 fixture：turn₂ assistant 的 blocks_json 是 [text-intent, tool_call, text-final]
      {
        id: 'a-turn2',
        role: 'assistant',
        content: '',
        blocks_json: [
          { type: 'text', text: '我打算读 claude_sandbox_report.md' },
          { type: 'tool_call', tool_call_id: 'tc-read1', tool_name: 'read_file', input: { path: 'claude_sandbox_report.md' }, output: 'sandbox report content...' },
          { type: 'text', text: '已读完。报告主要讲了 sandbox vendor 选型对比' },
        ],
      },
    ];
    // turn₃ 本轮的 user message——是真实的（不是 temp-user-* 占位）
    const turn3UserPrompt = '读 sandbox_vendors_comparison.md / 一句话概括';

    // 1️⃣ 装填 history（excludeCurrentTurn=true 排除可能的 temp-user-* 占位）
    const history = selectRecentHistoryForRuntime(historicalMessages, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: undefined,
    });

    // 2️⃣ 构造本轮 user message + 拼到 initialMessages 末尾
    const turn3UserMessage = buildUserMessageWithAttachments(turn3UserPrompt);
    const initialMessages = buildInitialMessages(history, turn3UserMessage);
    expect(initialMessages).toBeDefined();

    // 3️⃣ 给 mergeConsecutiveMessages 跑一遍模拟 normalizer 的合并逻辑
    const { mergeConsecutiveMessages } = await import('../src/engine/context/message-normalizer.js');
    const merged = mergeConsecutiveMessages(initialMessages!, 'user');

    // ✅ 关键断言：turn₃ 的 user message "读 file2 / 概括" 必须独立保留，
    //    不被 turn₂ 的 tool_result user message 吞并
    const lastUserMsg = merged.messages[merged.messages.length - 1];
    expect(lastUserMsg.role).toBe('user');
    expect(lastUserMsg.content).toBe(turn3UserPrompt);  // string content（来自 buildUserMessageWithAttachments）

    // ✅ 关键断言：倒数第二条 user message 是 tool_result-only
    //    （turn₂ 的工具结果，不应混入 turn₃ 的请求文本）
    const messages = merged.messages;
    const turn2ToolResultMsg = messages[messages.length - 2];
    expect(turn2ToolResultMsg.role).toBe('user');
    expect(Array.isArray(turn2ToolResultMsg.content)).toBe(true);
    const turn2Blocks = turn2ToolResultMsg.content as Array<Record<string, unknown>>;
    // 全部 block 必须是 tool_result——没有混进 turn₃ 的 TextBlock("读 file2...")
    const allBlocksAreToolResult = turn2Blocks.every((b) => b.type === 'tool_result');
    expect(allBlocksAreToolResult).toBe(true);

    // ✅ 顺手验证 turn₂ assistant 的 final answer text 在 tool_use 之后保留了位置
    //    （Stage 4 expandAssistantFromBlocks 修复）
    const turn2AssistantMsg = messages.find((m, i) => {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) return false;
      return m.content.some((b: Record<string, unknown>) => b.type === 'tool_use');
    });
    expect(turn2AssistantMsg).toBeDefined();
    const turn2AssistantBlocks = turn2AssistantMsg!.content as Array<Record<string, unknown>>;
    // 期望顺序：text-intent → tool_use → text-final
    expect(turn2AssistantBlocks[0]).toMatchObject({ type: 'text', text: '我打算读 claude_sandbox_report.md' });
    expect(turn2AssistantBlocks[1]).toMatchObject({ type: 'tool_use' });
    expect(turn2AssistantBlocks[2]).toMatchObject({ type: 'text', text: '已读完。报告主要讲了 sandbox vendor 选型对比' });
  });

  it('退化场景：turn₂ assistant 没有 final answer text（直接 tool_use 后停止）→ 仍不能吞跨轮 user', async () => {
    // 这是更难的场景：turn₂ assistant blocks_json: [text-intent, tool_call]，
    // 没有 final answer text。装填后：
    //   ..., user "读 file1", assistant [text-intent + tool_use], user [tool_result], user "读 file2"
    // 旧 mergeConsecutiveMessages 会把后两条 user 合并 → bug。
    // 新实现因为类别不同（tool_result_only vs other）拒绝合并 → 保护成功。
    const historicalMessages: HistorySourceMessage[] = [
      mkUser('u-t2', '读 file1'),
      {
        id: 'a-t2',
        role: 'assistant',
        content: '',
        blocks_json: [
          { type: 'text', text: '正在读' },
          { type: 'tool_call', tool_call_id: 'tc-r1', tool_name: 'read_file', input: {}, output: 'content' },
        ],
      },
    ];
    const history = selectRecentHistoryForRuntime(historicalMessages, {
      maxMessages: 10, excludeCurrentTurn: false,
    });
    const turn3UserMessage = buildUserMessageWithAttachments('读 file2');
    const initial = buildInitialMessages(history, turn3UserMessage);

    const { mergeConsecutiveMessages } = await import('../src/engine/context/message-normalizer.js');
    const merged = mergeConsecutiveMessages(initial!, 'user');

    // ✅ 关键断言：最后两条 user message 仍是独立的（虽然 consecutive 但类别不同）
    expect(merged.messages.length).toBeGreaterThanOrEqual(4);
    const last = merged.messages[merged.messages.length - 1];
    const secondToLast = merged.messages[merged.messages.length - 2];
    expect(last.role).toBe('user');
    expect(secondToLast.role).toBe('user');
    expect(last.content).toBe('读 file2');
    expect(Array.isArray(secondToLast.content)).toBe(true);
    const stlBlocks = secondToLast.content as Array<Record<string, unknown>>;
    expect(stlBlocks.every((b) => b.type === 'tool_result')).toBe(true);
  });
});

// ── preserveReasoningForToolTurns（跨轮 reasoning 回传 · DeepSeek V4） ──────

describe('selectRecentHistoryForRuntime — preserveReasoningForToolTurns', () => {
  function mkAssistantWithThinking(id: string, opts: { withTool: boolean }): HistorySourceMessage {
    const blocks: Array<Record<string, unknown>> = [
      { type: 'thinking', thinking: 'tool turn reasoning', signature: 's1' },
    ]
    if (opts.withTool) {
      blocks.push({ type: 'tool_use', id: 'tc1', name: 'read_file', input: {} })
      blocks.push({ type: 'tool_result', tool_use_id: 'tc1', content: 'ok' })
    } else {
      blocks.push({ type: 'text', text: 'final answer' })
    }
    return { id, role: 'assistant', content: '', blocks_json: blocks as HistorySourceMessage['blocks_json'] }
  }

  function assistantThinking(result: RuntimeHistoryMessage[]): string[] {
    const out: string[] = []
    for (const m of result) {
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'thinking' && typeof b.thinking === 'string') out.push(b.thinking)
      }
    }
    return out
  }

  it('开关 on + 工具轮：保留 thinking 块', () => {
    const result = selectRecentHistoryForRuntime(
      [mkUser('u1', 'do a task'), mkAssistantWithThinking('a1', { withTool: true })],
      { maxMessages: 10, excludeCurrentTurn: false, preserveReasoningForToolTurns: true },
    )
    expect(assistantThinking(result)).toContain('tool turn reasoning')
  })

  it('开关 off（默认）+ 工具轮：丢弃 thinking（不回归 ）', () => {
    const result = selectRecentHistoryForRuntime(
      [mkUser('u1', 'do a task'), mkAssistantWithThinking('a1', { withTool: true })],
      { maxMessages: 10, excludeCurrentTurn: false },
    )
    expect(assistantThinking(result)).toHaveLength(0)
  })

  it('开关 on + 非工具轮：仍丢弃 thinking（上游不要求、省 token）', () => {
    const result = selectRecentHistoryForRuntime(
      [mkUser('u1', 'hi'), mkAssistantWithThinking('a1', { withTool: false })],
      { maxMessages: 10, excludeCurrentTurn: false, preserveReasoningForToolTurns: true },
    )
    expect(assistantThinking(result)).toHaveLength(0)
  })
})

describe('selectRecentHistoryForRuntime —  agent-profile keep-latest', () => {
  it('历史多份 agent_profile_context 只保留最新一份', () => {
    const oldProfile: HistorySourceMessage = {
      id: 'p1',
      role: 'user',
      message_kind: 'agent_profile_context',
      content: '<context type="agent-profile">\nold\n</context>',
    }
    const newProfile: HistorySourceMessage = {
      id: 'p2',
      role: 'user',
      message_kind: 'agent_profile_context',
      content: '<context type="agent-profile">\nnew\n</context>',
    }
    const result = selectRecentHistoryForRuntime(
      [
        oldProfile,
        mkUser('u1', '第一轮'),
        mkAssistant('a1', 'ok'),
        newProfile,
        mkUser('u2', '第二轮'),
        mkAssistant('a2', 'ok2'),
      ],
      { maxMessages: 20, excludeCurrentTurn: false },
    )
    const profileTexts = result
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string)
      .filter((t) => t.includes('type="agent-profile"'))
    expect(profileTexts).toHaveLength(1)
    expect(profileTexts[0]).toContain('new')
    expect(profileTexts[0]).not.toContain('old')
  })

  it('无 message_kind 时按 content wrapper 兜底 keep-latest', () => {
    const result = selectRecentHistoryForRuntime(
      [
        mkUser('p1', '<context type="agent-profile">\nv1\n</context>'),
        mkUser('u1', 'hi'),
        mkAssistant('a1', 'yo'),
        mkUser('p2', '<context type="agent-profile">\nv2\n</context>'),
        mkUser('u2', 'again'),
      ],
      { maxMessages: 20, excludeCurrentTurn: false },
    )
    const profileTexts = result
      .filter((m) => m.role === 'user' && typeof m.content === 'string')
      .map((m) => m.content as string)
      .filter((t) => t.includes('type="agent-profile"'))
    expect(profileTexts).toEqual([
      expect.stringContaining('v2'),
    ])
  })
})

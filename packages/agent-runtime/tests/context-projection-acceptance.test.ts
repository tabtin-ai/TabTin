import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectMessagesForLlm } from '../src/engine/context/llm-context-projection.js';
import { normalizeMessages, validateToolPairing } from '../src/engine/context/message-normalizer.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import { buildInitialMessages } from '../src/history/build-initial-messages.js';
import { buildReplayHistoryFromTranscript } from '../src/history/replay-transcript-history.js';
import { selectRecentHistoryForRuntime } from '../src/history/select-recent-history.js';
import type { HistorySourceMessage } from '../src/history/types.js';
import { TOOL_RESULT_MAX_CHARS } from '../src/history/types.js';
import { projectTerminalToolResult } from '../src/projection/terminal-tool-projector.js';
import { SessionStorage } from '../src/session/storage.js';

const SOURCE_URL = 'https://pitchhub.36kr.com/projects?sort=3';
const COMMAND = 'tabtin browser collect table --url "https://pitchhub.36kr.com/projects?sort=3" --target tabdata --format json';
const RAW_TRANSCRIPT_SENTINEL = 'LOW_LEVEL_COMMAND_TRANSCRIPT jq curl tempfile network inspector stdout stderr';

/**
 * Canonical result 契约验收。
 *
 * 工具结果在产生时限长一次（终端 stdout 由 shell.ts STDOUT_INLINE_MAX_BYTES
 * 收口），进入历史后即为正式记录：跨轮装填原样复用 raw，不再被 model
 * projection 逐轮改写。收益：批量取证证据可累积（模型不必退回逐文件
 * read_file）、请求前缀跨轮稳定（prompt cache 可命中）。
 *
 * 兜底来源说明：raw 缺失（旧库未持久化 output）时的恢复线索只来自
 * blocks_json 内的 `metadata/model_projection` 块（collectModelProjectionIndex）。
 * model-projections.jsonl 仍在写入但已无生产读取方（write-only 归档），
 * 是否接入兜底或删除写入链见  的后续项。
 */
describe('Canonical result contract acceptance', () => {
  it('终端 raw 输出跨轮保留在历史中，不被 projection 块替换', () => {
    const rawTranscript = `${RAW_TRANSCRIPT_SENTINEL}\n${'verbose browser and terminal logs\n'.repeat(40)}`;
    const history: HistorySourceMessage[] = [
      {
        id: 'u-36kr-canonical',
        role: 'user',
        content: `帮我把 ${SOURCE_URL} 做成表`,
      },
      {
        id: 'a-36kr-canonical-tool',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-36kr-canonical',
            tool_name: 'run_terminal_command',
            input: { command: COMMAND },
            output: rawTranscript,
          },
          {
            type: 'metadata',
            kind: 'model_projection',
            projection_type: 'tool',
            tool_call_id: 'toolu-36kr-canonical',
            tool_name: 'run_terminal_command',
            quality: 'complete',
            text: 'Tool Projection (run_terminal_command)\nStatus: completed.',
          },
        ],
      },
      {
        id: 'u-follow-canonical',
        role: 'user',
        content: '继续补采后 100 条',
      },
    ];

    const selectedHistory = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: true,
      currentUserMessageId: 'u-follow-canonical',
      sessionId: 'thread-36kr-canonical',
    });
    const serialized = JSON.stringify(selectedHistory);

    expect(serialized).toContain(RAW_TRANSCRIPT_SENTINEL);
    expect(serialized).not.toContain('Tool Projection (run_terminal_command)');
    expect(serialized).not.toContain('Projection unavailable');

    const normalized = normalizeMessages(selectedHistory as Message[], { level: 'full' });
    expect(validateToolPairing(normalized.messages)).toBe(true);
    expect(normalized.changes.orphan_tool_result_fixed).toBe(0);
  });

  it('超预算输出只在装填时截一次并附归档指针，截断结果可稳定复用', () => {
    const hugeOutput = 'A'.repeat(TOOL_RESULT_MAX_CHARS + 5000);
    const history: HistorySourceMessage[] = [
      {
        id: 'a-huge-output',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-huge',
            tool_name: 'run_terminal_command',
            input: { command: 'python emit-big-log.py' },
            output: hugeOutput,
          },
        ],
      },
    ];

    const opts = {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-huge',
    } as const;
    const first = selectRecentHistoryForRuntime(history, opts);
    const second = selectRecentHistoryForRuntime(history, opts);

    const firstSerialized = JSON.stringify(first);
    expect(firstSerialized).toContain('A'.repeat(1000));
    expect(firstSerialized).toContain('输出已截断');
    expect(firstSerialized).toContain('tool-logs/thread-huge/toolu-huge.md');
    // 装填是纯函数：同输入两次装填 byte 一致（前缀稳定 / prompt cache 前提）。
    expect(JSON.stringify(second)).toBe(firstSerialized);
  });

  it('raw 缺失（旧库未持久化 output）时回退 projection 归档文本恢复结构化线索', () => {
    const terminalProjection = projectTerminalToolResult({
      toolCallId: 'toolu-36kr-projection',
      sessionId: 'thread-36kr-projection',
      command: COMMAND,
      output: JSON.stringify({
        status: 'completed',
        exit_code: 0,
        stdout: JSON.stringify({
          status: 'succeeded',
          table_id: 'table-36kr-projection',
          row_count: 100,
          source_url: SOURCE_URL,
        }),
        stdout_truncated: false,
      }),
    });
    const history: HistorySourceMessage[] = [
      {
        id: 'a-36kr-no-raw',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'toolu-36kr-projection',
            tool_name: 'run_terminal_command',
            input: { command: COMMAND },
            output: null,
          },
          {
            ...terminalProjection,
          },
        ],
      },
    ];

    const selectedHistory = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-36kr-projection',
    });
    const serialized = JSON.stringify(selectedHistory);

    expect(serialized).toContain('table_id=table-36kr-projection');
    expect(serialized).toContain('row_count=100');
    expect(serialized).toContain('raw_ref=tool-log://thread-36kr-projection/toolu-36kr-projection');

    const normalized = normalizeMessages(selectedHistory as Message[], { level: 'full' });
    expect(validateToolPairing(normalized.messages)).toBe(true);
  });

  it('生产链路 roundtrip：record → flush → restore → replay → initialMessages 全程 canonical 字节不变', async () => {
    // Electron 主链路是 restoreMessages → buildReplayHistoryFromTranscript →
    // buildInitialMessages（query-turn-pipeline.ts），不经 selectRecentHistoryForRuntime。
    // 本用例锁定该真实链路上的契约：本轮模型看到的工具结果 = 落盘 = 下轮恢复。
    // canonical 取 ~60K（大于 storage 旧 50K 挖空上限）锁定回归：旧实现会把
    // envelope 改写成「头 5000 + 尾 2000」，JSON 被切碎且中段证据丢失。
    const canonical = JSON.stringify({
      status: 'completed',
      exit_code: 0,
      stdout: 'L'.repeat(60_000),
      stdout_truncated: false,
      output_file: '/tmp/tabtin-tool-results/thread-roundtrip/stdout.log',
    });

    const sessionDir = mkdtempSync(join(tmpdir(), 'canonical-roundtrip-'));
    const writer = new SessionStorage({ sessionDir, threadId: 'thread-roundtrip' });
    await writer.recordUserMessage({ role: 'user', content: '跑批量取证命令' });
    await writer.recordAssistantMessage({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tc-roundtrip',
        name: 'run_terminal_command',
        input: { command: 'rg -n pattern | head -200' },
      }],
    });
    await writer.recordUserMessage({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tc-roundtrip', content: canonical }],
    });
    await writer.recordAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: '取证完成。' }] });
    await writer.dispose();

    // 模拟下一轮：新进程重建 storage → restore → replay → initialMessages。
    const reader = new SessionStorage({ sessionDir, threadId: 'thread-roundtrip' });
    const transcript = await reader.restoreMessages();
    const replay = buildReplayHistoryFromTranscript(transcript);
    const initialMessages = buildInitialMessages(replay, { role: 'user', content: '继续下一步' });
    expect(initialMessages).toBeDefined();

    const toolResults = initialMessages!.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_result')
        : []);
    expect(toolResults).toHaveLength(1);
    // canonical 字节不变：落盘与恢复对 tool_result 无损。
    expect((toolResults[0] as { content: string }).content).toBe(canonical);

    // LLM 出口投影（slim + fence）幂等：同输入两次投影 byte 一致 ——
    // 上一轮与下一轮对同一 canonical 产出相同的 LLM 可见形态（前缀稳定前提）。
    const projectedOnce = projectMessagesForLlm(initialMessages as Message[]);
    const projectedTwice = projectMessagesForLlm(projectedOnce);
    expect(JSON.stringify(projectedTwice)).toBe(JSON.stringify(projectedOnce));

    const normalized = normalizeMessages(initialMessages as Message[], { level: 'full' });
    expect(validateToolPairing(normalized.messages)).toBe(true);
  });

  it('装填结果可直接拼进 initialMessages 且当前轮 user 不重复', () => {
    const history: HistorySourceMessage[] = [
      { id: 'u-1', role: 'user', content: '请执行 smoke 命令' },
      {
        id: 'a-1',
        role: 'assistant',
        content: '',
        blocks_json: [
          {
            type: 'tool_call',
            tool_call_id: 'run_terminal_command:0',
            tool_name: 'run_terminal_command',
            input: { command: 'echo smoke' },
            output: '{"table_id":"projection_smoke_table","rows":123}',
          },
        ],
      },
    ];
    const selectedHistory = selectRecentHistoryForRuntime(history, {
      maxMessages: 10,
      excludeCurrentTurn: false,
      sessionId: 'thread-live-smoke',
    });

    const initialMessages = buildInitialMessages(selectedHistory, {
      role: 'user',
      content: '刚才命令的 table_id 和 rows 是多少？',
    });
    expect(initialMessages).toBeDefined();
    expect(JSON.stringify(initialMessages)).toContain('projection_smoke_table');
    const currentUserCount = initialMessages!.filter((message) =>
      message.role === 'user'
      && JSON.stringify(message.content).includes('刚才命令的 table_id 和 rows 是多少？')
    ).length;
    expect(currentUserCount).toBe(1);

    const normalized = normalizeMessages(initialMessages!, { level: 'full' });
    expect(validateToolPairing(normalized.messages)).toBe(true);
  });
});

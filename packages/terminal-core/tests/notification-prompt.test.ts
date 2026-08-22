/**
 * notification-prompt 单测（W4a S0，2026-05-30）。
 *
 * 验证 consumer 端「按 env.kind 分派合成 prompt」骨架：
 *   1. subagent-completed：enqueue → drain → composeNotificationPrompt 含
 *      `<subagent-run-id>` + run_id + label/status/duration/summary。
 *   2. shell 与 subagent **分派互不污染**：混合 drain 时两段各自成块，
 *      shell 段不含 subagent 字段、subagent 段不含 shell 字段。
 *   3. **回归守门**：纯 shell 输出与上提前两端 host 私有方法逐字节一致
 *      （保证「无 LLM 行为变化」）。
 *   4. 未知 kind：skip + onUnknownKind 回调（防 producer 误入）。
 *   5. XML 转义：特殊字符不破坏 `<task-notification>` 结构。
 *
 * 走**真实 NotificationQueue**（enqueue/drain 不 mock），与
 * notification-queue.test.ts 同源（plan「不 mock enqueue/drain 接口」）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationQueue,
  type NotificationEnvelope,
  type BackgroundTaskCompletedPayload,
  type SubagentCompletedPayload,
} from '../src/notification-queue.js';
import {
  composeNotificationPrompt,
  buildSubagentCompletionEnvelope,
  SUBAGENT_NOTIFICATION_KIND,
} from '../src/notification-prompt.js';

const THREAD = 'chat-thread-A';

function makeQueue() {
  let clock = 1_700_000_000_000;
  return new NotificationQueue({
    clock: () => clock,
    setInterval: () => 'h',
    clearInterval: () => {},
    log: () => {},
  });
}

function shellEnvelope(
  overrides: Partial<BackgroundTaskCompletedPayload> = {},
  dedupKey = `shell-${Math.random()}`,
): NotificationEnvelope<BackgroundTaskCompletedPayload> {
  return {
    kind: 'background-task-completed',
    target: { spaceId: 'space-1', threadId: THREAD },
    priority: 'later',
    enqueuedAt: 1_700_000_000_000,
    dedupKey,
    payload: {
      agent_session_id: 'agent-1',
      tool_use_id: 'run_terminal_command:0',
      command: 'echo hi',
      exit_code: 0,
      exited_by: 'normal_exit',
      duration_ms: 12,
      output_file_path: '/tmp/out.log',
      cwd: '/tmp/work',
      ...overrides,
    },
  };
}

function subagentEnvelope(
  overrides: Partial<SubagentCompletedPayload> = {},
  dedupKey = `sub-${Math.random()}`,
): NotificationEnvelope<SubagentCompletedPayload> {
  return {
    kind: 'subagent-completed',
    target: { spaceId: 'space-1', threadId: THREAD },
    priority: 'later',
    enqueuedAt: 1_700_000_000_000,
    dedupKey,
    payload: {
      subagent_run_id: 'child-uuid-1234',
      parent_thread_id: THREAD,
      label: '调研候选方案',
      status: 'completed',
      summary: '已完成调研，推荐方案 B。',
      duration_ms: 4200,
      step_count: 7,
      ...overrides,
    },
  };
}

// ─── 1. subagent enqueue → drain → prompt ─────────────────────────────

describe('composeNotificationPrompt: subagent-completed', () => {
  it('enqueue → drain → prompt 含 <subagent-run-id> + run_id + 字段', () => {
    const queue = makeQueue();
    queue.enqueue(subagentEnvelope());

    const items = queue.drainByThreadId(THREAD);
    expect(items).toHaveLength(1);

    const prompt = composeNotificationPrompt(items);
    expect(prompt).toContain('<task-notification kind="subagent-completed">');
    expect(prompt).toContain('<subagent-run-id>child-uuid-1234</subagent-run-id>');
    expect(prompt).toContain('<label>调研候选方案</label>');
    expect(prompt).toContain('<status>completed</status>');
    expect(prompt).toContain('<duration-ms>4200</duration-ms>');
    expect(prompt).toContain('<step-count>7</step-count>');
    expect(prompt).toContain('<summary>已完成调研，推荐方案 B。</summary>');
    expect(prompt).toContain('A background sub-agent finished');
    // 不含 shell 专属字段
    expect(prompt).not.toContain('<command>');
    expect(prompt).not.toContain('<exit-code>');
  });

  it('可选字段缺省时不渲染对应标签；存在时渲染', () => {
    const queue = makeQueue();
    queue.enqueue(
      subagentEnvelope({
        status: 'failed',
        error_kind: 'timeout',
        summary_file_path: '/tmp/child-summary.txt',
        parent_tool_call_id: 'toolu_abc',
        step_count: undefined,
      }),
    );
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).toContain('<status>failed</status>');
    expect(prompt).toContain('<error-kind>timeout</error-kind>');
    expect(prompt).toContain('<summary-file>/tmp/child-summary.txt</summary-file>');
    expect(prompt).toContain('<parent-tool-call-id>toolu_abc</parent-tool-call-id>');
    expect(prompt).not.toContain('<step-count>');
  });

  it('多个子 Agent 完成合并成一段（复数前缀 + 各自 XML 块）', () => {
    const queue = makeQueue();
    queue.enqueue(subagentEnvelope({ subagent_run_id: 'c1' }, 'k1'));
    queue.enqueue(subagentEnvelope({ subagent_run_id: 'c2' }, 'k2'));
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).toContain('2 background sub-agents finished');
    expect(prompt).toContain('<subagent-run-id>c1</subagent-run-id>');
    expect(prompt).toContain('<subagent-run-id>c2</subagent-run-id>');
  });
});

// ─── 2. shell / subagent 分派互不污染 ─────────────────────────────────

describe('composeNotificationPrompt: kind 分派互不污染', () => {
  it('混合 drain：shell 段 + subagent 段各自成块', () => {
    const queue = makeQueue();
    queue.enqueue(shellEnvelope({ command: 'npm test' }, 'shell-1'));
    queue.enqueue(subagentEnvelope({ subagent_run_id: 'child-x' }, 'sub-1'));

    const items = queue.drainByThreadId(THREAD);
    expect(items).toHaveLength(2);
    const prompt = composeNotificationPrompt(items);

    // 两段都在
    expect(prompt).toContain('A background command completed');
    expect(prompt).toContain('A background sub-agent finished');
    expect(prompt).toContain('<command>npm test</command>');
    expect(prompt).toContain('<subagent-run-id>child-x</subagent-run-id>');

    // 互不污染：shell 的 <task-notification> 块里没有 subagent 字段
    const shellBlockStart = prompt.indexOf('<task-notification>');
    const shellBlockEnd = prompt.indexOf('</task-notification>', shellBlockStart);
    const shellBlock = prompt.slice(shellBlockStart, shellBlockEnd);
    expect(shellBlock).not.toContain('subagent-run-id');

    const subBlockStart = prompt.indexOf('<task-notification kind="subagent-completed">');
    const subBlock = prompt.slice(subBlockStart);
    expect(subBlock).not.toContain('<command>');
    expect(subBlock).not.toContain('<exit-code>');
  });

  it('纯 subagent drain 不产出任何 shell 文案', () => {
    const queue = makeQueue();
    queue.enqueue(subagentEnvelope());
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).not.toContain('background command completed');
    expect(prompt).not.toContain('Read the output-file path');
  });
});

// ─── 3. shell 回归守门（逐字节一致） ──────────────────────────────────

describe('composeNotificationPrompt: shell 段回归守门', () => {
  it('单条 shell：输出与上提前两端 host 私有方法逐字节一致', () => {
    const queue = makeQueue();
    queue.enqueue(
      shellEnvelope({
        agent_session_id: 'agent-1',
        command: 'echo hi',
        exit_code: 0,
        exited_by: 'normal_exit',
        duration_ms: 12,
        output_file_path: '/tmp/out.log',
        cwd: '/tmp/work',
      }),
    );
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    const expected =
      'A background command completed while you were doing other work:\n\n' +
      '<task-notification>\n' +
      '<agent-session-id>agent-1</agent-session-id>\n' +
      '<command>echo hi</command>\n' +
      '<exit-code>0</exit-code>\n' +
      '<exited-by>normal_exit</exited-by>\n' +
      '<duration-ms>12</duration-ms>\n' +
      '<output-file>/tmp/out.log</output-file>\n' +
      '<cwd>/tmp/work</cwd>\n' +
      '</task-notification>\n\n' +
      'Read the output-file path if you need to see the full output.';
    expect(prompt).toBe(expected);
  });

  it('signal kill + killed_reason：渲染 <killed-reason> 行 + exit-code=null', () => {
    const queue = makeQueue();
    queue.enqueue(
      shellEnvelope({
        exit_code: null,
        exited_by: 'signal',
        killed_reason: 'hard_timeout',
      }),
    );
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).toContain('<killed-reason>hard_timeout</killed-reason>\n<duration-ms>');
    expect(prompt).toContain('<exit-code>null</exit-code>');
  });

  it('多条 shell：复数前缀', () => {
    const queue = makeQueue();
    queue.enqueue(shellEnvelope({}, 's1'));
    queue.enqueue(shellEnvelope({}, 's2'));
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).toContain('2 background commands completed');
  });
});

// ─── 4. 未知 kind ─────────────────────────────────────────────────────

describe('composeNotificationPrompt: 未知 kind', () => {
  it('未知 kind 被 skip + onUnknownKind 回调', () => {
    const queue = makeQueue();
    queue.enqueue({
      kind: 'some-future-kind',
      target: { spaceId: 'space-1', threadId: THREAD },
      priority: 'later',
      enqueuedAt: 1_700_000_000_000,
      dedupKey: 'x',
      payload: {},
    });
    queue.enqueue(subagentEnvelope());

    const onUnknownKind = vi.fn();
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD), {
      onUnknownKind,
    });

    expect(onUnknownKind).toHaveBeenCalledTimes(1);
    expect(onUnknownKind).toHaveBeenCalledWith(['some-future-kind'], 1);
    // 未知项不进 prompt，已知 subagent 项仍合成
    expect(prompt).toContain('<subagent-run-id>child-uuid-1234</subagent-run-id>');
    expect(prompt).not.toContain('some-future-kind');
  });

  it('全部未知 kind → 空字符串', () => {
    const prompt = composeNotificationPrompt([
      {
        kind: 'unknown',
        target: { spaceId: 's', threadId: THREAD },
        priority: 'later',
        enqueuedAt: 0,
        payload: {},
      },
    ]);
    expect(prompt).toBe('');
  });
});

// ─── 6. buildSubagentCompletionEnvelope（S5 producer 端）────────────────

describe('buildSubagentCompletionEnvelope: 子完成 envelope 构造', () => {
  it('补 parent_thread_id + target + dedupKey + kind，end-to-end enqueue→drain→compose', () => {
    const queue = makeQueue();
    const env = buildSubagentCompletionEnvelope(
      {
        subagent_run_id: 'child-xyz',
        label: '后台调研',
        status: 'completed',
        summary: '推荐方案 B',
        duration_ms: 3300,
        step_count: 5,
        run_id: 'dispatcher-run',
        tool_call_id: 'toolu-dispatch',
      },
      { spaceId: 'space-1', threadId: THREAD, enqueuedAt: 1_700_000_000_000 },
    );

    expect(env.kind).toBe(SUBAGENT_NOTIFICATION_KIND);
    expect(env.target).toEqual({ spaceId: 'space-1', threadId: THREAD });
    expect(env.priority).toBe('later');
    expect(env.dedupKey).toBe('child-xyz');
    expect(env.payload.parent_thread_id).toBe(THREAD);

    // 真实 enqueue → drain → compose（与 host 链路一致）
    expect(queue.enqueue(env)).toBe(true);
    const items = queue.drainByThreadId(THREAD);
    const prompt = composeNotificationPrompt(items);
    expect(prompt).toContain('<subagent-run-id>child-xyz</subagent-run-id>');
    expect(prompt).toContain('<status>completed</status>');
    expect(prompt).toContain('<run-id>dispatcher-run</run-id>');
    expect(prompt).toContain('<tool-call-id>toolu-dispatch</tool-call-id>');
    expect(prompt).toContain('推荐方案 B');
  });

  it('dedup：同 childId 第二次 enqueue 返回 false（防完成回调边角 race 重复入队）', () => {
    const queue = makeQueue();
    const mk = () =>
      buildSubagentCompletionEnvelope(
        { subagent_run_id: 'dup-1', label: 'x', status: 'completed', summary: 's', duration_ms: 1 },
        { spaceId: 'space-1', threadId: THREAD, enqueuedAt: 1_700_000_000_000 },
      );
    expect(queue.enqueue(mk())).toBe(true);
    expect(queue.enqueue(mk())).toBe(false);
  });
});

// ─── 5. XML 转义 ──────────────────────────────────────────────────────

describe('composeNotificationPrompt: XML 转义', () => {
  it('subagent summary 里的特殊字符被转义', () => {
    const queue = makeQueue();
    queue.enqueue(
      subagentEnvelope({
        label: 'a<b>&"c\'',
        summary: 'result: x < y && z > 0',
      }),
    );
    const prompt = composeNotificationPrompt(queue.drainByThreadId(THREAD));
    expect(prompt).toContain('<label>a&lt;b&gt;&amp;&quot;c&apos;</label>');
    expect(prompt).toContain('result: x &lt; y &amp;&amp; z &gt; 0');
  });
});

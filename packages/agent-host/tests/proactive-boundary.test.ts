/**
 * PRD 06 §5.5.3：Proactive Report 消息形态边界断言。
 *
 * **历史背景**：阶段 2.1（2026-05-20）proactive-report.ts 的 hook / throttle /
 * consume 整条链路下线（0 production caller，详见模块文件头）。本测试文件
 * 同步收敛为「只测 formatProactiveReportMessage 输出形态」+「telemetry 事件常量」。
 *
 * 覆盖：
 *   Part 1 — Prompt 软约束（删）
 *     PROACTIVE_REPORT_RULES 常量已物理下线。
 *
 *   Part 2 — Telemetry 事件 schema
 *     1. PROACTIVE_REPORT 事件常量值正确
 *     2. 事件名遵循 namespace.action 命名规则
 *
 *   Part 3 — formatProactiveReportMessage 输出边界（最强：不能含 tool_use / JSON tool call
 *            / 执行指令 / code block，防止 LLM 误解汇报为可执行内容）
 *     3. 输出不含 XML tool_use 标记
 *     4. 输出不含 JSON tool call 结构
 *     5. 输出不含执行指令关键词
 *     6. 输出是纯文本（无 ``` code block）
 *     7. 空输入 → 空字符串
 *
 *   Part 4 — 节流软边界（删）
 *     节流状态机已下线。
 *
 *   Part 5 — 状态 A（删）
 *     在线对话中的 hook 链路已下线。
 *
 *   Part 6 — 批量积压 pending 消费（冷启动场景的文本输出）
 *     8. 批量 pending → 汇报消息以 [SYSTEM NOTIFICATION] 开头
 *     9. 8 任务批量 → 含 "6 succeeded, 2 failed" 统计行
 *    10. 三种终态混合 → [OK] + [FAILED] + some encountered issues
 *
 *   Part 7 — crashed 状态分类
 *    11. crashed 状态格式化为 [CRASHED]
 *    12. 混合 crashed + completed + failed → 统计正确
 *    13. crashed 计入失败统计（输出含 "1 succeeded, 1 failed"）
 *    14. 全 crashed → 标题含 all encountered issues
 *    15. crashed + error 混合 → [CRASHED] + [FAILED] 并存
 */

import { describe, expect, it } from 'vitest';
import { formatProactiveReportMessage } from '../src/delivery/proactive-report-message.js';
import type { PendingSubtaskInfo } from '../src/delivery/proactive-report-message.js';
import { TelemetryEvents } from '@tabtin/agent-runtime';

let pendingSeq = 0;
function makePending(overrides: Partial<PendingSubtaskInfo> = {}): PendingSubtaskInfo {
  return {
    runId: `run-boundary-${++pendingSeq}`,
    displayName: '翻译员 · a1b2 · 翻译文档',
    shortId: 'a1b2',
    status: 'completed',
    task: '翻译第 3 份文档',
    summary: '已完成翻译，共 1200 字',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Part 2 — Telemetry 事件 schema
// ═══════════════════════════════════════════════════════════════════════

describe('proactive-boundary: telemetry 事件', () => {
  it('PROACTIVE_REPORT 值为 proactive_report.consumed', () => {
    expect(TelemetryEvents.PROACTIVE_REPORT).toBe('proactive_report.consumed');
  });

  it('事件名遵循 namespace.action 命名规则', () => {
    const name = TelemetryEvents.PROACTIVE_REPORT;
    expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 3 — formatProactiveReportMessage 输出边界
// ═══════════════════════════════════════════════════════════════════════

describe('proactive-boundary: formatProactiveReportMessage 输出边界', () => {
  const sampleTasks: PendingSubtaskInfo[] = [
    makePending({ runId: 'r1', status: 'completed', summary: '已翻译完毕' }),
    makePending({ runId: 'r2', status: 'failed', errorMessage: 'API 限流' }),
    makePending({ runId: 'r3', status: 'error', errorMessage: '内部错误' }),
    makePending({ runId: 'r4', status: 'crashed' }),
  ];

  it('输出不含 XML tool_use 标记', () => {
    const msg = formatProactiveReportMessage(sampleTasks);
    expect(msg).not.toContain('<tool_use>');
    expect(msg).not.toContain('</tool_use>');
    expect(msg).not.toContain('<invoke>');
  });

  it('输出不含 JSON tool call 结构', () => {
    const msg = formatProactiveReportMessage(sampleTasks);
    expect(msg).not.toContain('"type": "function"');
    expect(msg).not.toContain('"function_call"');
    expect(msg).not.toContain('"tool_calls"');
  });

  it('输出不含执行指令关键词', () => {
    const msg = formatProactiveReportMessage(sampleTasks);
    expect(msg).not.toContain('Execute:');
    expect(msg).not.toContain('Run command:');
  });

  it('输出是纯文本（无 ``` code block）', () => {
    const msg = formatProactiveReportMessage(sampleTasks);
    expect(msg).not.toContain('```');
  });

  it('空列表 → 空字符串', () => {
    expect(formatProactiveReportMessage([])).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 6 — 批量积压 pending（冷启动场景的文本输出）
// ═══════════════════════════════════════════════════════════════════════

describe('proactive-boundary: 批量积压 pending（冷启动文本输出）', () => {
  it('批量 pending → 汇报消息以 [SYSTEM NOTIFICATION] 开头', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r-b1', status: 'completed', summary: '翻译完毕' }),
      makePending({ runId: 'r-b2', status: 'failed', errorMessage: '超时' }),
    ]);
    expect(msg).toMatch(/^\[SYSTEM NOTIFICATION\]/);
  });

  it('模拟离线积累 8 任务 → 文本含 "6 succeeded, 2 failed"', () => {
    const offlineTasks = Array.from({ length: 8 }, (_, i) =>
      makePending({
        runId: `r-offline-${i}`,
        displayName: `翻译员 · ${i.toString(16).padStart(4, '0')} · 翻译文档 ${i + 1}`,
        status: i < 6 ? 'completed' : 'failed',
        summary: i < 6 ? `文档 ${i + 1} 翻译完毕` : undefined,
        errorMessage: i >= 6 ? 'API 限流' : undefined,
      }),
    );
    const msg = formatProactiveReportMessage(offlineTasks);
    expect(msg).toContain('6 succeeded, 2 failed');
  });

  it('冷启动汇报包含 OK + FAILED 标签及部分失败提示', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r-ok', status: 'completed', summary: '成功' }),
      makePending({ runId: 'r-fail', status: 'failed', errorMessage: '失败' }),
      makePending({ runId: 'r-err', status: 'error', errorMessage: '错误' }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain('some encountered issues');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Part 7 — crashed 状态分类
// ═══════════════════════════════════════════════════════════════════════

describe('proactive-boundary: crashed 状态处理', () => {
  it('crashed 状态格式化为 [CRASHED]', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r-crash', status: 'crashed' }),
    ]);
    expect(msg).toContain('[CRASHED]');
  });

  it('混合 crashed + completed + failed → 统计正确', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r1', status: 'completed', summary: 'ok' }),
      makePending({ runId: 'r2', status: 'crashed' }),
      makePending({ runId: 'r3', status: 'failed', errorMessage: 'err' }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('[CRASHED]');
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain('1 succeeded, 2 failed');
  });

  it('crashed 计入失败统计（1 crashed + 1 completed → "1 succeeded, 1 failed"）', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r-c1', status: 'crashed' }),
      makePending({ runId: 'r-c2', status: 'completed', summary: 'ok' }),
    ]);
    expect(msg).toContain('1 succeeded, 1 failed');
  });

  it('全 crashed → 标题含 all encountered issues', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r1', status: 'crashed' }),
      makePending({ runId: 'r2', status: 'crashed' }),
    ]);
    expect(msg).toContain('all encountered issues');
    expect(msg).toContain('all failed');
  });

  it('crashed + error 混合 → 统一归入失败（[CRASHED] + [FAILED] 并存）', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r1', status: 'crashed' }),
      makePending({ runId: 'r2', status: 'error', errorMessage: 'db down' }),
    ]);
    expect(msg).toContain('all encountered issues');
    expect(msg).toContain('[CRASHED]');
    expect(msg).toContain('[FAILED]');
  });
});

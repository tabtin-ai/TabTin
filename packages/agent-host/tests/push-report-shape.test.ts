/**
 * PRD 06 §5.5.3：Push 汇报消息形态测试。
 *
 * 覆盖：
 *   1. 成功任务带 [成功] 标签 + 摘要
 *   2. 失败任务带 [失败] 标签 + 错误信息
 *   3. error 状态视同失败
 *   4. 多任务聚合 — 统计行正确
 *   5. 空列表 → 空字符串
 *   6. 成功但无摘要 — 不展示摘要行
 *   7. 失败但无错误信息 — 不展示错误行
 *   8. 消息以 [SYSTEM NOTIFICATION] 前缀开头
 *   9. 消息包含任务计数总结
 *  10. 单任务场景
 *  11. 全成功 — 标题"已完成" + 统计行"全部完成"
 *  12. 全失败 — 标题"全部遇到问题" + 统计行"全部失败"
 *  13. 混合 — 标题"部分任务遇到问题" + 分项统计
 *  14. crashed 状态格式化为 [异常终止]
 *  15. 10 个任务 — 统计行和任务行数正确
 *  16. 100 个任务 — 大批量不崩溃且结构完整
 *  17. 空 task 字段 — 不影响输出
 *  18. 空 summary + 空 errorMessage — 只显示标签
 *  19. 极长 errorMessage — 不破坏格式结构
 *  20. 四种终态混合 — 全部正确分类
 */

import { describe, expect, it } from 'vitest';
import { formatProactiveReportMessage } from '../src/delivery/proactive-report-message.js';
import type { PendingSubtaskInfo } from '../src/delivery/proactive-report-message.js';

function make(overrides: Partial<PendingSubtaskInfo> = {}): PendingSubtaskInfo {
  return {
    runId: 'run-default',
    displayName: '分析员 · abcd · 分析数据',
    shortId: 'abcd',
    status: 'completed',
    task: '分析数据',
    ...overrides,
  };
}

describe('push-report-shape: formatProactiveReportMessage', () => {
  it('成功任务带 [成功] 标签 + 摘要', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'completed', summary: '昨日销售额 120 万' }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('Summary: 昨日销售额 120 万');
  });

  it('失败任务带 [FAILED] 标签 + 错误信息', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'failed', errorMessage: 'rate limit exceeded' }),
    ]);
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain('Error: rate limit exceeded');
  });

  it('error 状态视同失败', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'error', errorMessage: 'internal error' }),
    ]);
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain('Error: internal error');
  });

  it('多任务聚合 — 统计行正确', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', status: 'completed', summary: '完成了' }),
      make({ runId: 'r2', status: 'failed', errorMessage: '超时' }),
      make({ runId: 'r3', status: 'completed', summary: '也完成了' }),
      make({ runId: 'r4', status: 'error', errorMessage: '错了' }),
    ]);
    expect(msg).toContain('2 succeeded, 2 failed');
  });

  it('空列表 → 空字符串', () => {
    expect(formatProactiveReportMessage([])).toBe('');
  });

  it('成功但无摘要 — 不展示摘要行', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'completed', summary: undefined }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).not.toContain('Summary:');
  });

  it('失败但无错误信息 — 不展示错误行', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'failed', errorMessage: undefined }),
    ]);
    expect(msg).toContain('[FAILED]');
    expect(msg).not.toContain('Error:');
  });

  it('消息以 [SYSTEM NOTIFICATION] 前缀开头', () => {
    const msg = formatProactiveReportMessage([make()]);
    expect(msg).toMatch(/^\[SYSTEM NOTIFICATION\]/);
  });

  it('displayName 完整出现在输出中', () => {
    const msg = formatProactiveReportMessage([
      make({ displayName: '研究员 · 8c91 · 查竞品X' }),
    ]);
    expect(msg).toContain('研究员 · 8c91 · 查竞品X');
  });

  it('多行格式——每个任务一行起始用 -', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', displayName: 'A · 0001 · t1' }),
      make({ runId: 'r2', displayName: 'B · 0002 · t2' }),
    ]);
    const lines = msg.split('\n');
    const dashLines = lines.filter(l => l.startsWith('- '));
    expect(dashLines).toHaveLength(2);
  });

  // ─── 全成功 / 全失败 / 混合 场景分叉标题 ────────────────────────

  it('全成功 — 标题"已完成" + 统计"全部完成"', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', status: 'completed' }),
      make({ runId: 'r2', status: 'completed' }),
    ]);
    expect(msg).toContain('have completed');
    expect(msg).not.toContain('issues');
    expect(msg).toContain('all completed successfully');
    expect(msg).not.toContain('succeeded');
  });

  it('全失败 — 标题含 "all encountered issues" + 统计 "all failed"', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', status: 'failed', errorMessage: 'err1' }),
      make({ runId: 'r2', status: 'error', errorMessage: 'err2' }),
    ]);
    expect(msg).toContain('all encountered issues');
    expect(msg).toContain('all failed');
    expect(msg).not.toContain('succeeded');
  });

  it('混合 — 标题含 "some encountered issues" + 分项统计', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', status: 'completed', summary: 'ok' }),
      make({ runId: 'r2', status: 'failed', errorMessage: 'err' }),
    ]);
    expect(msg).toContain('some encountered issues');
    expect(msg).toContain('1 succeeded, 1 failed');
  });

  it('单任务全成功 — 统计不含零值', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'completed', summary: '完成' }),
    ]);
    expect(msg).toContain('all completed successfully');
    expect(msg).not.toContain('0 ');
  });

  // ─── crashed 状态 ─────────────────────────────────────────────────

  it('crashed 状态格式化为 [CRASHED]', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r-crash', status: 'crashed' }),
    ]);
    expect(msg).toContain('[CRASHED]');
    expect(msg).not.toContain('[OK]');
    expect(msg).not.toContain('[FAILED]');
  });

  // ─── 大批量场景 ───────────────────────────────────────────────────

  it('10 个任务 — 统计行和任务行数正确', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      make({
        runId: `r-${i}`,
        displayName: `Agent · ${i.toString(16).padStart(4, '0')} · task${i}`,
        status: i < 7 ? 'completed' : 'failed',
        summary: i < 7 ? `结果 ${i}` : undefined,
        errorMessage: i >= 7 ? `错误 ${i}` : undefined,
      }),
    );
    const msg = formatProactiveReportMessage(tasks);

    expect(msg).toContain('7 succeeded, 3 failed');
    const dashLines = msg.split('\n').filter(l => l.startsWith('- '));
    expect(dashLines).toHaveLength(10);
  });

  it('100 个任务 — 大批量不崩溃且结构完整', () => {
    const tasks = Array.from({ length: 100 }, (_, i) =>
      make({
        runId: `r-${i}`,
        displayName: `W · ${i.toString(16).padStart(4, '0')} · job${i}`,
        status: i < 80 ? 'completed' : 'failed',
        summary: i < 80 ? `done ${i}` : undefined,
        errorMessage: i >= 80 ? `err ${i}` : undefined,
      }),
    );
    const msg = formatProactiveReportMessage(tasks);

    expect(msg).toContain('80 succeeded, 20 failed');
    expect(msg).toMatch(/^\[SYSTEM NOTIFICATION\]/);
    const dashLines = msg.split('\n').filter(l => l.startsWith('- '));
    expect(dashLines).toHaveLength(100);
  });

  // ─── 边界场景 ─────────────────────────────────────────────────────

  it('空 task 字段 — 不影响输出', () => {
    const msg = formatProactiveReportMessage([
      make({ task: '', status: 'completed', summary: '完成' }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('Summary: 完成');
  });

  it('同时无 summary 和 errorMessage — 只显示标签行', () => {
    const msg = formatProactiveReportMessage([
      make({ status: 'completed', summary: undefined }),
      make({ runId: 'r2', status: 'failed', errorMessage: undefined }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('[FAILED]');
    expect(msg).not.toContain('Summary:');
    expect(msg).not.toContain('Error:');
  });

  it('极长 errorMessage — 不破坏格式结构', () => {
    const longError = 'A'.repeat(2000);
    const msg = formatProactiveReportMessage([
      make({ status: 'failed', errorMessage: longError }),
    ]);
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain(`Error: ${longError}`);
    expect(msg).toMatch(/^\[SYSTEM NOTIFICATION\]/);
  });

  it('四种终态混合 — 全部正确分类', () => {
    const msg = formatProactiveReportMessage([
      make({ runId: 'r1', status: 'completed', summary: 'ok' }),
      make({ runId: 'r2', status: 'failed', errorMessage: 'fail' }),
      make({ runId: 'r3', status: 'error', errorMessage: 'err' }),
      make({ runId: 'r4', status: 'crashed' }),
    ]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('[FAILED]');
    expect(msg).toContain('[CRASHED]');
    expect(msg).toContain('1 succeeded, 3 failed');
  });
});

/**
 * PRD 06 §5.5.3：proactive-report 模块核心功能测试。
 *
 * 模块当前唯一活路径是 `formatProactiveReportMessage`（被 ElectronAgentHost 冷启动
 * 汇报使用）；hook / throttle / consume 链路已于阶段 2.1（2026-05-20）
 * 物理下线，对应测试 describe 同步删除（详见模块文件头）。
 *
 * 覆盖：
 *   1. buildReportMessage 等死链路场景已下线，只保留 formatProactiveReportMessage
 *      + telemetry 事件常量两个活路径断言
 *   2. 更全面的 formatProactiveReportMessage 输出边界 / 状态分类断言在
 *      `proactive-boundary.test.ts` 和 `push-report-shape.test.ts` 里。
 */

import { describe, expect, it } from 'vitest';
import { formatProactiveReportMessage } from '../src/delivery/proactive-report-message.js';
import type { PendingSubtaskInfo } from '../src/delivery/proactive-report-message.js';
import { TelemetryEvents } from '@tabtin/agent-runtime';

function makePending(overrides: Partial<PendingSubtaskInfo> = {}): PendingSubtaskInfo {
  return {
    runId: 'run-1',
    displayName: '数据分析员 · 4f2a · 分析昨销售',
    shortId: '4f2a',
    status: 'completed',
    task: '分析昨天销售数据',
    summary: '昨日销售额 120 万，环比增长 15%',
    ...overrides,
  };
}

describe('proactive-report: formatProactiveReportMessage 基本结构', () => {
  it('单成功任务 → 含 [OK] + summary + 总计行', () => {
    const msg = formatProactiveReportMessage([makePending()]);
    expect(msg).toContain('[OK]');
    expect(msg).toContain('Summary: 昨日销售额 120 万');
    expect(msg).toContain('Total: 1 task(s)');
  });

  it('多任务混合 → 标题为 "some encountered issues" + 分项统计', () => {
    const msg = formatProactiveReportMessage([
      makePending({ runId: 'r1', status: 'completed', summary: '完成了' }),
      makePending({ runId: 'r2', status: 'failed', errorMessage: 'rate limit' }),
    ]);
    expect(msg).toContain('some encountered issues');
    expect(msg).toContain('Error: rate limit');
    expect(msg).toContain('1 succeeded, 1 failed');
  });

  it('空列表 → 空字符串（ElectronAgentHost 据此跳过推送）', () => {
    expect(formatProactiveReportMessage([])).toBe('');
  });
});

describe('proactive-report: telemetry', () => {
  // 阶段 2.1 (2026-05-20): 删除 PROACTIVE_REPORT_RULES 断言（常量已物理下线）
  it('TelemetryEvents.PROACTIVE_REPORT 存在', () => {
    expect(TelemetryEvents.PROACTIVE_REPORT).toBe('proactive_report.consumed');
  });
});

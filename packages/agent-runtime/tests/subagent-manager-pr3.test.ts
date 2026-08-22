/**
 * SubagentManager PR3 单测（S6 reportProgress + getStatus 扩展 / S7 waitUntilSettled）。
 *
 * 覆盖：
 *   - reportProgress：更新 getStatus 的 stepCount / latestTool；未登记 / disposed → no-op。
 *   - waitUntilSettled：未登记立即 true；登记中注销后 resolve true；一直登记则超时 false。
 */

import { describe, it, expect } from 'vitest';
import { SubagentManager } from '../src/session/subagent-manager.js';

// ─── S6：reportProgress + getStatus 扩展 ──────────────────────────────

describe('SubagentManager.reportProgress（S6）', () => {
  it('回填 stepCount / latestTool，getStatus 读得到', () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.registerRun('c', new AbortController(), { label: '调研', state: 'active' });

    // 初始无进度
    expect(mgr.getStatus('c')?.stepCount).toBeUndefined();
    expect(mgr.getStatus('c')?.latestTool).toBeUndefined();

    mgr.reportProgress('c', { stepCount: 1, latestTool: 'read_file' });
    expect(mgr.getStatus('c')?.stepCount).toBe(1);
    expect(mgr.getStatus('c')?.latestTool).toBe('read_file');

    // 只覆盖显式字段
    mgr.reportProgress('c', { stepCount: 2 });
    expect(mgr.getStatus('c')?.stepCount).toBe(2);
    expect(mgr.getStatus('c')?.latestTool).toBe('read_file');
  });

  it('未登记 / disposed → no-op 不抛', () => {
    const mgr = new SubagentManager({ parentThreadId: 't', log: () => {} });
    expect(() => mgr.reportProgress('ghost', { stepCount: 1 })).not.toThrow();
    expect(mgr.getStatus('ghost')).toBeUndefined();

    mgr.registerRun('c', new AbortController());
    mgr.dispose();
    expect(() => mgr.reportProgress('c', { stepCount: 1 })).not.toThrow();
  });
});

// ─── S7：waitUntilSettled ──────────────────────────────────────────────

describe('SubagentManager.waitUntilSettled（S7）', () => {
  it('未登记 → 立即 true', async () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    expect(await mgr.waitUntilSettled('nope', 1000)).toBe(true);
  });

  it('登记中 → 注销（run settle）后 resolve true', async () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    const unregister = mgr.registerRun('c', new AbortController());
    const p = mgr.waitUntilSettled('c', 2000, 10);
    // 模拟 run 收尾：unregister（= executeChildAgent finally 移除登记）
    setTimeout(() => unregister(), 40);
    expect(await p).toBe(true);
  });

  it('一直登记（run 卡住不 settle）→ 超时 false', async () => {
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.registerRun('c', new AbortController());
    expect(await mgr.waitUntilSettled('c', 80, 10)).toBe(false);
  });

  it('cancel 删登记表也算 settle（但 interrupt 路径用 cancelSubagent 不走这里）', async () => {
    // 文档化：manager.cancel 立刻删登记表 → waitUntilSettled 会提前 true。
    // 这正是 interrupt 路径**不**用 manager.cancel 而用 cancelSubagent 的原因
    // （让 settle 如实等到 run 自己的 finally 移除登记）。
    const mgr = new SubagentManager({ parentThreadId: 't' });
    mgr.registerRun('c', new AbortController());
    const p = mgr.waitUntilSettled('c', 2000, 10);
    setTimeout(() => mgr.cancel('c'), 30);
    expect(await p).toBe(true);
  });
});

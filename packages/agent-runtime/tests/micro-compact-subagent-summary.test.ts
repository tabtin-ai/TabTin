/**
 * FR-17.2：microCompactSubagentSummary — 子 Agent summary 微压缩测试。
 *
 * 设计要点：保头部 + 保尾部，让父 Agent 拿到子 Agent 的"任务范围 + 最终决策"
 * 两个核心信息源；中间用占位符省略。
 *
 * 关键验收（PRD §5.2 FR-17 决策"不丢关键信息"）：
 *   1. 短 summary 原样透传
 *   2. 长 summary 头部保留起始段（任务范围 / 起手交代）
 *   3. 长 summary 尾部保留结论段（交付物 / 问题）——注：截断是**格式无关**的，
 *      下方 fixture 用 "Scope/Files changed" 只是举个长报告的例子，不代表子 Agent
 *      被强制套这个格式（回报格式由主 Agent 任务指令逐场景决定）
 *   4. 占位符明确标注 truncated 字符数
 *   5. 自定义阈值生效
 *   6. 极小阈值的兜底（不至于 head + tail 总和大于 max 而 panic）
 */

import { describe, expect, it } from 'vitest';
import {
  microCompactSubagentSummary,
  SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS,
} from '../src/compact/subagent-summary.js';

describe('microCompactSubagentSummary (FR-17.2)', () => {
  it('短 summary 原样返回（不截断）', () => {
    const summary =
      'Scope: 检查首页性能\n' +
      'Result: 加载 1.2s 完成\n' +
      'Key files: src/pages/Home.tsx\n' +
      'Issues: none';
    const r = microCompactSubagentSummary(summary);
    expect(r.truncated).toBe(false);
    expect(r.summary).toBe(summary);
    expect(r.originalLength).toBe(summary.length);
    expect(r.newLength).toBe(summary.length);
    expect(r.maxChars).toBe(SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS);
  });

  it('长 summary 头尾保留关键信息，中间被截断', () => {
    // 构造一个 fork-boilerplate 风格的 summary：
    //   - 头部 "Scope: ..." + 早期发现
    //   - 中间 8000 字符的"调研过程"细节（应被截断）
    //   - 尾部 "Files changed / Issues" 关键决策
    const head = 'Scope: 全面 review @feature/x 模块\nResult: 发现 3 个潜在 bug\n';
    const middle = 'A'.repeat(20_000); // 一定超出 default max=10_000
    const tail =
      '\n\nFiles changed: src/foo.ts, src/bar.ts\n' +
      'Issues:\n' +
      '  - bug 1: race condition in init()\n' +
      '  - bug 2: missing await in handler\n' +
      '  - bug 3: incorrect error code\n';

    const summary = head + middle + tail;
    const r = microCompactSubagentSummary(summary);

    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(summary.length);
    expect(r.newLength).toBeLessThan(summary.length);

    // 头部保留 "Scope:" 起始段
    expect(r.summary).toContain('Scope: 全面 review');
    // 尾部保留 "Files changed" + "Issues" 决策
    expect(r.summary).toContain('Files changed: src/foo.ts');
    expect(r.summary).toContain('bug 3: incorrect error code');
    // 含 truncation 标记
    expect(r.summary).toContain('由 microCompactSubagentSummary 省略');
  });

  it('truncation 占位符报告正确的省略字符数', () => {
    const summary = 'X'.repeat(50_000);
    const r = microCompactSubagentSummary(summary);
    expect(r.truncated).toBe(true);
    // 占位符里应含一个等于 originalLength - newLength + 占位符自身长度 附近的数字
    // 严格断言：占位符字符数 = originalLength - head - tail
    const match = r.summary.match(/省略 (\d+) 个字符/);
    expect(match).toBeTruthy();
    const omitted = Number(match![1]);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBe(50_000 - 2_000 - 6_000); // head=2k tail=6k 默认
  });

  it('自定义 maxChars 生效（提高阈值后短 summary 不截断）', () => {
    const summary = 'X'.repeat(15_000);
    // 默认 10k 会截断
    expect(microCompactSubagentSummary(summary).truncated).toBe(true);
    // 提到 20k 不截断
    const r = microCompactSubagentSummary(summary, { maxChars: 20_000 });
    expect(r.truncated).toBe(false);
    expect(r.maxChars).toBe(20_000);
  });

  it('非法 maxChars（≤0 / NaN）回落默认', () => {
    const summary = 'X'.repeat(15_000);
    for (const bad of [0, -100, Number.NaN, Infinity]) {
      const r = microCompactSubagentSummary(summary, { maxChars: bad });
      expect(r.maxChars).toBe(SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS);
      expect(r.truncated).toBe(true);
    }
  });

  it('极小阈值（500）不 panic：head + tail 按比例缩小但仍各 ≥100', () => {
    const summary = 'A'.repeat(2_000) + 'TAIL_KEY';
    const r = microCompactSubagentSummary(summary, { maxChars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.summary).toContain('TAIL_KEY'); // 尾部最少 100 字符 → TAIL_KEY 必在
  });

  it('CJK summary > 30% 时自动放大 maxChars 1.5×（M3 修复）', () => {
    // 全中文 6000 字 → 12K 字符 → 默认 10K 会截断，但 CJK 放大到 15K → 不截断
    const summary = '测试'.repeat(6_000) + '尾部关键决策';
    const r = microCompactSubagentSummary(summary);
    expect(r.truncated).toBe(false);
    expect(r.maxChars).toBe(15_000); // 10K * 1.5
  });

  it('CJK summary 超过放大后阈值仍会截断 + 保留尾部关键决策', () => {
    // 20K 中文 → CJK 放大到 15K 仍超 → 截断
    const summary = '测试'.repeat(10_000) + '尾部关键决策';
    const r = microCompactSubagentSummary(summary);
    expect(r.truncated).toBe(true);
    expect(r.summary).toContain('尾部关键决策');
    expect(r.maxChars).toBe(15_000);
  });

  it('显式传 maxChars 时不再二次 CJK 放大（用户表达"我知道我要什么"）', () => {
    const summary = '测试'.repeat(6_000) + '尾部';
    const r = microCompactSubagentSummary(summary, { maxChars: 8_000 });
    expect(r.maxChars).toBe(8_000); // 不放大
    expect(r.truncated).toBe(true);
  });

  it('空字符串与空白', () => {
    expect(microCompactSubagentSummary('').truncated).toBe(false);
    expect(microCompactSubagentSummary('   ').truncated).toBe(false);
  });
});

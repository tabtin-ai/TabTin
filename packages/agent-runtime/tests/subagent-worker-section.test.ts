/**
 * ：worker 系统段的能力引导契约。
 *
 * SUBAGENT_WORKER_SYSTEM_SECTION 是 fork 注入、所有 worker（含 readonly/ask）
 * 唯一必看的段落——批量取证引导必须在这里，而不是只存在于仅主 Agent 可见的
 * <subagent_orchestration>（那是 2026-08-16 三端调研现场子 Agent 逐文件
 * read_file 125+ 步的根因，见  / ）。
 */
import { describe, expect, it } from 'vitest';
import { SUBAGENT_WORKER_SYSTEM_SECTION } from '../src/subagent/fork-query.js';

describe('SUBAGENT_WORKER_SYSTEM_SECTION', () => {
  it('包含批量只读取证引导（终端一步完成，不逐文件读取）', () => {
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('批量只读取证优先在终端一步完成');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('不要"一个文件调一次读取工具"');
  });

  it('如实描述落盘语义（超长截断可按路径恢复），不宣称无限完整保留', () => {
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('超长输出会截断并落盘');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).not.toContain('完整保留在你的历史里');
  });

  it('声明受限白名单例外（被拒退回专用工具，不反复重试）', () => {
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('只读白名单拒绝');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('不要反复重试组合命令');
  });

  it('保留 worker 行为契约（单次汇报、不再派发）', () => {
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('不要反问');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('不要再生成子 Agent');
  });

  it('默认短报告，把更多细节留给主 Agent 定向续跑', () => {
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('默认短报告');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('未决/不确定项');
    expect(SUBAGENT_WORKER_SYSTEM_SECTION).toContain('续跑你');
  });
});

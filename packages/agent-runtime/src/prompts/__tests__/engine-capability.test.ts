/**
 * E1 / 宪法 v0.1 §3.5——剩余 engine + capability prompts 的快照测试。
 *
 * 覆盖：
 *   - CONVERGENCE_HINT_WARNING / CONVERGENCE_HINT_ERROR（英文，CostCap 写入 system 的 token 压力 hint）
 *
 * 这些常量被快照锁定后，**任何修改都会触发 PR snapshot diff** 强制 reviewer
 * 注意改动——这是引擎内部 prompt 在 git 上的 review 入口（宪法 §3.5）。
 *
 * 阶段 2.1 (2026-05-20) 清理：删除 PROACTIVE_REPORT_RULES 段相关测试
 * （常量已物理下线，0 production caller，hook 注入路径从未接通）。
 *
 * 中英文边界：CONVERGENCE_HINT_* 中文（LLM system 指令）。
 */

import { describe, it, expect } from 'vitest';
import {
  CONVERGENCE_HINT_WARNING,
  CONVERGENCE_HINT_ERROR,
} from '../index.js';

// 阶段 2.1 (2026-05-20)：PROACTIVE_REPORT_RULES describe 块已删除
// （常量物理下线，hook 注入路径从未接通，0 production caller）

describe('capability convergence-hints — CostCap token 压力提示（中文）', () => {
  it('CONVERGENCE_HINT_WARNING snapshot (中文)', () => {
    expect(CONVERGENCE_HINT_WARNING).toMatchInlineSnapshot(
      `"[系统] 上下文空间有限。请优先完成当前任务，避免读取大文件或运行输出冗长的命令。"`,
    );
  });

  it('CONVERGENCE_HINT_ERROR snapshot (中文 + 必须/不要 强措辞)', () => {
    expect(CONVERGENCE_HINT_ERROR).toMatchInlineSnapshot(
      `"[系统] 上下文空间已严重不足。你必须立即完成当前工作，不要开启新的探索。现在就总结并交付结果。"`,
    );
  });

  it('both hints start with [系统] tag (CostCap 注入定位约定)', () => {
    expect(CONVERGENCE_HINT_WARNING.startsWith('[系统]')).toBe(true);
    expect(CONVERGENCE_HINT_ERROR.startsWith('[系统]')).toBe(true);
  });

  it('ERROR hint contains 必须 / 不要 (与 token-budget warning 阶梯一致)', () => {
    expect(CONVERGENCE_HINT_ERROR).toContain('必须');
    expect(CONVERGENCE_HINT_ERROR).toContain('不要');
  });
});

// ：MEDIA_IMAGE_CLI_INSTRUCTION 已随 CliCap 迁到宿主包
// （capabilities/media-image.ts）。runtime prompts 不再 re-export。
// 文案契约由宿主包 tests/cli.test.ts（含 `media image generate` 时注入
// `tabtin media image models --format json`）覆盖，本文件不再重复 snapshot。

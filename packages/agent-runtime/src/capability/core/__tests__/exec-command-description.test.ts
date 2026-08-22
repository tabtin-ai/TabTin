/**
 * `run_terminal_command` 工具描述 —— shell 无关（ 方案 2 / ）。
 *
 * shell 专属语法提示归口系统提示 `<shell_runtime>`。工具描述只保留功能说明与
 * 等待场景矩阵骨架，不得内嵌 bash / PowerShell / cmd 命令示例（否则会在
 * Windows 上盖过 `<shell_runtime>` 的 PowerShell 纪律）。
 */
import { describe, expect, it } from 'vitest';
import { buildExecCommandDescription } from '../shell.js';

describe('buildExecCommandDescription（shell 无关）', () => {
  it('无参数，返回稳定的纯功能描述', () => {
    const desc = buildExecCommandDescription();
    expect(desc.length).toBeGreaterThan(0);
    // 幂等：多次调用相同（不依赖运行时 shell）。
    expect(buildExecCommandDescription()).toBe(desc);
  });

  it('不再内联 shell 专属语法块（已收敛到 <shell_runtime> 段）', () => {
    const desc = buildExecCommandDescription();
    expect(desc).not.toContain('PowerShell');
    expect(desc).not.toContain('Set-Location');
    expect(desc).not.toContain('cmd.exe');
    expect(desc).not.toContain('%TABTIN_WORKSPACE%');
    // ：伪通用 bash 示例也禁止再出现在工具描述里。
    expect(desc).not.toContain('until curl');
    expect(desc).not.toContain('[[ ! -f');
    expect(desc).not.toContain('cd /path &&');
    expect(desc).not.toContain('$TABTIN_WORKSPACE');
  });

  it('等待场景矩阵仍指向 <shell_runtime> 与 pattern（P7 硬契约）', () => {
    const desc = buildExecCommandDescription();
    expect(desc).toContain('等待场景');
    expect(desc).toContain('pattern');
    expect(desc).toContain('<shell_runtime>');
  });
});

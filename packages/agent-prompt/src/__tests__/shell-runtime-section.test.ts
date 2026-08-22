/**
 * `<shell_runtime>` 段的 shell 身份注入（ 方案 2 / ）。
 *
 * 收敛后只声明 shell 身份 + 语法纪律（串联 / 切目录 / env 形态），不枚举具体
 * 等待命令配方。共享 cwd/env 条目按 shell 分支且与身份行去重；缺 shellInfo 时
 * 用 shell 中性文案（不回落 POSIX）。`run_terminal_command` 工具描述保持 shell
 * 无关（exec-command-description.test.ts）。
 */
import { describe, it, expect } from 'vitest';
import { buildShellRuntimeSection } from '../sections.js';
import type { RuntimeIdentity, PromptShellInfo } from '../types.js';

const IDENTITY: RuntimeIdentity = {
  spaceId: 'space',
  organizationId: 'organization',
  threadId: 'thread',
  workspaceRoot: '/ws',
  archiveDir: '/ws/archive',
  toolLogsDir: '/ws/tool-logs',
};

function info(kind: PromptShellInfo['kind'], shell: string): PromptShellInfo {
  return { kind, shell };
}

describe('buildShellRuntimeSection · shell 身份注入', () => {
  it('缺 identity → 空串（整组不注入）', () => {
    expect(buildShellRuntimeSection(undefined, info('zsh', '/bin/zsh'))).toBe('');
  });

  it('缺 shellInfo → 无身份行 + shell 中性 cwd（不回落 POSIX）', () => {
    const out = buildShellRuntimeSection(IDENTITY);
    expect(out).toContain('<shell_runtime>');
    expect(out).not.toContain('当前 shell');
    expect(out.split('\n')[1]).toContain('默认 cwd');
    expect(out).toContain('勿假设 bash/POSIX');
    expect(out).toContain('wait_ms');
    expect(out).toContain('环境变量');
    expect(out).toContain('workspace/');
    expect(out).not.toContain('cd /abs/path &&');
    expect(out).not.toContain('$TABTIN_WORKSPACE');
  });

  it('zsh（macOS 主路径）→ 声明 zsh 身份 + POSIX 语法，路径走 $TABTIN_WORKSPACE', () => {
    const out = buildShellRuntimeSection(IDENTITY, info('zsh', '/bin/zsh'));
    expect(out).toContain('当前 shell：zsh（`/bin/zsh`）');
    expect(out).toContain('POSIX shell 语法');
    expect(out).toContain('按上方身份行的切目录语法内联');
    expect(out).toContain('$TABTIN_WORKSPACE');
    expect(out).toContain('workspace/');
    expect(out).not.toContain('Test-Path');
    expect(out).not.toContain('%TABTIN_WORKSPACE%');
    expect(out).not.toContain('until ...; do ...; done');
    expect(out).not.toContain('while [ ! -f');
    // shared 不再重复写 cd /abs 配方
    expect(out).not.toContain('cd /abs/path &&');
  });

  it('bash（Linux）→ 声明 bash 身份', () => {
    const out = buildShellRuntimeSection(IDENTITY, info('bash', '/bin/bash'));
    expect(out).toContain('当前 shell：bash（`/bin/bash`）');
  });

  it('powershell（Windows）→ PS 语法纪律（无具体等待/读写命令配方、shared 不重复切目录）', () => {
    const out = buildShellRuntimeSection(IDENTITY, info('powershell', 'pwsh.exe'));
    expect(out).toContain('PowerShell（`pwsh.exe`），不是 bash');
    expect(out).toContain('Set-Location');
    expect(out).toContain('$env:TABTIN_WORKSPACE');
    expect(out).toContain('wait_ms');
    expect(out).toContain('bash 专属');
    expect(out).toContain('按上方身份行的切目录语法内联');
    expect(out).not.toContain('若写 shell 侧循环');
    expect(out).not.toContain('cd /abs/path &&');
    expect(out).not.toContain('cat $TABTIN_WORKSPACE');
    expect(out).not.toContain('Test-Path');
    expect(out).not.toContain('curl.exe');
    expect(out).not.toContain('Start-Sleep');
    expect(out).not.toContain('Get-Content');
    // shared 不再重复写 Set-Location 内联配方
    expect(out).not.toContain('Set-Location <path>; <cmd>');
  });

  it('cmd（Windows 兜底）→ cmd 语法纪律（shared 不重复 cd /d）', () => {
    const out = buildShellRuntimeSection(IDENTITY, info('cmd', 'C:\\Windows\\System32\\cmd.exe'));
    expect(out).toContain('cmd.exe');
    expect(out).toContain('cd /d');
    expect(out).toContain('%TABTIN_WORKSPACE%');
    expect(out).toContain('wait_ms');
    expect(out).toContain('bash 专属');
    expect(out).toContain('按上方身份行的切目录语法内联');
    expect(out).not.toContain('cd /abs/path &&');
    expect(out).not.toContain('cat $TABTIN_WORKSPACE');
    expect(out).not.toContain('timeout /t');
    expect(out).not.toContain('cd /d <path> && <cmd>` 内联');
  });

  it('shell 身份行排在 cwd 说明之前（第一条 bullet）', () => {
    const out = buildShellRuntimeSection(IDENTITY, info('zsh', '/bin/zsh'));
    const idxShell = out.indexOf('当前 shell');
    const idxCwd = out.indexOf('默认 cwd');
    expect(idxShell).toBeGreaterThan(-1);
    expect(idxCwd).toBeGreaterThan(idxShell);
  });
});

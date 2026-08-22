/**
 * ：Windows 终端兼容性单测（PowerShell 一等公民 + 进程树 kill + shell 归类）。
 *
 * 这些分支在 macOS/Linux 上靠「显式注入 platform / 显式传 shell 名」验证——
 * getSpawnCommand 现按 shell 类别路由（不再用 process.platform 门控），
 * 所以在任意平台都能验 PS/cmd 分支。真机 Windows 的 taskkill 真杀、pwsh 发现、
 * pwsh 发现仍是已知验证缺口；PS5.1 native stdin 编码由本文件在 Windows 真机覆盖。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyShellKind,
  resolveAgentShellInfo,
  killProcessTreeByPid,
  getSpawnCommand,
} from '../src/agent-process-runner.js';

describe('classifyShellKind', () => {
  it('PowerShell：pwsh / powershell（含 .exe / 大小写）→ powershell', () => {
    expect(classifyShellKind('pwsh.exe')).toBe('powershell');
    expect(classifyShellKind('C:/Program Files/PowerShell/7/pwsh.exe')).toBe('powershell');
    expect(classifyShellKind('powershell.exe')).toBe('powershell');
    expect(classifyShellKind('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.EXE')).toBe('powershell');
  });

  it('cmd → cmd', () => {
    expect(classifyShellKind('cmd.exe')).toBe('cmd');
    expect(classifyShellKind('C:/Windows/System32/cmd.exe')).toBe('cmd');
  });

  it('POSIX shells 各归其类', () => {
    expect(classifyShellKind('/bin/bash')).toBe('bash');
    expect(classifyShellKind('/bin/zsh')).toBe('zsh');
    expect(classifyShellKind('/bin/sh')).toBe('sh');
    expect(classifyShellKind('/usr/bin/fish')).toBe('other');
  });
});

describe('resolveAgentShellInfo（按注入 platform）', () => {
  it('darwin → /bin/zsh（kind zsh）', () => {
    const info = resolveAgentShellInfo('darwin');
    expect(info.platform).toBe('darwin');
    expect(info.kind).toBe('zsh');
  });

  it('linux → POSIX shell（非 Windows shell）', () => {
    // 注：若测试机设了 SHELL（如 /bin/zsh），会被优先采纳——这是预期行为
    // （用户 SHELL 覆盖平台默认）。这里只断言落在 POSIX 类、绝不会是 cmd/powershell。
    const info = resolveAgentShellInfo('linux');
    expect(info.platform).toBe('linux');
    expect(['bash', 'sh', 'zsh']).toContain(info.kind);
  });
});

describe('getSpawnCommand：按 shell 类别路由（ 去 process.platform 门控）', () => {
  it('pwsh → -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command + PS 脚本', () => {
    const { file, args } = getSpawnCommand('pwsh.exe', 'echo hi', 'C:/cwd.txt');
    expect(file).toBe('pwsh.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    //  新增：避免受限执行策略拦截内联脚本
    const epIdx = args.indexOf('-ExecutionPolicy');
    expect(epIdx).toBeGreaterThanOrEqual(0);
    expect(args[epIdx + 1]).toBe('Bypass');
    const cmdIdx = args.indexOf('-Command');
    expect(cmdIdx).toBeGreaterThan(epIdx);
    expect(args[cmdIdx + 1]).toContain('$__tabtin_agent_status');
  });

  it('powershell.exe（PS5.1）同样走 PS 分支', () => {
    const { args } = getSpawnCommand('powershell.exe', 'echo hi', 'C:/cwd.txt');
    expect(args).toContain('-ExecutionPolicy');
    expect(args).toContain('-Command');
    expect(args[args.indexOf('-Command') + 1]).toContain(
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    );
  });

  it('cmd.exe → /d /s /c + cmd 脚本', () => {
    const { file, args } = getSpawnCommand('cmd.exe', 'echo hi', 'C:/cwd.txt');
    expect(file).toBe('cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  });

  it('bash → -lc；sh → -c', () => {
    const bash = getSpawnCommand('/bin/bash', 'echo hi', '/tmp/c');
    expect(bash.args[0]).toBe('-lc');
    expect(bash.args.join('\n')).not.toContain('$OutputEncoding');
    expect(getSpawnCommand('/bin/zsh', 'echo hi', '/tmp/c').args[0]).toBe('-lc');
    expect(getSpawnCommand('/bin/sh', 'echo hi', '/tmp/c').args[0]).toBe('-c');
  });
});

describe.skipIf(process.platform !== 'win32')('PowerShell 5.1 native stdin 编码', () => {
  it('中文通过管道传给 native process 时保持 UTF-8', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-powershell-utf8-'));
    const cwdFilePath = path.join(tempDir, 'cwd.txt');
    const escapedNodePath = process.execPath.replace(/'/g, "''");
    const command = `@'\n天气预报\n'@ | & '${escapedNodePath}' -e "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(s))"`;
    const { file, args } = getSpawnCommand('powershell.exe', command, cwdFilePath);

    try {
      const result = spawnSync(file, args, { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).toBe('天气预报\n');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('killProcessTreeByPid', () => {
  it('非法 pid（undefined / 0 / 负数）→ no-op 不抛', () => {
    expect(() => killProcessTreeByPid(undefined, 'SIGTERM')).not.toThrow();
    expect(() => killProcessTreeByPid(0, 'SIGTERM')).not.toThrow();
    expect(() => killProcessTreeByPid(-5, 'SIGKILL')).not.toThrow();
  });

  it('POSIX：不存在的 pid → catch 静默不抛', () => {
    // 极大 pid 几乎不可能存在；process.kill 抛 ESRCH/EPERM 都被吞掉。
    expect(() => killProcessTreeByPid(2_147_483_646, 'SIGTERM', 'linux')).not.toThrow();
  });

  it('win32：构造 taskkill 调用不抛（真杀行为为真机验证缺口）', () => {
    // 注入 platform='win32'：在非 Windows 上 spawn(taskkill) 会触发 error 事件
    // （已 .on(error) 吞掉），同步路径不应抛。
    expect(() => killProcessTreeByPid(2_147_483_646, 'SIGTERM', 'win32')).not.toThrow();
    expect(() => killProcessTreeByPid(2_147_483_646, 'SIGKILL', 'win32')).not.toThrow();
  });
});

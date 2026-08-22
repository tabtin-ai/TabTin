/**
 * Layer 2 退出码 sidecar 单测（终端假运行根治 v3 / 治 F9）。
 *
 * 覆盖：
 *   1. 脚本生成（posix / powershell / cmd）—— 传 statusFilePath 时含退出码落盘行、
 *      不传时**完全不写** statusfile（前台路径行为不变）。
 *   2. 真实 spawn（posix）—— statusfile 落到盘上、内容 = 真实退出码（0 / 非 0 / 127）。
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnAgentShellProcess } from '../src';
import {
  buildPosixScript,
  buildPowerShellScript,
  buildCmdScript,
  getSpawnCommand,
} from '../src/agent-process-runner.js';

describe('Layer 2 sidecar 脚本生成', () => {
  it('buildPosixScript：传 statusFilePath → 含 echo $? 落盘行（在 exit 之前）', () => {
    const script = buildPosixScript('echo hi', '/tmp/cwd.txt', '/tmp/sess.status');
    expect(script).toContain("echo $__tabtin_agent_status > '/tmp/sess.status'");
    // 与 pwd 探针对称、且在 `exit $__tabtin_agent_status` 之前
    const statusIdx = script.indexOf('echo $__tabtin_agent_status >');
    const exitIdx = script.lastIndexOf('exit $__tabtin_agent_status');
    expect(statusIdx).toBeGreaterThan(0);
    expect(statusIdx).toBeLessThan(exitIdx);
  });

  it('buildPosixScript：不传 statusFilePath → 不写 statusfile（行为不变）', () => {
    const script = buildPosixScript('echo hi', '/tmp/cwd.txt');
    expect(script).not.toContain('echo $__tabtin_agent_status >');
    expect(script).toContain('exit $__tabtin_agent_status');
  });

  it('buildPosixScript：statusFilePath 含单引号 → 被安全转义', () => {
    const script = buildPosixScript('echo hi', '/tmp/cwd.txt', "/tmp/a'b.status");
    // shellQuote 把 ' → '\'' ；不应出现裸单引号注入
    expect(script).toContain(`'/tmp/a'\\''b.status'`);
  });

  it('buildPowerShellScript：传 statusFilePath → 含 Set-Content 落盘退出码', () => {
    const script = buildPowerShellScript('echo hi', 'C:/cwd.txt', 'C:/sess.status');
    expect(script).toContain("$__tabtin_agent_status | Set-Content -LiteralPath 'C:/sess.status'");
    expect(script.indexOf("$__tabtin_agent_status | Set-Content")).toBeLessThan(
      script.lastIndexOf('exit $__tabtin_agent_status'),
    );
  });

  it('buildPowerShellScript：不传 → 不写 statusfile', () => {
    const script = buildPowerShellScript('echo hi', 'C:/cwd.txt');
    expect(script).not.toContain('$__tabtin_agent_status | Set-Content');
  });

  it('buildCmdScript：传 statusFilePath → 重定向前置 `>"file" echo %var%`（防 cmd 句柄重定向 bug）', () => {
    const script = buildCmdScript('echo hi', 'C:/cwd.txt', 'C:/sess.status');
    expect(script).toContain('>"C:/sess.status" echo %__tabtin_agent_status%');
    // 绝不能出现 `echo %var%>`（数字紧贴 > 会被当成句柄重定向 → 写空/残缺）
    expect(script).not.toContain('echo %__tabtin_agent_status%>');
  });

  it('buildCmdScript：不传 → 不写 statusfile', () => {
    const script = buildCmdScript('echo hi', 'C:/cwd.txt');
    expect(script).not.toContain('echo %__tabtin_agent_status%');
  });

  it('getSpawnCommand：把 statusFilePath 透传进 posix 脚本 args', () => {
    const { args } = getSpawnCommand('/bin/zsh', 'echo hi', '/tmp/cwd.txt', '/tmp/s.status');
    const joined = args.join('\n');
    expect(joined).toContain("echo $__tabtin_agent_status > '/tmp/s.status'");
  });
});

describe.skipIf(process.platform === 'win32')('Layer 2 sidecar 真实 spawn 落盘', () => {
  async function runWithStatusfile(command: string): Promise<{ statusContent: string | null; exitCode: number | null }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-sidecar-'));
    const statusFilePath = path.join(dir, 'sess.status');
    const handle = spawnAgentShellProcess({ command, statusFilePath });
    const result = await handle.result;
    let statusContent: string | null = null;
    try {
      statusContent = fs.readFileSync(statusFilePath, 'utf8').trim();
    } catch {
      statusContent = null;
    }
    if (result.outputFilePath) {
      try { fs.unlinkSync(result.outputFilePath); } catch { /* ignore */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { statusContent, exitCode: result.exitCode };
  }

  it('成功命令 → statusfile 写 0', async () => {
    const { statusContent, exitCode } = await runWithStatusfile(`printf 'ok\\n'`);
    expect(exitCode).toBe(0);
    expect(statusContent).toBe('0');
  });

  it('非 0 退出（子 shell 不提前杀父）→ statusfile 写真实码', async () => {
    const { statusContent, exitCode } = await runWithStatusfile('(exit 7)');
    expect(exitCode).toBe(7);
    expect(statusContent).toBe('7');
  });

  it('command not found → statusfile 写 127', async () => {
    const { statusContent } = await runWithStatusfile('tabtin_no_such_command_xyz_98765');
    expect(statusContent).toBe('127');
  });

  it('不传 statusFilePath → 不创建 statusfile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-sidecar-none-'));
    const wouldBe = path.join(dir, 'sess.status');
    const handle = spawnAgentShellProcess({ command: `printf 'ok\\n'` });
    const result = await handle.result;
    expect(fs.existsSync(wouldBe)).toBe(false);
    if (result.outputFilePath) {
      try { fs.unlinkSync(result.outputFilePath); } catch { /* ignore */ }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

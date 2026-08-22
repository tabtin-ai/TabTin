import { describe, it, expect } from 'vitest';
import { isShellCommandWriteOp } from '../src/shell-command-side-effect.js';

describe('isShellCommandWriteOp', () => {
  it('只读管道 → false', () => {
    expect(isShellCommandWriteOp(
      "grep -n '融资' ~/.tabtin/cli-outputs/a.json | head -40",
    )).toBe(false);
  });

  it('cat / jq / rg → false', () => {
    expect(isShellCommandWriteOp('cat /tmp/a')).toBe(false);
    expect(isShellCommandWriteOp("jq '.data' /tmp/a.json")).toBe(false);
    expect(isShellCommandWriteOp('rg foo src')).toBe(false);
  });

  it('PowerShell 只读 cmdlet / alias → false', () => {
    expect(isShellCommandWriteOp('Get-Content C:\\Windows\\win.ini')).toBe(false);
    expect(isShellCommandWriteOp('Get-ChildItem C:\\Windows | Select-String System')).toBe(false);
    expect(isShellCommandWriteOp('gci C:\\Windows')).toBe(false);
  });

  it('stdout 重定向 → true', () => {
    expect(isShellCommandWriteOp('echo hi > /tmp/a')).toBe(true);
    expect(isShellCommandWriteOp('echo hi >> /tmp/a')).toBe(true);
  });

  it('stderr 重定向不误伤 → 仍只读', () => {
    expect(isShellCommandWriteOp('ls /nope 2>/dev/null')).toBe(false);
    expect(isShellCommandWriteOp('grep x f 2>/dev/null | head')).toBe(false);
  });

  it('rm / mv / tee → true', () => {
    expect(isShellCommandWriteOp('rm -f /tmp/a')).toBe(true);
    expect(isShellCommandWriteOp('mv a b')).toBe(true);
    expect(isShellCommandWriteOp('tee out.txt')).toBe(true);
  });

  it('空命令 fail-closed → true', () => {
    expect(isShellCommandWriteOp('')).toBe(true);
    expect(isShellCommandWriteOp('   ')).toBe(true);
  });

  it('未知命令头 fail-closed → true', () => {
    expect(isShellCommandWriteOp('npm install lodash')).toBe(true);
    expect(isShellCommandWriteOp('python script.py')).toBe(true);
  });
});

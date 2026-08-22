import { describe, expect, it } from 'vitest';
import { classifyFsError, buildAVTimeoutError } from '../classify.js';
import { renderForCLI } from '../cli-render.js';

function fsErr(code: string): NodeJS.ErrnoException {
  const e = new Error('mock') as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('renderForCLI', () => {
  it('darwin TCC 拒绝 → 含路径、原因、步骤、快捷跳转、重启提示', () => {
    const err = classifyFsError(fsErr('EPERM'), '/Volumes/MyDisk/x.txt', 'darwin')!;
    const out = renderForCLI(err, { color: false });
    expect(out).toContain('/Volumes/MyDisk/x.txt');
    expect(out).toContain('macOS');
    expect(out).toContain('系统权限拒绝');
    expect(out).toContain('可移除宗卷');
    expect(out).toContain('操作步骤');
    expect(out).toContain('快捷跳转');
    expect(out).toContain('open "x-apple.systempreferences:');
    expect(out).toContain('TabTin 主进程则需要重启');
  });

  it('Windows 杀软拦截 → 不含 macOS 字样、含安全软件提示', () => {
    const err = buildAVTimeoutError('C:\\work\\x.docx', 5000);
    const out = renderForCLI(err, { color: false });
    expect(out).toContain('C:\\work\\x.docx');
    expect(out).toContain('Windows');
    expect(out).toContain('安全软件拦截');
    expect(out).toContain('安全软件');
    expect(out).not.toContain('macOS');
  });

  it('color=true → 含 ANSI 转义序列', () => {
    const err = classifyFsError(fsErr('EPERM'), '/Volumes/X/x', 'darwin')!;
    const out = renderForCLI(err, { color: true });
    expect(out).toContain('\x1b[');
  });

  it('color=false → 不含任何 ANSI 转义', () => {
    const err = classifyFsError(fsErr('EPERM'), '/Volumes/X/x', 'darwin')!;
    const out = renderForCLI(err, { color: false });
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('TARGET_NOT_FOUND → 步骤简短，不渲染快捷链接', () => {
    const err = classifyFsError(fsErr('ENOENT'), '/missing/x', 'darwin')!;
    const out = renderForCLI(err, { color: false });
    expect(out).toContain('路径不存在');
    expect(out).not.toContain('快捷跳转');
  });
});

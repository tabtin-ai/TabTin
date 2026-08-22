import { describe, expect, it } from 'vitest';
import { classifyFsError, buildAVTimeoutError } from '../classify.js';
import { renderForAgent, toToolError } from '../serialize.js';
import { inferCategoryFromPath } from '../paths.js';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

function fsErr(code: string, message = 'mock error', extra: Record<string, unknown> = {}): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  Object.assign(e, extra);
  return e;
}

describe('classifyFsError', () => {
  describe('darwin', () => {
    it('EPERM 在 /Volumes 下 → OS_PERMISSION_DENIED + RemovableVolume', () => {
      const r = classifyFsError(fsErr('EPERM'), '/Volumes/MyDisk/foo.txt', 'darwin');
      expect(r).not.toBeNull();
      expect(r!.code).toBe('OS_PERMISSION_DENIED');
      expect(r!.category).toBe('RemovableVolume');
      expect(r!.terminal).toBe(true);
      // Wave 1 第二轮 M-2 修订：文案从"macOS 系统拦截"改成更人话的"Mac 阻止了"
      expect(r!.userGuidance).toContain('Mac');
      expect(r!.userGuidance).toContain('/Volumes/MyDisk/foo.txt');
      expect(r!.userGuidance).toContain('外接磁盘'); // 类目改成更通用的"外接磁盘"
    });

    it('EACCES 在 iCloud 路径 → OS_PERMISSION_DENIED + CloudStorage', () => {
      const cloud = path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'plan.md');
      const r = classifyFsError(fsErr('EACCES'), cloud, 'darwin');
      expect(r!.code).toBe('OS_PERMISSION_DENIED');
      expect(r!.category).toBe('CloudStorage');
      expect(r!.userGuidance).toContain('iCloud');
    });

    it('EBUSY → TARGET_BUSY 且 terminal=false（允许有限重试）', () => {
      const r = classifyFsError(fsErr('EBUSY'), '/tmp/locked', 'darwin');
      expect(r!.code).toBe('TARGET_BUSY');
      expect(r!.terminal).toBe(false);
    });

    it('ENOENT → TARGET_NOT_FOUND（terminal=true 防 Agent 死循环）', () => {
      const r = classifyFsError(fsErr('ENOENT'), '/tmp/missing', 'darwin');
      expect(r!.code).toBe('TARGET_NOT_FOUND');
      expect(r!.terminal).toBe(true);
    });
  });

  describe('win32', () => {
    it('CloudStorage 路径 + EACCES → CLOUD_NOT_DOWNLOADED', () => {
      const r = classifyFsError(
        fsErr('EACCES'),
        'C:\\Users\\Foo\\OneDrive\\plan.docx',
        'win32',
      );
      expect(r!.code).toBe('CLOUD_NOT_DOWNLOADED');
      expect(r!.category).toBe('CloudStorage');
      expect(r!.userGuidance).toContain('OneDrive');
    });

    it('错误消息含 0x800704EC → OS_AV_BLOCKED', () => {
      const e = fsErr('EACCES', 'The operation was blocked. HRESULT 0x800704EC');
      const r = classifyFsError(e, 'C:\\work\\report.xlsx', 'win32');
      expect(r!.code).toBe('OS_AV_BLOCKED');
    });

    it('错误消息含 0x8007016A → CLOUD_NOT_DOWNLOADED', () => {
      const e = fsErr('EACCES', 'ERROR_CLOUD_FILE_NOT_IN_SYNC (0x8007016A)');
      const r = classifyFsError(e, 'C:\\work\\file.txt', 'win32');
      expect(r!.code).toBe('CLOUD_NOT_DOWNLOADED');
    });

    it('ETIMEDOUT → OS_AV_BLOCKED（Windows 上 fs 超时几乎确定是杀软劫持）', () => {
      const r = classifyFsError(fsErr('ETIMEDOUT'), 'C:\\work\\x', 'win32');
      expect(r!.code).toBe('OS_AV_BLOCKED');
    });

    it('ENAMETOOLONG → PATH_TOO_LONG', () => {
      const r = classifyFsError(fsErr('ENAMETOOLONG'), 'C:\\very\\long\\...', 'win32');
      expect(r!.code).toBe('PATH_TOO_LONG');
    });
  });

  it('非 OS 访问类错误 → null（让上层原样抛）', () => {
    expect(classifyFsError(fsErr('EISDIR'), '/x', 'darwin')).toBeNull();
    expect(classifyFsError(fsErr('EINVAL'), '/x', 'darwin')).toBeNull();
    expect(classifyFsError(new Error('plain'), '/x', 'darwin')).toBeNull();
    expect(classifyFsError(null, '/x', 'darwin')).toBeNull();
  });

  it('buildAVTimeoutError → 显式 OS_AV_BLOCKED', () => {
    const r = buildAVTimeoutError('C:\\foo', 5000);
    expect(r.code).toBe('OS_AV_BLOCKED');
    expect(r.platform).toBe('win32');
    expect(r.rawDetail).toContain('5000');
  });
});

describe('inferCategoryFromPath', () => {
  it('macOS /Volumes/X → RemovableVolume', () => {
    expect(inferCategoryFromPath('/Volumes/MyDisk/x', 'darwin')).toBe('RemovableVolume');
  });
  it('macOS ~/Documents → Documents', () => {
    expect(inferCategoryFromPath(path.join(HOME, 'Documents/foo'), 'darwin')).toBe('Documents');
  });
  it('macOS ~/Library/X → FullDisk', () => {
    expect(inferCategoryFromPath(path.join(HOME, 'Library/Application Support/foo'), 'darwin')).toBe('FullDisk');
  });
  it('Windows UNC 路径 → NetworkVolume', () => {
    expect(inferCategoryFromPath('\\\\server\\share\\x', 'win32')).toBe('NetworkVolume');
  });
  it('Linux /media → RemovableVolume', () => {
    expect(inferCategoryFromPath('/media/usb/x', 'linux')).toBe('RemovableVolume');
  });
});

describe('renderForAgent / toToolError', () => {
  it('llm_message 包含用户引导、约束、深度链接', () => {
    const r = classifyFsError(fsErr('EPERM'), '/Volumes/MyDisk/x', 'darwin')!;
    const text = renderForAgent(r);
    expect(text).toContain('OS_ACCESS_ERROR');
    // Wave 1 第二轮 M-2 修订：文案从"macOS 系统拦截"改成更人话的"Mac 阻止了"
    expect(text).toContain('Mac');
    // S-8 修订：头行加 platform 字段（结构化锚点）
    expect(text).toContain('platform=darwin');
    expect(text).toContain('/Volumes/MyDisk/x');
    expect(text).toContain('约束');
    expect(text).toContain('不要重试');
    expect(text).toContain('x-apple.systempreferences');
  });

  it('toToolError 序列化产出最小 JSON', () => {
    const r = classifyFsError(fsErr('EPERM'), '/Volumes/MyDisk/x', 'darwin')!;
    const json = toToolError(r);
    expect(json.code).toBe('OS_PERMISSION_DENIED');
    expect(json.terminal).toBe(true);
    expect(json.llm_message.length).toBeGreaterThan(0);
    expect(json).not.toHaveProperty('userGuidance');
    expect(json).not.toHaveProperty('agentDirectives');
  });

  it('OS_AV_BLOCKED 的 recoveryActions 不含 restart_app（重启不解决杀软）', () => {
    const r = buildAVTimeoutError('C:\\foo', 5000);
    expect(r.recoveryActions.find((a) => a.type === 'restart_app')).toBeUndefined();
    expect(renderForAgent(r)).toContain('安全软件');
  });

  it('CLOUD_NOT_DOWNLOADED 的 recoveryActions 不含 restart_app（占位文件与权限无关）', () => {
    const e = fsErr('EACCES', 'ERROR_CLOUD_FILE_NOT_IN_SYNC (0x8007016A)');
    const r = classifyFsError(e, 'C:\\foo', 'win32')!;
    expect(r.recoveryActions.find((a) => a.type === 'restart_app')).toBeUndefined();
    expect(renderForAgent(r)).toContain('占位文件');
  });

  it('OS_PERMISSION_DENIED on darwin / FullDisk 类目的 recoveryActions 含 restart_app（FullDisk 授权后必须重启）', () => {
    // Wave 1 第二轮 M-2 修订：仅 FullDisk 这种"capability 模式"权限才需要重启进程；
    // 普通文件夹（Desktop/Documents/Downloads/Removable/Network）授权后立即生效。
    const r = classifyFsError(fsErr('EPERM'), path.join(HOME, 'Library/Foo'), 'darwin')!;
    expect(r.category).toBe('FullDisk'); // 锚点：~/Library 走 FullDisk
    expect(r.recoveryActions.find((a) => a.type === 'restart_app')).toBeDefined();
  });

  it('OS_PERMISSION_DENIED on darwin / 普通文件夹（RemovableVolume）的 recoveryActions 不含 restart_app', () => {
    // Wave 1 第二轮 M-2 修订：普通文件夹授权后立即生效，不需要重启——
    // 防止 Agent 给用户白白引导一次重启过程，丢上下文 + 触发未保存数据弹窗。
    const r = classifyFsError(fsErr('EPERM'), '/Volumes/MyDisk/x', 'darwin')!;
    expect(r.category).toBe('RemovableVolume');
    expect(r.recoveryActions.find((a) => a.type === 'restart_app')).toBeUndefined();
    // agentDirectives 引导 Agent 走授权后 retry，而不是调用退役模型工具。
    const directivesText = r.agentDirectives.join(' ');
    expect(directivesText).toContain('立即重试原工具');
    expect(directivesText).not.toContain('clear_os_error_blacklist');
    expect(directivesText).not.toContain('system_relaunch_app');
  });
});

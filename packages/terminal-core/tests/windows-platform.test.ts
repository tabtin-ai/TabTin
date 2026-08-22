/**
 * Windows 平台支持测试
 * 覆盖：平台检测、WSL 检测、WindowsSandbox 降级行为、commandExecutor Windows 分支
 * P1-SEC-2：Windows cmd.exe 命令注入修复验证
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 平台检测测试 ──

describe('detect.ts - Windows 平台检测', () => {
  let detectModule: typeof import('../src/platform/detect');

  beforeEach(async () => {
    // 重新导入以获取干净的缓存状态
    vi.resetModules();
    detectModule = await import('../src/platform/detect');
    detectModule.resetDetectionCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectPlatform()', () => {
    it('win32 平台返回 "windows"', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      // 确保 isWSL 返回 false（原生 Windows）
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return false;
        return false;
      });
      detectModule.resetDetectionCache();
      expect(detectModule.detectPlatform()).toBe('windows');
    });

    it('darwin 平台返回 "darwin"', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      expect(detectModule.detectPlatform()).toBe('darwin');
    });

    it('linux 平台返回 "linux"', () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      expect(detectModule.detectPlatform()).toBe('linux');
    });
  });

  describe('isWSL()', () => {
    it('/proc/version 包含 Microsoft 时返回 true', () => {
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return true;
        return false;
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return 'Linux version 5.15.0 (Microsoft@Microsoft.com)';
        return '';
      });
      detectModule.resetDetectionCache();
      expect(detectModule.isWSL()).toBe(true);
    });

    it('/proc/version 包含 WSL 时返回 true', () => {
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return true;
        return false;
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return 'Linux version 5.15.90.1-microsoft-standard-WSL2';
        return '';
      });
      detectModule.resetDetectionCache();
      expect(detectModule.isWSL()).toBe(true);
    });

    it('/proc/version 不含 Microsoft/WSL 时返回 false', () => {
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return true;
        return false;
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: string) => {
        if (p === '/proc/version') return 'Linux version 5.15.0-170-generic (buildd@lcy02-amd64-032)';
        return '';
      });
      detectModule.resetDetectionCache();
      expect(detectModule.isWSL()).toBe(false);
    });

    it('/proc/version 不存在时返回 false', () => {
      const fs = require('node:fs');
      vi.spyOn(fs, 'existsSync').mockImplementation(() => false);
      detectModule.resetDetectionCache();
      expect(detectModule.isWSL()).toBe(false);
    });

    it('结果被缓存', () => {
      const fs = require('node:fs');
      const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      detectModule.resetDetectionCache();
      detectModule.isWSL();
      detectModule.isWSL();
      // existsSync 只在第一次调用时被调用（含 /proc/version 检查）
      expect(existsSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// ── WindowsSandbox 测试 ──

describe('WindowsSandbox - 降级沙箱行为', () => {
  let WindowsSandboxClass: typeof import('../src/platform/windows').WindowsSandbox;
  let resetWSLCacheFn: typeof import('../src/platform/windows').resetWSLCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/platform/windows');
    WindowsSandboxClass = mod.WindowsSandbox;
    resetWSLCacheFn = mod.resetWSLCache;
    resetWSLCacheFn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('platform 属性为 "windows"', () => {
    const sandbox = new WindowsSandboxClass();
    expect(sandbox.platform).toBe('windows');
  });

  it('原生 Windows 下 isAvailable() 返回 false', async () => {
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
      if (p === '/proc/version') return false;
      return false;
    });
    resetWSLCacheFn();
    const sandbox = new WindowsSandboxClass();
    expect(await sandbox.isAvailable()).toBe(false);
  });

  it('[P1-SEC-2] 原生 Windows 下 buildSpawnArgs 返回 PowerShell 降级参数', () => {
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
      if (p === '/proc/version') return false;
      return false;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetWSLCacheFn();
    const sandbox = new WindowsSandboxClass();
    const result = sandbox.buildSpawnArgs({
      command: 'dir',
      cwd: 'C:\\Users\\test\\project',
      tmpDir: 'C:\\Users\\test\\tmp',
      sandboxLevel: 'filesystem',
      env: { PATH: 'C:\\Windows\\System32' },
    });

    expect(result.file).toBe('powershell.exe');
    expect(result.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', 'dir',
    ]);
    expect(result.options.cwd).toBe('C:\\Users\\test\\project');
    expect(result.options.shell).toBe(false);
  });

  it('[P1-SEC-2] buildSpawnArgs 在降级模式下输出警告日志', () => {
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
      if (p === '/proc/version') return false;
      return false;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetWSLCacheFn();
    const sandbox = new WindowsSandboxClass();
    sandbox.buildSpawnArgs({
      command: 'dir',
      cwd: 'C:\\Users\\test',
      tmpDir: 'C:\\Users\\test\\tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Windows 无沙箱降级模式'),
      expect.any(String),
    );
  });
});

// ── escapeCmdMetaChars 测试 ──

describe('escapeCmdMetaChars - cmd.exe 元字符转义', () => {
  let escapeFn: typeof import('../src/platform/windows').escapeCmdMetaChars;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/platform/windows');
    escapeFn = mod.escapeCmdMetaChars;
  });

  it('转义 & 字符', () => {
    expect(escapeFn('echo hello & del /f *')).toBe('echo hello ^& del /f *');
  });

  it('转义 | 字符', () => {
    expect(escapeFn('echo hello | rm -rf /')).toBe('echo hello ^| rm -rf /');
  });

  it('转义 > 和 < 字符', () => {
    expect(escapeFn('echo data > file.txt')).toBe('echo data ^> file.txt');
    expect(escapeFn('type < input.txt')).toBe('type ^< input.txt');
  });

  it('转义 ^ 字符', () => {
    expect(escapeFn('echo ^test')).toBe('echo ^^test');
  });

  it('转义 % 字符（使用 %%）', () => {
    expect(escapeFn('echo %PATH%')).toBe('echo %%PATH%%');
  });

  it('转义 ( 和 ) 字符', () => {
    expect(escapeFn('if (true) echo yes')).toBe('if ^(true^) echo yes');
  });

  it('转义 ! 字符', () => {
    expect(escapeFn('echo !var!')).toBe('echo ^!var^!');
  });

  it('转义 " 字符', () => {
    expect(escapeFn('echo "hello"')).toBe('echo ^"hello^"');
  });

  it('无特殊字符时原样返回', () => {
    expect(escapeFn('echo hello world')).toBe('echo hello world');
  });

  it('复合注入命令被完全转义', () => {
    const malicious = 'echo ok & del /f /q C:\\* | format C:';
    const escaped = escapeFn(malicious);
    // & 和 | 都被转义，阻止命令链执行
    expect(escaped).toBe('echo ok ^& del /f /q C:\\* ^| format C:');
    expect(escaped).not.toMatch(/(?<!\^)&/);  // 无未转义的 &
    expect(escaped).not.toMatch(/(?<!\^)\|/);  // 无未转义的 |
    expect(escaped).toContain('^&');
    expect(escaped).toContain('^|');
  });
});

// ── buildCmdFallbackSpawnArgs 测试 ──

describe('WindowsSandbox.buildCmdFallbackSpawnArgs - cmd.exe 回退', () => {
  let WindowsSandboxClass: typeof import('../src/platform/windows').WindowsSandbox;
  let resetWSLCacheFn: typeof import('../src/platform/windows').resetWSLCache;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/platform/windows');
    WindowsSandboxClass = mod.WindowsSandbox;
    resetWSLCacheFn = mod.resetWSLCache;
    resetWSLCacheFn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cmd.exe 回退模式对元字符进行转义', () => {
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation(() => false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetWSLCacheFn();

    const sandbox = new WindowsSandboxClass();
    const result = sandbox.buildCmdFallbackSpawnArgs({
      command: 'echo hello & whoami',
      cwd: 'C:\\Users\\test',
      tmpDir: 'C:\\tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.file).toBe('cmd.exe');
    expect(result.args[0]).toBe('/c');
    // & 应该被转义为 ^&
    expect(result.args[1]).toContain('^&');
    expect(result.options.shell).toBe(false);
  });

  it('cmd.exe 回退模式输出警告日志', () => {
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation(() => false);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetWSLCacheFn();

    const sandbox = new WindowsSandboxClass();
    sandbox.buildCmdFallbackSpawnArgs({
      command: 'dir',
      cwd: 'C:\\Users\\test',
      tmpDir: 'C:\\tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Windows cmd.exe 降级模式'),
      expect.any(String),
    );
  });
});

// ── createPlatformSandbox 集成测试 ──

describe('createPlatformSandbox - Windows 集成', () => {
  it('win32 平台返回 WindowsSandbox 实例', async () => {
    vi.resetModules();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const fs = require('node:fs');
    vi.spyOn(fs, 'existsSync').mockImplementation((p: string) => {
      if (p === '/proc/version') return false;
      return false;
    });

    const { resetDetectionCache } = await import('../src/platform/detect');
    resetDetectionCache();
    const { createPlatformSandbox } = await import('../src/platform/index');
    const sandbox = createPlatformSandbox();
    expect(sandbox.platform).toBe('windows');

    vi.restoreAllMocks();
  });
});

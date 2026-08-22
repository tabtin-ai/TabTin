/**
 * TC-6 回归测试：SandboxManager cp/chmod 竞态条件修复验证
 *
 * 修复方案：先复制到 .preparing 临时目录，设为只读后原子重命名为 projectDir。
 * 这样 projectDir 可见时文件已经是只读状态，消除竞态窗口。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SandboxManager } from '../src/sandboxManager';

describe('TC-6: SandboxManager 竞态条件修复', () => {
  let testDir: string;
  let sourceDir: string;
  let sandboxRoot: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'tc6-test-'));
    sourceDir = path.join(testDir, 'source');
    sandboxRoot = path.join(testDir, 'sandbox');

    // Create source directory with test files
    await fsPromises.mkdir(sourceDir, { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'test.txt'), 'hello');
    await fsPromises.writeFile(path.join(sourceDir, 'config.json'), '{}');
    await fsPromises.mkdir(path.join(sourceDir, 'subdir'), { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(async () => {
    // Clean up: need to make writable first
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // chmod everything writable first, then retry
      const chmodRecursive = async (p: string) => {
        try {
          const stat = await fsPromises.stat(p);
          if (stat.isDirectory()) {
            await fsPromises.chmod(p, 0o755);
            const entries = await fsPromises.readdir(p);
            for (const entry of entries) {
              await chmodRecursive(path.join(p, entry));
            }
          } else {
            await fsPromises.chmod(p, 0o644);
          }
        } catch { /* ignore */ }
      };
      await chmodRecursive(testDir);
      await fsPromises.rm(testDir, { recursive: true, force: true });
    }
  });

  it('ensureSandbox 产出只读的 projectDir', async () => {
    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('test-thread-1', sourceDir);

    // Verify projectDir exists and files are present
    expect(fs.existsSync(ctx.projectDir)).toBe(true);
    expect(fs.existsSync(path.join(ctx.projectDir, 'test.txt'))).toBe(true);

    // Verify files are readonly
    const fileStats = await fsPromises.stat(path.join(ctx.projectDir, 'test.txt'));
    // 0o444 = readonly for all
    expect(fileStats.mode & 0o222).toBe(0); // no write bits set

    const dirStats = await fsPromises.stat(ctx.projectDir);
    // 0o555 = readonly dir
    expect(dirStats.mode & 0o222).toBe(0); // no write bits set
  });

  it('不存在 .preparing 残留目录', async () => {
    const manager = new SandboxManager(sandboxRoot);
    await manager.ensureSandbox('test-thread-2', sourceDir);

    // .preparing directory should NOT exist after ensureSandbox completes
    const preparingDir = path.join(sandboxRoot, 'test-thread-2', 'project.preparing');
    expect(fs.existsSync(preparingDir)).toBe(false);
  });

  it('清理残留的 .preparing 目录', async () => {
    const manager = new SandboxManager(sandboxRoot);

    // Simulate a crashed previous run: create .preparing dir
    const threadDir = path.join(sandboxRoot, 'test-thread-3');
    const preparingDir = path.join(threadDir, 'project.preparing');
    await fsPromises.mkdir(preparingDir, { recursive: true });
    await fsPromises.writeFile(path.join(preparingDir, 'stale.txt'), 'stale');

    // ensureSandbox should clean up the stale .preparing and create fresh
    const ctx = await manager.ensureSandbox('test-thread-3', sourceDir);
    expect(fs.existsSync(ctx.projectDir)).toBe(true);
    expect(fs.existsSync(preparingDir)).toBe(false);
  });

  it('tmpDir 存在且可写', async () => {
    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('test-thread-4', sourceDir);

    expect(fs.existsSync(ctx.tmpDir)).toBe(true);

    // tmpDir should be writable
    const testFile = path.join(ctx.tmpDir, 'write-test.txt');
    await fsPromises.writeFile(testFile, 'writable');
    expect(fs.existsSync(testFile)).toBe(true);
  });

  it('cleanup 正确移除沙箱', async () => {
    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('test-thread-5', sourceDir);
    expect(fs.existsSync(ctx.sandboxDir)).toBe(true);

    await manager.cleanup('test-thread-5');
    expect(fs.existsSync(ctx.sandboxDir)).toBe(false);
  });

  it('threadId 路径遍历被清洗（dots/slashes replaced with _）', async () => {
    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('../../etc', sourceDir);
    const dirName = ctx.sandboxDir.split(path.sep).pop()!;
    expect(dirName).not.toContain('.');
    expect(dirName).not.toContain('/');
    expect(dirName).toBe('______etc');
  });

  it('空 threadId 被拒绝', async () => {
    const manager = new SandboxManager(sandboxRoot);
    await expect(manager.ensureSandbox('', sourceDir)).rejects.toThrow();
  });

  it('threadId 特殊字符被清洗', async () => {
    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('thread/with:special chars!', sourceDir);
    expect(fs.existsSync(ctx.projectDir)).toBe(true);
    const dirName = ctx.sandboxDir.split(path.sep).pop()!;
    expect(dirName).not.toContain('/');
    expect(dirName).not.toContain(':');
    expect(dirName).toBe('thread_with_special_chars_');
  });
});

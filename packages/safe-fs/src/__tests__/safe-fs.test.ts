import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  isOSAccessError,
  OSAccessError,
  safeReadFile,
  safeStat,
  safeAccess,
} from '../index.js';

describe('safe-fs', () => {
  it('safeReadFile 返回 Buffer / string', async () => {
    const tmp = path.join(os.tmpdir(), `tabtin-safe-fs-${Date.now()}.txt`);
    await fs.writeFile(tmp, 'hello');
    try {
      const buf = await safeReadFile(tmp);
      expect(Buffer.isBuffer(buf)).toBe(true);
      const txt = await safeReadFile(tmp, { encoding: 'utf-8' });
      expect(typeof txt).toBe('string');
      expect(txt).toBe('hello');
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  });

  it('读不存在文件 → OSAccessError + TARGET_NOT_FOUND', async () => {
    try {
      await safeReadFile('/nonexistent/very/long/path.txt');
      expect.fail('应抛错');
    } catch (e) {
      expect(isOSAccessError(e)).toBe(true);
      const oe = e as OSAccessError;
      expect(oe.osError.code).toBe('TARGET_NOT_FOUND');
      expect(oe.osError.path).toBe('/nonexistent/very/long/path.txt');
    }
  });

  it('safeStat 不存在 → OSAccessError', async () => {
    await expect(safeStat('/__nope__/x')).rejects.toBeInstanceOf(OSAccessError);
  });

  it('safeAccess 存在的文件 → 不抛错', async () => {
    await expect(safeAccess(os.tmpdir())).resolves.toBeUndefined();
  });

  it('OSAccessError 保留 osError 完整字段', async () => {
    try {
      await safeReadFile('/__missing__/x.txt');
    } catch (e) {
      const oe = e as OSAccessError;
      expect(oe.name).toBe('OSAccessError');
      expect(oe.osError.terminal).toBe(true);
      expect(oe.osError.userGuidance.length).toBeGreaterThan(0);
    }
  });
});

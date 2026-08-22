/**
 *  远程文件浏览：daemon 侧 fs.list_dir / fs.read_file_preview
 * handler 的边界与截断口径。
 *
 * boundary = Django 注入的服务端权威 `_working_dir`（唯一根）：
 *   - working_dir 外读取 → PATH_DENIED
 *   - 缺 _working_dir / path → INVALID_REQUEST（fail-closed）
 *   - 不存在的路径与被拒路径统一 PATH_DENIED（防目录结构探测）
 *   - 文本超限截断、NUL 嗅探判 binary、大图不内联
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  executeRemoteFsListDir,
  executeRemoteFsPreview,
  REMOTE_TEXT_PREVIEW_MAX_BYTES,
} from '../src/application/execution/remote-fs-handlers.js';

let workDir: string;
let outsideDir: string;

beforeAll(async () => {
  workDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'remote-fs-wd-'));
  outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'remote-fs-out-'));
  await fsPromises.mkdir(path.join(workDir, 'sub'));
  await fsPromises.writeFile(path.join(workDir, 'hello.txt'), 'hello remote fs');
  await fsPromises.writeFile(path.join(workDir, 'sub', 'nested.md'), '# nested');
  await fsPromises.writeFile(path.join(outsideDir, 'secret.txt'), 'outside boundary');
  // NUL 字节 → binary 嗅探
  await fsPromises.writeFile(path.join(workDir, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42]));
  // 超过文本截断上限
  await fsPromises.writeFile(
    path.join(workDir, 'big.log'),
    'x'.repeat(REMOTE_TEXT_PREVIEW_MAX_BYTES + 1024),
  );
});

afterAll(async () => {
  await fsPromises.rm(workDir, { recursive: true, force: true });
  await fsPromises.rm(outsideDir, { recursive: true, force: true });
});

describe('fs.list_dir', () => {
  it('lists working_dir with dirs first', async () => {
    const result = await executeRemoteFsListDir({ path: workDir, _working_dir: workDir });
    expect(result.success).toBe(true);
    const entries = (result.data as any).entries as Array<{ name: string; isDirectory: boolean }>;
    expect(entries[0]).toMatchObject({ name: 'sub', isDirectory: true });
    expect(entries.map((e) => e.name)).toContain('hello.txt');
  });

  it('rejects paths outside working_dir with PATH_DENIED', async () => {
    const result = await executeRemoteFsListDir({ path: outsideDir, _working_dir: workDir });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('PATH_DENIED');
  });

  it('rejects traversal escape (working_dir/../)', async () => {
    const sneaky = path.join(workDir, '..', path.basename(outsideDir));
    const result = await executeRemoteFsListDir({ path: sneaky, _working_dir: workDir });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('PATH_DENIED');
  });

  it('rejects symlink escape (working_dir/link -> outside)', async () => {
    const link = path.join(workDir, 'escape-link');
    await fsPromises.symlink(outsideDir, link);
    try {
      const result = await executeRemoteFsListDir({ path: link, _working_dir: workDir });
      expect(result.success).toBe(false);
      expect(result.error_code).toBe('PATH_DENIED');
    } finally {
      await fsPromises.rm(link, { force: true });
    }
  });

  it('maps non-existent path to PATH_DENIED (anti-probing)', async () => {
    const result = await executeRemoteFsListDir({
      path: path.join(workDir, 'no-such-dir'),
      _working_dir: workDir,
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('PATH_DENIED');
  });

  it('fails closed without authoritative _working_dir', async () => {
    const result = await executeRemoteFsListDir({ path: workDir });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_REQUEST');
  });
});

describe('fs.read_file_preview', () => {
  it('returns text preview', async () => {
    const result = await executeRemoteFsPreview({
      path: path.join(workDir, 'hello.txt'),
      _working_dir: workDir,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ kind: 'text', content: 'hello remote fs', truncated: false });
  });

  it('truncates oversized text and flags it', async () => {
    const result = await executeRemoteFsPreview({
      path: path.join(workDir, 'big.log'),
      _working_dir: workDir,
    });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.kind).toBe('text');
    expect(data.truncated).toBe(true);
    expect((data.content as string).length).toBe(REMOTE_TEXT_PREVIEW_MAX_BYTES);
  });

  it('sniffs NUL bytes as binary', async () => {
    const result = await executeRemoteFsPreview({
      path: path.join(workDir, 'blob.bin'),
      _working_dir: workDir,
    });
    expect(result.success).toBe(true);
    expect((result.data as any).kind).toBe('binary');
  });

  it('rejects directory with EISDIR', async () => {
    const result = await executeRemoteFsPreview({ path: workDir, _working_dir: workDir });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('EISDIR');
  });

  it('rejects file outside working_dir', async () => {
    const result = await executeRemoteFsPreview({
      path: path.join(outsideDir, 'secret.txt'),
      _working_dir: workDir,
    });
    expect(result.success).toBe(false);
    expect(result.error_code).toBe('PATH_DENIED');
  });

  it('rejects symlinked file escaping working_dir', async () => {
    const link = path.join(workDir, 'secret-link.txt');
    await fsPromises.symlink(path.join(outsideDir, 'secret.txt'), link);
    try {
      const result = await executeRemoteFsPreview({ path: link, _working_dir: workDir });
      expect(result.success).toBe(false);
      expect(result.error_code).toBe('PATH_DENIED');
    } finally {
      await fsPromises.rm(link, { force: true });
    }
  });

  it('denies credential reads under home even when working_dir covers them', async () => {
    // 模拟 working_dir = $HOME 场景：deny read 列表（~/.npmrc 等）必须挡住
    const fakeHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'remote-fs-home-'));
    const npmrc = path.join(fakeHome, '.npmrc');
    await fsPromises.writeFile(npmrc, '//registry/:_authToken=secret');
    const origHome = process.env.HOME;
    process.env.HOME = await fsPromises.realpath(fakeHome);
    try {
      const result = await executeRemoteFsPreview({ path: npmrc, _working_dir: fakeHome });
      expect(result.success).toBe(false);
      expect(result.error_code).toBe('PATH_DENIED');
    } finally {
      process.env.HOME = origHome;
      await fsPromises.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

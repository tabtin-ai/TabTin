/**
 * W2a：`mkdir` / `move_file` 行为回归测试。
 *
 * 覆盖：
 *   - mkdir：递归创建 / 目标已是目录幂等 / 目标已存在但是文件报错 /
 *     workspace boundary 拒绝 / workspace root 缺失兜底
 *   - move_file：正常移动 / from 不存在 / to 已存在不覆盖 / 禁止移入自身
 *     子树 / from 或 to 越界拒绝 / 目标父目录自动创建
 *
 * 不重复验证 read_file/write_file/delete_file 已覆盖的红线/敏感路径逻辑——
 * 那些走同一个 `checkFilePathSecurity`，见 `tabcode-security-fixes.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import { codeMkdirTool, codeMoveFileTool } from '../index';

let workspaceDir: string;

async function writeIn(dir: string, name: string, contents = 'data'): Promise<string> {
  const fullPath = path.join(dir, name);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, contents, 'utf8');
  return fullPath;
}

beforeEach(async () => {
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mkdir-move-'));
  workspaceDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(workspaceDir, { recursive: true, force: true });
});

describe('mkdir', () => {
  it('目标不存在 → 递归创建成功', async () => {
    const target = path.join(workspaceDir, 'a', 'b', 'c');

    const res = (await codeMkdirTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    expect(res.data?.path).toBe(target);
    const stat = await fsPromises.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it('目标已是目录 → 幂等成功（already_exists: true）', async () => {
    const target = path.join(workspaceDir, 'already-there');
    await fsPromises.mkdir(target);

    const res = (await codeMkdirTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    expect(res.data?.already_exists).toBe(true);
  });

  it('目标已存在但是文件 → 报错，不覆盖', async () => {
    const target = await writeIn(workspaceDir, 'im-a-file.txt');

    const res = (await codeMkdirTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    expect(res.error_code).toBe('invalid_parameter');
    expect(String(res.error)).toContain('not a directory');
    // 文件没被破坏
    const stat = await fsPromises.stat(target);
    expect(stat.isFile()).toBe(true);
  });

  it('路径越界 → PERMISSION_DENIED，不创建目录', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'mkdir-outside-'));
    try {
      const target = path.join(outsideDir, 'blocked');

      const res = (await codeMkdirTool.execute({
        path: target,
        _workspace_root: workspaceDir,
        _allowed_paths: [workspaceDir], // outsideDir 不在内
      } as any)) as any;

      expect(res.success).toBe(false);
      expect(res.error_code).toBe('permission_denied');
      expect(String(res.error)).toContain('outside the allowed workspace');
      await expect(fsPromises.access(target)).rejects.toThrow();
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('path 缺失 → INVALID_PARAMETER', async () => {
    const res = (await codeMkdirTool.execute({ path: '' } as any)) as any;
    expect(res.success).toBe(false);
    expect(res.error_code).toBe('invalid_parameter');
  });
});

describe('move_file', () => {
  it('正常移动：源消失、目标出现且内容一致', async () => {
    const from = await writeIn(workspaceDir, 'src.txt', 'hello move');
    const to = path.join(workspaceDir, 'dst.txt');

    const res = (await codeMoveFileTool.execute({
      from,
      to,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    expect(res.data?.from).toBe(from);
    expect(res.data?.to).toBe(to);
    await expect(fsPromises.access(from)).rejects.toThrow();
    const content = await fsPromises.readFile(to, 'utf8');
    expect(content).toBe('hello move');
  });

  it('目标父目录不存在 → 自动创建', async () => {
    const from = await writeIn(workspaceDir, 'src2.txt', 'nested move');
    const to = path.join(workspaceDir, 'nested', 'deep', 'dst2.txt');

    const res = (await codeMoveFileTool.execute({
      from,
      to,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    const content = await fsPromises.readFile(to, 'utf8');
    expect(content).toBe('nested move');
  });

  it('from 不存在 → FILE_NOT_FOUND', async () => {
    const from = path.join(workspaceDir, 'ghost.txt');
    const to = path.join(workspaceDir, 'dst3.txt');

    const res = (await codeMoveFileTool.execute({
      from,
      to,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    expect(res.error_code).toBe('file_not_found');
  });

  it('to 已存在 → 报错，不覆盖', async () => {
    const from = await writeIn(workspaceDir, 'src4.txt', 'source content');
    const to = await writeIn(workspaceDir, 'dst4.txt', 'existing content');

    const res = (await codeMoveFileTool.execute({
      from,
      to,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    expect(res.error_code).toBe('invalid_parameter');
    expect(String(res.error)).toContain('already exists');
    // 双方内容都没被破坏
    expect(await fsPromises.readFile(from, 'utf8')).toBe('source content');
    expect(await fsPromises.readFile(to, 'utf8')).toBe('existing content');
  });

  it('禁止把目录移动到自身子树内', async () => {
    const from = path.join(workspaceDir, 'parent-dir');
    await fsPromises.mkdir(from);
    const to = path.join(from, 'child-of-self');

    const res = (await codeMoveFileTool.execute({
      from,
      to,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    expect(res.error_code).toBe('invalid_parameter');
    expect(String(res.error)).toContain('own subtree');
    const stat = await fsPromises.stat(from);
    expect(stat.isDirectory()).toBe(true);
  });

  it('from 越界 → PERMISSION_DENIED', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'move-outside-from-'));
    try {
      const from = await writeIn(outsideDir, 'outside-src.txt');
      const to = path.join(workspaceDir, 'dst5.txt');

      const res = (await codeMoveFileTool.execute({
        from,
        to,
        _workspace_root: workspaceDir,
        _allowed_paths: [workspaceDir],
      } as any)) as any;

      expect(res.success).toBe(false);
      expect(res.error_code).toBe('permission_denied');
      // 源文件没被移走
      const stat = await fsPromises.stat(from);
      expect(stat.isFile()).toBe(true);
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('to 越界 → PERMISSION_DENIED', async () => {
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'move-outside-to-'));
    try {
      const from = await writeIn(workspaceDir, 'src6.txt', 'should stay');
      const to = path.join(outsideDir, 'escaped.txt');

      const res = (await codeMoveFileTool.execute({
        from,
        to,
        _workspace_root: workspaceDir,
        _allowed_paths: [workspaceDir],
      } as any)) as any;

      expect(res.success).toBe(false);
      expect(res.error_code).toBe('permission_denied');
      // 源文件仍在原位
      const content = await fsPromises.readFile(from, 'utf8');
      expect(content).toBe('should stay');
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('from/to 缺失 → INVALID_PARAMETER', async () => {
    const res = (await codeMoveFileTool.execute({ from: '', to: '' } as any)) as any;
    expect(res.success).toBe(false);
    expect(res.error_code).toBe('invalid_parameter');
  });

  describe('EXDEV（跨文件系统/跨盘符）兜底', () => {
    it('rename 报 EXDEV → 退化为 copy+unlink，成功移动', async () => {
      const from = await writeIn(workspaceDir, 'exdev-src.txt', 'exdev content');
      const to = path.join(workspaceDir, 'exdev-dst.txt');

      const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async () => {
        const err: any = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      });

      try {
        const res = (await codeMoveFileTool.execute({
          from,
          to,
          _workspace_root: workspaceDir,
          _allowed_paths: [workspaceDir],
        } as any)) as any;

        expect(res.success).toBe(true);
        await expect(fsPromises.access(from)).rejects.toThrow();
        expect(await fsPromises.readFile(to, 'utf8')).toBe('exdev content');
      } finally {
        renameSpy.mockRestore();
      }
    });

    it('rename 报 EXDEV 且目标在 copy 前一刻被并发创建 → COPYFILE_EXCL 拒绝覆盖，源文件保留', async () => {
      const from = await writeIn(workspaceDir, 'exdev-src2.txt', 'original source');
      const to = path.join(workspaceDir, 'exdev-dst2.txt');

      const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async () => {
        // 模拟：入口 lstat(to) 检查通过之后、真正 rename 之前，另一个进程抢先在
        // `to` 写了文件——这正是 COPYFILE_EXCL 要防的 TOCTOU 窗口。
        await fsPromises.writeFile(to, 'raced-in content', 'utf8');
        const err: any = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      });

      try {
        const res = (await codeMoveFileTool.execute({
          from,
          to,
          _workspace_root: workspaceDir,
          _allowed_paths: [workspaceDir],
        } as any)) as any;

        expect(res.success).toBe(false);
        expect(res.error_code).toBe('invalid_parameter');
        expect(String(res.error)).toContain('already exists');
        // 不覆盖：竞态写入的内容原样保留，源文件也没被误删
        expect(await fsPromises.readFile(to, 'utf8')).toBe('raced-in content');
        expect(await fsPromises.readFile(from, 'utf8')).toBe('original source');
      } finally {
        renameSpy.mockRestore();
      }
    });

    it('rename 报 EXDEV 且 copy 因非 EEXIST 原因失败 → 清理部分写入的目标，源文件保留', async () => {
      const from = await writeIn(workspaceDir, 'exdev-src3.txt', 'keep me safe');
      const to = path.join(workspaceDir, 'exdev-dst3.txt');

      const renameSpy = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async () => {
        const err: any = new Error('EXDEV: cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
      });
      const copySpy = vi.spyOn(fsPromises, 'copyFile').mockImplementationOnce(async () => {
        // 模拟 copy 中途失败前已经在目标路径落地了部分数据（真实场景如磁盘满）。
        await fsPromises.writeFile(to, 'partial garbage', 'utf8');
        const err: any = new Error('ENOSPC: no space left on device');
        err.code = 'ENOSPC';
        throw err;
      });

      try {
        const res = (await codeMoveFileTool.execute({
          from,
          to,
          _workspace_root: workspaceDir,
          _allowed_paths: [workspaceDir],
        } as any)) as any;

        // 外层 catch-all 把非预期错误兜底成 success:false，而不是让异常抛出到调用方。
        expect(res.success).toBe(false);
        expect(String(res.error)).toContain('ENOSPC');

        // 部分写入的目标文件被清理掉，不留下损坏的半成品
        await expect(fsPromises.access(to)).rejects.toThrow();
        // 源文件完好未删
        expect(await fsPromises.readFile(from, 'utf8')).toBe('keep me safe');
      } finally {
        renameSpy.mockRestore();
        copySpy.mockRestore();
      }
    });
  });
});

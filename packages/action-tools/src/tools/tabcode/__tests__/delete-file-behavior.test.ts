/**
 * 2026-05-13 重构：`delete_file` Delete 工具行为回归测试
 *
 * 配合用户决策「有 GUI 的 Delete 应友好失败、仅单文件」，本测试钉死：
 *
 *   1. **仅单文件**：删除目录直接拒，不教授递归删除命令
 *      （旧实现走 fs.unlink 出 EISDIR/EPERM 让 LLM 困惑）。
 *   2. **trash 备份退役**：成功 envelope 不再含 backup_path 字段；
 *      `~/.tabtin/trash/` 不再被工具触达；撤销靠 Checkpoint 体系。
 *   3. **description 重写**：中文（仅文件 / 优雅失败 /
 *      Checkpoint 撤销）。
 *   4. **graceful failure**：文件不存在视为"已删除"（不报错）。
 *
 * 不验证 path / hardline / boundary —— 那些在 `tabcode-security-fixes.test.ts`
 * 已有覆盖，本测试只钉新行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 跟兄弟测试保持一致：mock 掉 standardizeLegacyResult 的 envelope 转换以便
// 直接断言原始 `{ success, data, error, error_code }` 形态。
vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

import { fileDeleteTool } from '../index';

let workspaceDir: string;

async function writeIn(dir: string, name: string, contents = 'data'): Promise<string> {
  const fullPath = path.join(dir, name);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, contents, 'utf8');
  return fullPath;
}

beforeEach(async () => {
  // realpath 是为了避开 macOS /var → /private/var symlink 让 boundary 检查
  // 跟 resolveInWorkspace 看到同一个 canonical 路径（与兄弟测试同款 setup）。
  const raw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'delete-file-'));
  workspaceDir = await fsPromises.realpath(raw);
});

afterEach(async () => {
  await fsPromises.rm(workspaceDir, { recursive: true, force: true });
});

describe('delete_file：仅单文件，目录显式拒', () => {
  it('删除存在的单文件 → success + data.path 指向被删的文件', async () => {
    const target = await writeIn(workspaceDir, 'doomed.txt', 'goodbye');

    const res = (await fileDeleteTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    expect(res.data?.path).toBe(target);
    // 文件确实被删了
    await expect(fsPromises.access(target)).rejects.toThrow();
  });

  it('删除目录 → 显式拒绝且不教授绕过单文件边界的命令', async () => {
    const dirPath = path.join(workspaceDir, 'subdir');
    await fsPromises.mkdir(dirPath);

    const res = (await fileDeleteTool.execute({
      path: dirPath,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    // 错误信息明示这是目录
    expect(String(res.error)).toContain('directory');
    expect(String(res.error)).toContain('not supported by this tool');
    expect(String(res.error)).not.toContain('run_terminal_command');
    expect(String(res.error)).not.toContain('rm -rf');
    // 错误码用 UNSUPPORTED_OPERATION 而不是其他通用码
    expect(res.error_code).toBe('unsupported_operation');
    // 目录没被破坏
    const stat = await fsPromises.stat(dirPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('删除空目录也被拒（行为一致——不靠目录是否空来判定）', async () => {
    const emptyDir = path.join(workspaceDir, 'empty-dir');
    await fsPromises.mkdir(emptyDir);

    const res = (await fileDeleteTool.execute({
      path: emptyDir,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('directory');
    // 空目录仍存在
    const stat = await fsPromises.stat(emptyDir);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('delete_file：graceful failure 三条结构', () => {
  it('文件不存在 → success: true + already_deleted: true（视为已删除，不报错）', async () => {
    const ghost = path.join(workspaceDir, 'never-existed.txt');

    const res = (await fileDeleteTool.execute({
      path: ghost,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    expect(res.data?.already_deleted).toBe(true);
  });

  it('安全策略拒绝 → success: false + 不破坏文件', async () => {
    // 写一个 workspace 外的"敏感"文件——_allowed_paths 不包含它的父目录
    const outsideDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'outside-delete-'),
    );
    const outside = await writeIn(outsideDir, 'sensitive.txt', 'do not touch');

    try {
      const res = (await fileDeleteTool.execute({
        path: outside,
        _workspace_root: workspaceDir,
        _allowed_paths: [workspaceDir], // outsideDir 不在内
      } as any)) as any;

      expect(res.success).toBe(false);
      // 文案对齐工具协议（"outside the allowed workspace"），不暴露用户层产品名
      expect(String(res.error)).toContain('outside the allowed workspace');
      expect(String(res.error)).not.toMatch(/Super Permissions|TabFolder|YOLO/);
      // 文件没被破坏
      const stat = await fsPromises.stat(outside);
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('delete_file：trash 备份机制退役', () => {
  it('成功删除的 envelope 不再含 backup_path 字段（trash 已退役）', async () => {
    const target = await writeIn(workspaceDir, 'no-trash.txt', 'bye');

    const res = (await fileDeleteTool.execute({
      path: target,
      _workspace_root: workspaceDir,
      _allowed_paths: [workspaceDir],
    } as any)) as any;

    expect(res.success).toBe(true);
    // 旧实现 data.backup_path = '~/.tabtin/trash/<ts>_<basename>' —— 退役后
    // envelope 只含 path 字段（被删文件的 canonical path），不再 leak trash 路径
    expect(res.data?.backup_path).toBeUndefined();
    expect('backup_path' in (res.data ?? {})).toBe(false);
  });

  it('成功删除不会创建 ~/.tabtin/trash/ 目录（即便用户路径下未启用 trash）', async () => {
    // 这个测试是软断言：即便 ~/.tabtin/trash/ 已经因为其他模块存在，至少
    // 不会因为 delete_file 调用而 mkdir。我们用 spy 监控 fsPromises.mkdir
    // 的实际调用参数，确认本工具调用期间没有用 'trash' 子目录路径。
    const target = await writeIn(workspaceDir, 'spy.txt', 'spy data');
    const mkdirSpy = vi.spyOn(fsPromises, 'mkdir');

    try {
      await fileDeleteTool.execute({
        path: target,
        _workspace_root: workspaceDir,
        _allowed_paths: [workspaceDir],
      } as any);

      // 检查所有 mkdir 调用都没指向 trash 目录
      const trashCalls = mkdirSpy.mock.calls.filter(([dir]) => {
        return typeof dir === 'string' && dir.includes('.tabtin') && dir.includes('trash');
      });
      expect(trashCalls).toHaveLength(0);
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});

describe('delete_file：description 重写', () => {
  it('description 用中文，明示目录边界', () => {
    const desc = fileDeleteTool.description ?? '';

    // 中文（不再是单行英文 / 单行中文裸描述）
    expect(desc).toContain('删除');
    expect(desc).toContain('单个文件');

    // 仅文件 / 优雅失败 / Checkpoint 撤销
    expect(desc).toContain('仅支持删除文件');
    expect(desc).toContain('目录路径会被拒绝');
    expect(desc).not.toContain('run_terminal_command');
    expect(desc).not.toContain('rm -rf');
    expect(desc).toContain('优雅失败');
    expect(desc).toContain('checkpoint');

    // 不再是旧的一行字
    expect(desc.length).toBeGreaterThan(50);
    expect(desc).not.toBe('删除指定路径的文件。文件不存在或无法删除时优雅失败。');
  });
});

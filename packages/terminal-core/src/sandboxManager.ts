import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { SandboxContext } from './types';
import { t } from './i18n';

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  'dist', 'dist-app', 'build', '.next', '.nuxt', '.cache', '.tox',
]);

function sanitizeThreadId(threadId: string): string {
  const cleaned = threadId.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (!cleaned) {
    throw new Error(t('errors.threadIdRequired'));
  }
  return cleaned;
}

/**
 * 检查符号链接的真实目标是否在 allowedRoot 内部。
 * 指向外部的符号链接在复制时应被过滤，防止沙箱逃逸。
 */
export function isSymlinkWithinRoot(symlinkPath: string, allowedRoot: string): boolean {
  try {
    const target = fs.realpathSync(symlinkPath);
    const resolved = fs.realpathSync(allowedRoot);
    return target === resolved || target.startsWith(resolved + path.sep);
  } catch {
    return false;
  }
}

export class SandboxManager {
  private readonly sandboxRoot: string;

  constructor(sandboxRoot: string) {
    this.sandboxRoot = path.resolve(sandboxRoot);
  }

  async ensureSandbox(threadId: string, sourceRoot: string): Promise<SandboxContext> {
    const safe = sanitizeThreadId(threadId);

    const sandboxDir = path.join(this.sandboxRoot, safe);
    if (!path.resolve(sandboxDir).startsWith(this.sandboxRoot)) {
      throw new Error('Invalid thread ID: path traversal detected');
    }

    const projectDir = path.join(sandboxDir, 'project');
    const tmpDir = path.join(sandboxDir, 'tmp');

    await fsPromises.mkdir(this.sandboxRoot, { recursive: true });

    if (!fs.existsSync(projectDir)) {
      await fsPromises.mkdir(sandboxDir, { recursive: true });

      // TC-6 修复：消除 cp → rename 之间的竞态窗口。
      // 先复制到临时目录（带 .preparing 后缀），原子重命名到最终位置后再设为只读。
      // rename 需要目录本身可写（macOS 要求），所以 makeReadonly 必须在 rename 之后。
      // rename 完成到 makeReadonly 完成之间有短暂可写窗口，单进程下可接受。
      const preparingDir = projectDir + '.preparing';

      // 清理可能残留的中间状态（上次崩溃遗留）
      if (fs.existsSync(preparingDir)) {
        await fsPromises.rm(preparingDir, { recursive: true, force: true });
      }

      const resolvedSource = path.resolve(sourceRoot);
      await fsPromises.cp(sourceRoot, preparingDir, {
        recursive: true,
        dereference: false,
        filter: (src) => {
          const basename = path.basename(src);
          if (EXCLUDED_DIRS.has(basename)) return false;
          // Electron 的 fs 补丁会拦截 .asar 路径并尝试解析 ASAR 头，
          // 无效/跨平台的 ASAR 文件会导致 "Invalid package" 错误。
          if (basename.endsWith('.asar') || basename.endsWith('.asar.unpacked')) return false;
          try {
            const stats = fs.lstatSync(src);
            if (stats.isSymbolicLink()) {
              return isSymlinkWithinRoot(src, resolvedSource);
            }
          } catch {
            return false;
          }
          return true;
        },
      });
      await fsPromises.rename(preparingDir, projectDir);
      await this.makeReadonly(projectDir);
    }

    await fsPromises.mkdir(tmpDir, { recursive: true });
    return {
      sandboxDir,
      projectDir,
      tmpDir
    };
  }

  async cleanup(threadId: string): Promise<void> {
    const safe = sanitizeThreadId(threadId);
    const sandboxDir = path.join(this.sandboxRoot, safe);
    if (!path.resolve(sandboxDir).startsWith(this.sandboxRoot)) return;
    await this.makeWritable(sandboxDir);
    await fsPromises.rm(sandboxDir, { recursive: true, force: true });
  }

  private async makeWritable(targetPath: string): Promise<void> {
    try {
      const stats = await fsPromises.lstat(targetPath);
      if (stats.isSymbolicLink()) return;
      if (stats.isDirectory()) {
        await fsPromises.chmod(targetPath, 0o755);
        const entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
          await this.makeWritable(path.join(targetPath, entry.name));
        }
        return;
      }
      await fsPromises.chmod(targetPath, 0o644);
    } catch {
      // 目录可能已被部分删除，忽略错误
    }
  }

  private async makeReadonly(targetPath: string): Promise<void> {
    const stats = await fsPromises.lstat(targetPath);
    if (stats.isSymbolicLink()) {
      return;
    }
    if (stats.isDirectory()) {
      await fsPromises.chmod(targetPath, 0o555);
      const entries = await fsPromises.readdir(targetPath, { withFileTypes: true });
      for (const entry of entries) {
        await this.makeReadonly(path.join(targetPath, entry.name));
      }
      return;
    }
    await fsPromises.chmod(targetPath, 0o444);
  }
}

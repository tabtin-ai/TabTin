import fs from 'node:fs';
import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
  /** When true, recursively create parent directories before writing. */
  mkdirSync?: boolean;
}

function tmpPath(filePath: string): string {
  return `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
}

function resolveOptions(optionsOrMode?: AtomicWriteOptions | number): AtomicWriteOptions {
  if (optionsOrMode == null) return {};
  if (typeof optionsOrMode === 'number') return { mode: optionsOrMode };
  return optionsOrMode;
}

export function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer,
  optionsOrMode?: AtomicWriteOptions | number,
): void {
  const { encoding, mode, mkdirSync: ensureDir } = resolveOptions(optionsOrMode);
  if (ensureDir) {
    fs.mkdirSync(dirname(filePath), { recursive: true });
  }
  const tmp = tmpPath(filePath);
  try {
    fs.writeFileSync(tmp, data, { encoding, mode });
    fs.renameSync(tmp, filePath);
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    // 跨文件系统 rename 会报 EXDEV，无法原子替换，回退为直接写入目标路径
    if (code === 'EXDEV') {
      fs.writeFileSync(filePath, data, { encoding, mode });
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  optionsOrMode?: AtomicWriteOptions | number,
): Promise<void> {
  const { encoding, mode, mkdirSync: ensureDir } = resolveOptions(optionsOrMode);
  if (ensureDir) {
    await mkdir(dirname(filePath), { recursive: true });
  }
  const tmp = tmpPath(filePath);
  try {
    await writeFile(tmp, data, { encoding, mode });
    await rename(tmp, filePath);
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    // 跨文件系统 rename 会报 EXDEV，无法原子替换，回退为直接写入目标路径
    if (code === 'EXDEV') {
      await writeFile(filePath, data, { encoding, mode });
      await unlink(tmp).catch(() => {});
      return;
    }
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * 测试用 SafeFsPort：接 `@tabtin/safe-fs`（devDependency）。
 */

import {
  safeAccess,
  safeMkdir,
  safeReadDir,
  safeReadFile,
  safeRm,
  safeStat,
  safeWriteFile,
} from '@tabtin/safe-fs';

import type { SafeFsPort } from '../../src/capability/native/safe-fs-port.js';

export function createTestSafeFsPort(): SafeFsPort {
  return {
    readFile: (p) => safeReadFile(p),
    writeFile: (p, data) => safeWriteFile(p, data),
    readDir: (p) => safeReadDir(p),
    mkdir: (p, opts) => safeMkdir(p, opts),
    rm: (p, opts) => safeRm(p, opts),
    access: (p, mode) => safeAccess(p, mode),
    stat: (p) => safeStat(p),
  };
}

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 缓存检测结果，只检测一次 */
let cachedAvailability: boolean | null = null;

/** WSL 检测缓存 */
let cachedIsWSL: boolean | null = null;

/**
 * macOS: 检查 /usr/bin/sandbox-exec 是否存在
 */
export async function isDarwinSandboxAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability;

  try {
    cachedAvailability = fs.existsSync('/usr/bin/sandbox-exec');
  } catch {
    cachedAvailability = false;
  }
  return cachedAvailability;
}

/** Linux bwrap 缓存 */
let cachedBwrapAvailability: boolean | null = null;
let bwrapUnavailableReason: string | null = null;

/**
 * Linux: 检查 bwrap 是否在 PATH 中 **且能真正创建沙箱**。
 *
 * 两步探测：
 * 1. `which bwrap` — 二进制存在
 * 2. dry-run `bwrap --ro-bind /usr /usr --ro-bind /bin /bin -- /bin/true`
 *    — user namespace 可用、基础路径存在
 *
 * 结果缓存，避免每次命令执行都探测。
 */
export async function isLinuxBwrapAvailable(): Promise<boolean> {
  if (cachedBwrapAvailability !== null) return cachedBwrapAvailability;

  try {
    await execFileAsync('which', ['bwrap']);
  } catch {
    cachedBwrapAvailability = false;
    bwrapUnavailableReason = 'bwrap binary not found in PATH';
    return false;
  }

  try {
    await execFileAsync('bwrap', [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--', '/bin/true',
    ], { timeout: 5000 });
    cachedBwrapAvailability = true;
  } catch (err) {
    cachedBwrapAvailability = false;
    bwrapUnavailableReason = err instanceof Error ? err.message : String(err);
  }
  return cachedBwrapAvailability;
}

export function getBwrapUnavailableReason(): string | null {
  return bwrapUnavailableReason;
}

/**
 * 检测当前是否运行在 WSL（Windows Subsystem for Linux）环境中。
 *
 * 通过读取 /proc/version 检查是否包含 "Microsoft" 或 "WSL" 字样。
 * 结果缓存，避免重复文件 I/O。
 */
export function isWSL(): boolean {
  if (cachedIsWSL !== null) return cachedIsWSL;
  try {
    if (fs.existsSync('/proc/version')) {
      const version = fs.readFileSync('/proc/version', 'utf-8');
      cachedIsWSL = /microsoft|wsl/i.test(version);
    } else {
      cachedIsWSL = false;
    }
  } catch {
    cachedIsWSL = false;
  }
  return cachedIsWSL;
}

/**
 * 获取当前平台标识
 *
 * 平台选择逻辑：
 * - WSL 环境 → 'linux'（使用 bubblewrap，与 Linux 原生一致）
 * - Windows 原生 → 'windows'（降级模式）
 * - macOS → 'darwin'
 * - Linux → 'linux'
 */
export function detectPlatform(): 'darwin' | 'linux' | 'windows' | 'unsupported' {
  switch (process.platform) {
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
      // WSL2 下 process.platform 仍为 'linux'，此分支只在原生 Windows 触发
      // 但为安全起见，若检测到 WSL 环境则走 linux 路径
      if (isWSL()) return 'linux';
      return 'windows';
    default:
      return 'unsupported';
  }
}

/**
 * 重置缓存（仅用于测试）
 */
export function resetDetectionCache(): void {
  cachedAvailability = null;
  cachedBwrapAvailability = null;
  bwrapUnavailableReason = null;
  cachedIsWSL = null;
}

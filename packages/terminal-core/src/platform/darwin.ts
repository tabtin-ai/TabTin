import fs from 'node:fs';
import path from 'node:path';
import type { PlatformSandbox, SandboxParams, SandboxSpawnArgs } from './types';
import { isDarwinSandboxAvailable } from './detect';
import { sanitizeSandboxEnv } from '../sanitizeEnv';

function escapeSeatbeltPath(p: string): string {
  if (/[\n\r\0]/.test(p)) {
    throw new Error(`Seatbelt path contains illegal characters: ${p}`);
  }
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 生成 Seatbelt (.sb) profile 内容
 *
 * deny default → 仅允许白名单路径和能力
 */
function extractPathDirs(env: Record<string, string>): string[] {
  const raw = env.PATH || '';
  const seen = new Set<string>();
  const result: string[] = [];
  for (const d of raw.split(':')) {
    const trimmed = d.trim();
    if (!trimmed || trimmed === '.' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildSeatbeltProfile(params: SandboxParams): string {
  const cwdEsc = escapeSeatbeltPath(params.cwd);
  const tmpEsc = escapeSeatbeltPath(params.tmpDir);
  const { sandboxLevel } = params;
  const homeDir = params.env.HOME || process.env.HOME || '';

  const pathDirs = extractPathDirs(params.env);

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    ';; TC-7 修复：process-exec 限制为已知安全路径 + PATH 中的目录',
    '(allow process-exec',
    '  (subpath "/usr/bin")',
    '  (subpath "/bin")',
    '  (subpath "/usr/sbin")',
    '  (subpath "/sbin")',
    '  (subpath "/usr/local/bin")',
    '  (subpath "/opt/homebrew/bin")',
    '  (subpath "/usr/lib")',
    '  (subpath "/Library/Developer")',
    ...pathDirs
      .filter(d => !d.startsWith('/usr/') && !d.startsWith('/bin') && !d.startsWith('/sbin') && !d.startsWith('/opt/homebrew/bin') && !d.startsWith('/Library/Developer'))
      .map(d => `  (subpath "${escapeSeatbeltPath(d)}")`),
    ')',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '',
    ';; TC-7 修复：mach-lookup 限制为必要服务，不再无限制放行',
    '(allow mach-lookup',
    '  (global-name "com.apple.system.logger")',
    '  (global-name "com.apple.system.notification_center")',
    '  (global-name "com.apple.SecurityServer")',
    '  (global-name "com.apple.CoreServices.coreservicesd")',
    '  (global-name "com.apple.DiskArbitration.diskarbitrationd")',
    '  (global-name-regex #"^com\\.apple\\.lsd\\.")',
    '  (global-name-regex #"^com\\.apple\\.distributed_notifications")',
    ')',
    ';; Go/Rust 等静态链接二进制需要 mach-register 用于 Mach 端口管理',
    '(allow mach-register)',
    '',
    ';; 系统目录只读',
    '(allow file-read*',
    '  (literal "/")',
    '  (subpath "/usr/lib")',
    '  (subpath "/usr/bin")',
    '  (subpath "/bin")',
    '  (subpath "/usr/local")',
    '  (subpath "/opt/homebrew")',
    '  (subpath "/System")',
    '  (subpath "/dev")',
    '  (subpath "/private/var/db")',
    '  (subpath "/private/etc")',
    '  (subpath "/Library/Developer")',
    ';; TC-7 修复：/private/tmp 限制为沙箱临时目录，不再允许访问所有 /private/tmp',
    `  (subpath "${tmpEsc}")`,
    '  (subpath "/var/folders")',
    ')',
    '',
    ';; 项目目录只读',
    `(allow file-read* (subpath "${cwdEsc}"))`,
    '',
    ';; CLI 发现：允许读取 ~/.tabtin/ 和 PATH 中的二进制目录',
    ...(homeDir ? [`(allow file-read* (subpath "${escapeSeatbeltPath(path.join(homeDir, '.tabtin'))}"))`] : []),
    ...pathDirs.map(d => `(allow file-read* (subpath "${escapeSeatbeltPath(d)}"))`),
    '',
    ';; 临时目录可读写（含系统级 /private/var/folders，Go/Rust 运行时需要）',
    `(allow file-read* (subpath "${tmpEsc}"))`,
    `(allow file-write* (subpath "${tmpEsc}"))`,
    '(allow file-write* (subpath "/private/var/folders"))',
    '',
    ';; Go 网络轮询器需要 /private/var/select',
    '(allow file-read* (subpath "/private/var/select"))',
    '(allow file-write* (subpath "/private/var/select"))',
  ];

  // Network policy: respect explicit networkMode, fallback to sandboxLevel logic
  const networkMode = params.networkMode;
  const allowNetwork =
    networkMode === 'blocked' ? false :
    networkMode === 'allowed' ? true :
    sandboxLevel === 'filesystem'; // default: filesystem=allow, complete=block

  if (allowNetwork) {
    lines.push(
      '',
      ';; 网络放行',
      '(allow network-outbound)',
      '(allow network-inbound)',
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * macOS sandbox-exec (Seatbelt) 适配器
 */
export class DarwinSandbox implements PlatformSandbox {
  readonly platform = 'darwin' as const;

  async isAvailable(): Promise<boolean> {
    return isDarwinSandboxAvailable();
  }

  buildSpawnArgs(params: SandboxParams): SandboxSpawnArgs {
    const profile = buildSeatbeltProfile(params);

    // 将 profile 写入 sandbox 临时目录
    const profilePath = path.join(params.tmpDir, '.sandbox-profile.sb');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, profile, 'utf-8');

    // TC-8 修复：与 Linux 沙箱保持一致，使用 set -euo pipefail 防护命令链
    const safeCommand = `set -euo pipefail; ${params.command}`;

    const sanitizedEnv = sanitizeSandboxEnv(params.env);

    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-f', profilePath, '/bin/sh', '-c', safeCommand],
      options: {
        cwd: params.cwd,
        shell: false,
        env: sanitizedEnv,
      },
    };
  }
}

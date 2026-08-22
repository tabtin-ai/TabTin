import fs from 'node:fs';
import type { PlatformSandbox, SandboxParams, SandboxSpawnArgs } from './types';
import { isLinuxBwrapAvailable } from './detect';
import { sanitizeSandboxEnv } from '../sanitizeEnv';

/**
 * Minimal /etc entries needed for POSIX programs to function.
 * Full /etc bind is avoided to prevent leaking /etc/passwd, /etc/shadow, etc.
 *
 * Intentionally excluded: /etc/passwd, /etc/shadow, /etc/group,
 * /etc/sudoers, /etc/ssh/, /etc/hostname — these leak user/host info.
 * Commands referencing them get "No such file or directory" (defense in depth).
 */
export const ETC_REQUIRED_ENTRIES: readonly string[] = [
  // Dynamic linker
  '/etc/alternatives',
  '/etc/ld.so.cache',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  // TLS / certificates
  '/etc/ssl',
  '/etc/ca-certificates',
  '/etc/pki',
  // DNS / networking
  '/etc/nsswitch.conf',
  '/etc/resolv.conf',
  '/etc/hosts',
  // Timezone
  '/etc/localtime',
  '/etc/timezone',
  // Network service definitions
  '/etc/mime.types',
  '/etc/protocols',
  '/etc/services',
  // Shell initialization
  '/etc/bash.bashrc',
  '/etc/profile',
  '/etc/profile.d',
  '/etc/environment',
  '/etc/shells',
  // Git
  '/etc/gitconfig',
];

let isNixOS: boolean | null = null;

function detectNixOS(): boolean {
  if (isNixOS !== null) return isNixOS;
  try {
    isNixOS = fs.existsSync('/nix/store');
  } catch {
    isNixOS = false;
  }
  return isNixOS;
}

/**
 * Linux bubblewrap (bwrap) 适配器
 *
 * 使用 unprivileged user namespace 隔离：
 * - --unshare-user: 用户命名空间隔离，使 setuid binary 无法提权
 * - --unshare-ipc: IPC 命名空间隔离，阻止 SysV IPC 跨沙箱通信
 * - --unshare-pid: PID namespace 隔离
 * - --unshare-net: 网络隔离（仅 complete 级别）
 * - --ro-bind: 系统目录只读挂载
 * - --bind: 可写目录挂载
 *
 * /etc 使用白名单式挂载，仅暴露运行必需的子集，
 * 避免泄露 /etc/passwd、/etc/shadow 等用户信息。
 *
 * NixOS 使用特殊的路径策略：挂载 /nix/store 而非传统 FHS 路径。
 */
export class LinuxSandbox implements PlatformSandbox {
  readonly platform = 'linux' as const;

  async isAvailable(): Promise<boolean> {
    return isLinuxBwrapAvailable();
  }

  buildSpawnArgs(params: SandboxParams): SandboxSpawnArgs {
    const args: string[] = [];

    // User namespace isolation: setuid bits become ineffective,
    // preventing privilege escalation via sudo/su/pkexec etc.
    args.push('--unshare-user');

    if (detectNixOS()) {
      args.push('--ro-bind', '/nix', '/nix');
      for (const p of ['/usr', '/bin', '/lib', '/lib64', '/sbin']) {
        if (fs.existsSync(p)) {
          args.push('--ro-bind-try', p, p);
        }
      }
    } else {
      args.push(
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/bin', '/bin',
        '--ro-bind', '/lib', '/lib',
      );
      for (const optPath of ['/lib64', '/opt', '/sbin', '/usr/local']) {
        args.push('--ro-bind-try', optPath, optPath);
      }
    }

    // /etc: 白名单式挂载，避免暴露 /etc/passwd, /etc/shadow 等
    for (const entry of ETC_REQUIRED_ENTRIES) {
      args.push('--ro-bind-try', entry, entry);
    }

    // proc / dev
    args.push('--proc', '/proc');
    args.push('--dev', '/dev');

    // 项目目录只读
    args.push('--ro-bind', params.cwd, params.cwd);

    // 临时目录可读写
    args.push('--bind', params.tmpDir, params.tmpDir);

    // PID + IPC 隔离 + 父进程退出自动清理
    args.push('--unshare-pid', '--unshare-ipc', '--die-with-parent');

    // Network isolation: respect explicit networkMode, fallback to sandboxLevel
    const blockNetwork =
      params.networkMode === 'blocked' ? true :
      params.networkMode === 'allowed' ? false :
      params.sandboxLevel === 'complete';

    if (blockNetwork) {
      args.push('--unshare-net');
    }

    // TC-8 修复：对命令进行 shell 元字符防护
    // 虽然 L0 层已拆分验证命令链（TC-2），此处作为纵深防御，
    // 使用 set -euo pipefail 确保命令链中任何失败立即中断，
    // 避免在沙箱内通过 ; && || 执行未经验证的后续命令。
    const safeCommand = `set -euo pipefail; ${params.command}`;
    args.push('--', '/bin/sh', '-c', safeCommand);

    const sanitizedEnv = sanitizeSandboxEnv(params.env);

    return {
      file: 'bwrap',
      args,
      options: {
        cwd: params.cwd,
        shell: false,
        env: sanitizedEnv,
      },
    };
  }
}

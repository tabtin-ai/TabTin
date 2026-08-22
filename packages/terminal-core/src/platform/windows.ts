import fs from 'node:fs';
import type { PlatformSandbox, SandboxParams, SandboxSpawnArgs } from './types';
import { LinuxSandbox } from './linux';
import { isLinuxBwrapAvailable } from './detect';
import { sanitizeSandboxEnv } from '../sanitizeEnv';

/**
 * 检测当前是否运行在 WSL2 环境中。
 *
 * 通过读取 /proc/version 检查是否包含 "Microsoft" 或 "WSL" 字样。
 */
let cachedIsWSL: boolean | null = null;

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

/** 重置 WSL 检测缓存（仅用于测试） */
export function resetWSLCache(): void {
  cachedIsWSL = null;
}

/**
 * 对 cmd.exe 的 shell 元字符进行转义。
 *
 * cmd.exe 的特殊字符（& | > < ^ ( ) %）需要用 ^ 前缀转义，
 * 防止命令注入（如 `echo hello & del /f /q *`）。
 *
 * 注意：% 需要用 %% 转义（cmd.exe 的变量展开语法）。
 */
export function escapeCmdMetaChars(arg: string): string {
  // 先转义 %（%% 是 cmd.exe 的转义方式）
  let escaped = arg.replace(/%/g, '%%');
  // 再转义其他 cmd.exe 元字符（用 ^ 前缀）
  escaped = escaped.replace(/([&|><^()!"])/g, '^$1');
  return escaped;
}

/**
 * Windows 平台沙箱适配器
 *
 * 策略：
 * - WSL2 环境：委托给 LinuxSandbox（bubblewrap），与 Linux 原生体验一致
 * - Windows 原生：降级模式，不启用 OS 级沙箱，安全性由 denylist + allowlist 保障
 *   优先使用 PowerShell 执行命令（参数处理更安全），回退到 cmd.exe 时进行元字符转义
 *
 * TODO: 后续可集成 Windows Sandbox API 或 AppContainer 实现 OS 级沙箱隔离
 */
export class WindowsSandbox implements PlatformSandbox {
  readonly platform = 'windows' as const;

  private readonly linuxFallback = new LinuxSandbox();

  async isAvailable(): Promise<boolean> {
    // WSL2 下委托给 bubblewrap
    if (isWSL()) {
      return isLinuxBwrapAvailable();
    }
    // Windows 原生：降级模式，返回 false 表示无 OS 级沙箱
    // CommandExecutor 会走降级路径（denylist + allowlist 保障安全性）
    return false;
  }

  buildSpawnArgs(params: SandboxParams): SandboxSpawnArgs {
    // WSL2 下委托给 LinuxSandbox（bubblewrap）
    if (isWSL()) {
      return this.linuxFallback.buildSpawnArgs(params);
    }

    // [P1-SEC-2] Windows 原生降级模式：记录安全警告
    console.warn(
      '[terminal-core] WARNING: Windows 无沙箱降级模式 — 安全性仅由 denylist + allowlist 保障，' +
      '无 OS 级沙箱隔离。命令: %s',
      params.command.slice(0, 80) + (params.command.length > 80 ? '...' : ''),
    );

    // [P1-SEC-2] 优先使用 PowerShell — 参数处理更安全
    // PowerShell 使用 -NoProfile -NonInteractive -Command 模式，
    // 不加载用户配置，且 -Command 参数不会像 cmd.exe 那样解析 shell 元字符
    const sanitizedEnv = sanitizeSandboxEnv(params.env);

    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', params.command,
      ],
      options: {
        cwd: params.cwd,
        shell: false,
        env: sanitizedEnv,
      },
    };
  }

  /**
   * 使用 cmd.exe 的降级构建参数（仅当 PowerShell 不可用时使用）。
   * 对命令中的 shell 元字符进行转义以防止注入。
   */
  buildCmdFallbackSpawnArgs(params: SandboxParams): SandboxSpawnArgs {
    console.warn(
      '[terminal-core] WARNING: Windows cmd.exe 降级模式 — 命令元字符已转义，' +
      '但安全性仍仅由 denylist + allowlist 保障。命令: %s',
      params.command.slice(0, 80) + (params.command.length > 80 ? '...' : ''),
    );

    const sanitizedEnv = sanitizeSandboxEnv(params.env);

    return {
      file: 'cmd.exe',
      args: ['/c', escapeCmdMetaChars(params.command)],
      options: {
        cwd: params.cwd,
        shell: false,
        env: sanitizedEnv,
      },
    };
  }
}

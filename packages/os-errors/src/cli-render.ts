/**
 * CLI 错误渲染 —— 把 OSError 格式化到彩色 stderr。
 *
 * 用于 `tabtin` Node CLI、Daemon 排错日志、单元测试 fixture 等场景。
 * 不直接 print，由调用方决定输出位置（process.stderr.write / logger.warn 等），
 * 保持纯函数特性方便测试。
 *
 * Go CLI（packages/tabtin-cli-go）从 cli-server 拿到的是 OSToolError JSON，
 * 自带 llm_message 字段，可直接展示，不依赖本模块。
 */

import type { OSError, OSErrorCategory, OSErrorCode } from './types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

interface RenderCLIOptions {
  /**
   * 是否输出 ANSI 颜色。默认根据 `process.stderr?.isTTY` 自动决定，
   * 显式传 false 适合写入日志文件 / CI 不支持彩色的场景。
   */
  color?: boolean;
}

const CODE_LABELS: Record<OSErrorCode, string> = {
  OS_PERMISSION_DENIED: '系统权限拒绝',
  OS_AV_BLOCKED: '安全软件拦截',
  CLOUD_NOT_DOWNLOADED: '云盘文件未下载',
  NETWORK_CREDENTIAL_REQUIRED: '网络盘需要凭据',
  PATH_TOO_LONG: '路径过长',
  DISK_LOCKED: '磁盘未解锁',
  TARGET_BUSY: '文件被占用',
  TARGET_NOT_FOUND: '路径不存在',
};

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

const CATEGORY_LABEL: Record<OSErrorCategory, string> = {
  RemovableVolume: '可移除宗卷',
  CloudStorage: '云盘',
  Documents: '文稿文件夹',
  Desktop: '桌面文件夹',
  Downloads: '下载文件夹',
  NetworkVolume: '网络宗卷',
  FullDisk: '完全的磁盘访问权限',
  Other: '其他',
};

/** 把系统设置 deep link 转成对应 OS 的 shell 打开命令 */
function deepLinkToOpenCommand(deepLink: string, platform: string): string {
  if (platform === 'darwin') return `open "${deepLink}"`;
  if (platform === 'win32') return `start ${deepLink}`;
  return `xdg-open "${deepLink}"`;
}

/**
 * 把 userGuidance 拆成最多 N 条短步骤，避免一长串中文断句堆在终端里。
 * 拆分规则：按中文句号 / 西文句号断句，过滤空段。
 */
function splitGuidanceIntoSteps(guidance: string, maxSteps = 6): string[] {
  return guidance
    .split(/(?<=[。.！!？?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, maxSteps);
}

/**
 * 把 OSError 渲染成可直接写到 stderr 的多行字符串（含 ANSI 颜色）。
 *
 * 调用示例：
 * ```ts
 *   try {
 *     await safeReadFile(p)
 *   } catch (e) {
 *     if (isOSAccessError(e)) {
 *       process.stderr.write(renderForCLI(e.osError) + '\n')
 *       process.exit(1)
 *     }
 *     throw e
 *   }
 * ```
 */
export function renderForCLI(err: OSError, opts: RenderCLIOptions = {}): string {
  const useColor = opts.color ?? (typeof process !== 'undefined' && Boolean(process.stderr?.isTTY));
  const c = useColor
    ? ANSI
    : { reset: '', bold: '', dim: '', red: '', yellow: '', cyan: '' };

  const lines: string[] = [];
  const codeLabel = CODE_LABELS[err.code] ?? err.code;
  const platformLabel = PLATFORM_LABEL[err.platform] ?? err.platform;
  const catLabel = CATEGORY_LABEL[err.category] ?? err.category;

  lines.push(`${c.red}✗ 无法访问${c.reset} ${err.path}`);
  lines.push(
    `  ${c.bold}原因:${c.reset} ${platformLabel} ${codeLabel}（${catLabel}）`,
  );
  lines.push('');
  lines.push(`  ${c.bold}操作步骤:${c.reset}`);
  splitGuidanceIntoSteps(err.userGuidance).forEach((step, i) => {
    lines.push(`    ${c.dim}${i + 1}.${c.reset} ${step}`);
  });

  const linkActions = err.recoveryActions.filter((a) => !!a.deepLink);
  if (linkActions.length > 0) {
    lines.push('');
    lines.push(`  ${c.bold}快捷跳转:${c.reset}`);
    for (const a of linkActions) {
      lines.push(
        `    ${c.cyan}${deepLinkToOpenCommand(a.deepLink!, err.platform)}${c.reset}  ${c.dim}# ${a.label}${c.reset}`,
      );
    }
  }

  if (err.terminal) {
    lines.push('');
    lines.push(
      `  ${c.yellow}注意：完成上述操作后再次运行此命令；TabTin 主进程则需要重启才能让权限生效。${c.reset}`,
    );
  }

  return lines.join('\n');
}

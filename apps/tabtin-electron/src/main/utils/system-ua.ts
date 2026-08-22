/**
 * 构造系统 User-Agent（主进程专用）
 *
 * 设计原则：
 * 1) 平台来自主进程的 process.platform（最准确）
 * 2) Chrome 版本来自 process.versions.chrome（不硬编码）
 * 3) 仅作为默认 UA 使用，具体场景可再覆盖
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../logger';

const log = createLogger('system-ua');

const execAsync = promisify(exec);

// 缓存 Darwin 版本（避免重复调用）
let cachedDarwinVersion: string | null = null;

/**
 * 获取 macOS 的 Darwin 内核版本（用于 Client Hints）
 * @returns Darwin 版本号（如 "26.0.0"）
 */
export async function getDarwinVersion(): Promise<string> {
  if (cachedDarwinVersion) {
    return cachedDarwinVersion;
  }

  try {
    const { stdout } = await execAsync('uname -r');
    cachedDarwinVersion = stdout.trim();
    return cachedDarwinVersion;
  } catch (error) {
    log.warn('无法获取 Darwin 版本，使用默认值', error);
    // 降级：从 process.versions 或默认值
    return '24.0.0'; // macOS Sonoma 默认
  }
}

export function buildSystemUserAgent(): string {
  const platform = process.platform; // darwin | win32 | linux
  const arch = process.arch; // x64 | arm64 | ia32
  const chromeVersion = process.versions?.chrome || '122.0.0.0'; // Electron 34.x 默认约 122

  switch (platform) {
    case 'darwin':
      return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    case 'win32':
      return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    case 'linux':
      if (arch === 'arm64') {
        return `Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      }
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    default:
      return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }
}

/**
 * 获取系统的真实架构（用于 Client Hints）
 * @returns "arm" 或 "x86"
 */
export function getSystemArch(): 'arm' | 'x86' {
  const arch = process.arch;
  if (arch === 'arm64' || arch === 'arm') {
    return 'arm';
  }
  return 'x86';
}


import { detectPlatform } from './detect';
import { DarwinSandbox } from './darwin';
import { LinuxSandbox } from './linux';
import { WindowsSandbox } from './windows';
import type { PlatformSandbox } from './types';

export type { PlatformSandbox, SandboxParams, SandboxSpawnArgs } from './types';
export { resetDetectionCache } from './detect';

/** 不支持的平台 — isAvailable() 永远返回 false */
class UnsupportedSandbox implements PlatformSandbox {
  readonly platform = 'unsupported' as const;

  async isAvailable(): Promise<boolean> {
    return false;
  }

  buildSpawnArgs(): never {
    throw new Error('OS sandbox is not supported on this platform');
  }
}

/**
 * 创建当前平台的沙箱适配器
 *
 * - macOS   → DarwinSandbox (sandbox-exec)
 * - Linux   → LinuxSandbox (bwrap)
 * - Windows → WindowsSandbox (WSL2 用 bwrap，原生降级)
 * - 其他     → UnsupportedSandbox
 */
export function createPlatformSandbox(): PlatformSandbox {
  const platform = detectPlatform();
  switch (platform) {
    case 'darwin':
      return new DarwinSandbox();
    case 'linux':
      return new LinuxSandbox();
    case 'windows':
      return new WindowsSandbox();
    default:
      return new UnsupportedSandbox();
  }
}

/**
 * Platform storage roots（agent-runtime 侧本地副本）。
 *
 * 与 `@tabtin/shared/storage-paths` 的 `getHomeTabtinPath` /
 * `getPlatformBaseRoot` / `getDataRoot` 字节对齐；runtime 本地持有一份，
 * 避免生产依赖 `@tabtin/shared`。改算法时两边同步。
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 运行时根。Electron 会在启动期注入 profile 私有的 TABTIN_RUNTIME_ROOT；
 * Daemon / 独立 CLI 未注入时保持历史 ~/.tabtin 兼容。
 */
export function getHomeTabtinPath(...subSegments: string[]): string {
  const runtimeRoot = (process.env.TABTIN_RUNTIME_ROOT || '').trim();
  const root = runtimeRoot ? path.resolve(runtimeRoot) : path.join(os.homedir(), '.tabtin');
  return path.join(root, ...subSegments);
}

/**
 * Platform base：env `TABTIN_PLATFORM_BASE_ROOT` 优先，否则按 OS 分档。
 * darwin → Application Support/TabTin；win32 → APPDATA/TabTin；其它 → ~/.tabtin。
 */
export function getPlatformBaseRoot(): string {
  const envRoot = (process.env.TABTIN_PLATFORM_BASE_ROOT || '').trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TabTin');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'TabTin');
  }
  return path.join(os.homedir(), '.tabtin');
}

/**
 * 新单根。env `TABTIN_DATA_ROOT` 优先，否则回落 `getPlatformBaseRoot()`。
 * `users/{userId}/…` 等新布局全部挂在此下。
 */
export function getDataRoot(): string {
  const envRoot = (process.env.TABTIN_DATA_ROOT || '').trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  return getPlatformBaseRoot();
}

/**
 * 解析 data root：显式 override 优先，否则 `getDataRoot()`。
 * 对齐 `@tabtin/terminal-core` `resolveDataRoot`。
 */
export function resolveDataRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return getDataRoot();
}

/**
 * @deprecated ：使用 `getDataRoot` + workspace/organization/user
 * 系列 resolver。此函数为过渡期兼容返回旧 platform-data 路径，供未迁移调用方
 * 编译；新代码不得引用。
 */
export function getPlatformDataRoot(): string {
  return path.join(getPlatformBaseRoot(), 'platform-data', 'organizations');
}

/**
 * @deprecated ：使用 `resolveDataRoot`。此函数返回旧 platform-data
 * 路径供过渡期兼容。
 */
export function resolvePlatformDataRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return getPlatformDataRoot();
}

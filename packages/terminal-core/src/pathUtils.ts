import path from 'node:path';
import {
  getSpacesRoot as _getSpacesRoot,
  getPlatformDataRoot as _getPlatformDataRoot,
  getDataRoot as _getDataRoot,
  getCommandSandboxRoot as _getCommandSandboxRoot,
} from '@tabtin/shared/storage-paths';

/**
 * Explicit workspace root override（测试 / CLI `--workspace-root` 用）。
 *
 * 生产链路里 workspaceRoot 由宿主（Electron `ElectronAgentHost` / Daemon
 * `DaemonAgentHost`）从 Space 配置 / `config.workspace_root` 解析后传入
 * EngineConfig；本函数主要给独立脚本 / 测试用。
 *
 * 优先级（高 → 低）：
 *   1. `explicitRoot` 入参
 *   2. `TABTIN_WORKSPACE_ROOT` env
 *   3. `process.cwd()`
 */
export function resolveWorkspaceRoot(explicitRoot?: string): string {
  const envRoot = (process.env.TABTIN_WORKSPACE_ROOT || '').trim();
  const base = explicitRoot || envRoot || process.cwd();
  return path.resolve(base);
}

/**
 * 新单根：所有 per-user / per-organization / per-workspace 元数据
 * 挂在此下。优先 `explicitRoot` → env `TABTIN_DATA_ROOT` → `getPlatformBaseRoot()`。
 */
export function resolveDataRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return _getDataRoot();
}

/**
 * @deprecated ：使用 `resolveDataRoot` + workspace/organization/user
 * 系列 resolver。旧「spacesRoot」布局（`{platformBase}/organizations/`）仅供
 * 未迁移调用方过渡编译；新代码不得引用。
 */
export function resolveSpacesRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return _getSpacesRoot();
}

/**
 * @deprecated ：使用 `resolveDataRoot`。旧「platform-data」布局
 * （`{platformBase}/platform-data/organizations/`）仅供过渡编译，
 * 新代码不得引用。
 */
export function resolvePlatformDataRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return _getPlatformDataRoot();
}

/**
 * OS 级命令沙箱的工作根（见 `storage-paths.getCommandSandboxRoot`）。
 *
 * 仅 `CommandExecutor` / `SandboxManager` 用；产品语义跟 workspace /
 * platform-data **无关**，是"命令沙箱专用的临时工作父目录"。
 */
export function resolveCommandSandboxRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  return _getCommandSandboxRoot();
}

/**
 * 平台自产临时产物目录 —— Agent / CLI 自己落盘、再引导读回的路径。
 *
 * 这些目录在 workspace（单根 working_dir）之外，但不是用户资产边界穿越：
 *   - `~/.tabtin/cli-outputs/`：Go CLI 大输出 spill
 *   - `$TMPDIR/tabtin-agent-tasks/`：shell 后台任务 transcript
 *   - `$TMPDIR/tabtin-tool-results/`：shell 大输出落盘（agent-runtime shell.ts）
 *
 * **只读**访问可跳过 workspace_out；写 / 删仍走区外审批。
 * SSoT 列表集中于此，judge file/shell 共用 `isPlatformArtifactReadAllowed`。
 * 路径 normalize 会对齐 macOS `/var` ↔ `/private/var` realpath 差异。
 */

import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { tabtinAgentTasksDir } from '@tabtin/terminal-core';

import { isPathInAllowedRoots, normalize } from './path-normalize.js';

/** Go CLI spill 子目录名（与 tabtin-cli-go/internal/output/spill.go 对齐）。 */
export const CLI_OUTPUTS_DIR_NAME = 'cli-outputs';

/** shell 大输出 spill 子目录名（与 agent-runtime shell.ts persistLargeOutput 对齐）。 */
export const TABTIN_TOOL_RESULTS_DIR_NAME = 'tabtin-tool-results';

/**
 * 返回平台自产产物根目录（绝对路径、未强制 realpath）。
 * `homeDir` 缺省取 `os.homedir()`，便于测试注入。
 */
export function getPlatformArtifactRoots(homeDir?: string): string[] {
  const home = typeof homeDir === 'string' && homeDir.length > 0
    ? homeDir
    : nodeOs.homedir();
  return [
    nodePath.join(home, '.tabtin', CLI_OUTPUTS_DIR_NAME),
    tabtinAgentTasksDir(),
    nodePath.join(nodeOs.tmpdir(), TABTIN_TOOL_RESULTS_DIR_NAME),
  ];
}

/**
 * 规范化路径是否落在平台自产产物根下（含根目录本身）。
 * 入参应为 judge 已 normalize 过的 path；内部对 roots 再 normalize 一次以对齐
 * macOS `/var` ↔ `/private/var` 等 realpath 差异。
 */
export function isPlatformArtifactPath(
  normalizedPath: string,
  homeDir?: string,
): boolean {
  if (typeof normalizedPath !== 'string' || normalizedPath.length === 0) {
    return false;
  }
  const roots = getPlatformArtifactRoots(homeDir).map(
    (root) => normalize(root, homeDir).path,
  );
  return isPathInAllowedRoots(normalizedPath, roots);
}

/**
 * 平台自产产物的**只读**放行条件。写操作一律 false（调用方走 workspace_out）。
 */
export function isPlatformArtifactReadAllowed(
  normalizedPath: string,
  isWrite: boolean,
  homeDir?: string,
): boolean {
  if (isWrite) return false;
  return isPlatformArtifactPath(normalizedPath, homeDir);
}

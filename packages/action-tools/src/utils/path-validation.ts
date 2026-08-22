import { realpathSync } from 'node:fs';
import { resolve, normalize, sep, dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { matchSensitivePath } from '@tabtin/terminal-core';

export interface ValidateProjectPathOpts {
  /**
   * 路径权限治理 Wave 1：v3 SSoT 多目录工作区列表。
   *
   * 由调用方从 `WorkspaceSnapshot.allowedPaths` 透传——含 sandbox /
   * 用户在 TabCode/TabFolder 打开的项目目录的合并视图。本函数把它们
   * 都加入 `allowedPrefixes`，然后做 realpath 后的前缀比对。
   *
   * 旧 `workspaceRoot?: string` 单字符串字段已删除（与"D3 不留兼容"
   * 决策一致）—— FrontendActionBridge / 其他调用方必须迁移到数组。
   */
  workspaceRoots?: readonly string[];
  /**
   * 路径权限治理 Wave 1：本次调用是否已通过 v3 `judge()` 管线。
   *
   * `true` 时 write 路径不再做"physical 必须落在 allowedPrefixes 内"
   * 检查（信任 judge 决策，避免 single-string 时代的双层拦截）。
   * 红线（HARD_DENY_READ_PHYSICAL + matchSensitivePath）始终执行。
   *
   * 缺省 false：保持调用方旧行为，只是 `workspaceRoots` 改为数组。
   */
  alreadyJudged?: boolean;
  /**
   * Platform-data root（`{base}/platform-data/organizations/`）。
   *
   * 2026-05-04 重构后取代原 `sandboxRoot`——skills / sites / downloads /
   * conversations 都在 platform-data 下，action-tools 需要允许读写这里的路径
   * （除了被 `matchSensitivePath` 标为敏感的子路径）。
   *
   * 同时也允许 `spacesRoot`（用户 workspace 根）下的路径——这是由调用方通过
   * `workspaceRoots` 传进来的具体 per-Space workspace 目录；别处没必要单独
   * 允许 spacesRoot 全树。
   */
  platformDataRoot: string;
  homeDir?: string;
}

const HARD_DENY_READ_PHYSICAL = [
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/gshadow',
];

function expandTilde(p: string, home: string): string {
  if (p.startsWith('~' + sep) || p.startsWith('~/')) {
    return resolve(home, p.slice(2));
  }
  return p === '~' ? home : p;
}

function isUnderAny(target: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => target === prefix || target.startsWith(prefix + sep),
  );
}

function resolvePhysical(logical: string): string {
  try {
    return realpathSync(logical);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      try {
        const parentReal = realpathSync(dirname(logical));
        return join(parentReal, basename(logical));
      } catch (parentErr: any) {
        if (parentErr?.code === 'ENOENT') return logical;
        throw parentErr;
      }
    }
    throw err;
  }
}

function isHardDeniedPhysical(physicalPath: string): boolean {
  if (HARD_DENY_READ_PHYSICAL.some((d) => physicalPath === d || physicalPath.startsWith(d + sep))) {
    return true;
  }
  return matchSensitivePath(physicalPath) !== null;
}

/**
 * Direction-sensitive project-path validation with symlink protection.
 *
 * - **write**: physical path (realpath) must be within allowed prefixes.
 *   `alreadyJudged === true` 时跳过此检查（信任 v3 judge 管线决策，
 *   红线 + matchSensitivePath 仍执行）。
 * - **read**: logical path within allowed prefixes AND physical path not
 *   in the hard-deny list → allowed (covers pnpm symlink scenarios).
 *   `alreadyJudged === true` 时跳过 boundary 检查（与 write 对称），
 *   红线（HARD_DENY_READ_PHYSICAL + matchSensitivePath）仍**先于**跳过执行——
 *   judge 已通过仅意味着"工作区/yolo/memo 决策放行"，不等于"红线解锁"。
 *
 * 路径权限治理 Wave 1：旧 single-string `workspaceRoot` 已删除，
 * 改为多目录数组 `workspaceRoots`（v3 SSoT 直接对齐）。
 *
 * 路径权限治理 Wave 2 / W1 遗留 L2：read 路径接 alreadyJudged。
 * 与 `tabcode/index.ts:checkFilePathSecurity` 的 read 分支语义对齐——
 * read_file / grep_search / glob_search（以及内部诊断 fallback）在 enforce 模式下
 * 通过 v3 judge 后，adapter 层注入 `_already_judged: true`，本函数不再
 * 二次拦截 boundary。
 */
export function validateProjectPath(
  actionType: 'read' | 'write',
  projectPath: string,
  opts: ValidateProjectPathOpts,
): void {
  const home = opts.homeDir ?? homedir();
  const expanded = expandTilde(projectPath, home);
  const logical = normalize(resolve(expanded));
  const physical = resolvePhysical(logical);

  const tabtinDir = normalize(resolve(home, '.tabtin'));
  const allowedPrefixes = [tabtinDir, normalize(resolve(opts.platformDataRoot))];
  if (opts.workspaceRoots && opts.workspaceRoots.length > 0) {
    for (const root of opts.workspaceRoots) {
      if (typeof root === 'string' && root.length > 0) {
        allowedPrefixes.push(normalize(resolve(root)));
      }
    }
  }

  if (actionType === 'write') {
    // 红线先于任何放行：HARD_DENY_READ_PHYSICAL + matchSensitivePath 永远执行。
    if (isHardDeniedPhysical(physical)) {
      throw new Error(
        `Write to "${projectPath}" rejected: resolves to a protected system path.`,
      );
    }
    // 已通过 v3 judge 管线 → 跳过 boundary 检查（信任 judge 决策）。
    if (opts.alreadyJudged) return;
    if (!isUnderAny(physical, allowedPrefixes)) {
      // **2026-05-13 重构**：错误是给 LLM 看的，去除用户层产品名
      // ("TabFolder/TabCode" / "Super Permissions" / "Agent Security settings")。
      // 与 `tabcode/index.ts::checkFilePathSecurity` 同步。
      // UI 文案归 i18n 层，工具协议只给 LLM actionable 信号。
      throw new Error(
        `Write to "${projectPath}" rejected: path is outside the allowed workspace. ` +
        `The user must grant access to this directory before the operation can proceed.`,
      );
    }
    return;
  }

  // ── read 分支 ───────────────────────────────────────────────────
  // L2 修复：read 路径也接 `alreadyJudged`（与 write 对称）。
  //
  // **红线必须先于 alreadyJudged 跳过**——judge 已通过只代表"工作区/
  // yolo/memo 决策放行"，不等于"`/etc/shadow` / matchSensitivePath 黑名单
  // 解锁"。这跟 `tabcode/index.ts:checkFilePathSecurity` 的红线策略一致
  // （Wave 1 已经在 write/read 都在第 1 步跑红线，本函数 L2 修复后语义
  // 统一）。
  if (isHardDeniedPhysical(physical)) {
    throw new Error(
      `Read of "${projectPath}" rejected: resolves to a protected system path.`,
    );
  }
  if (opts.alreadyJudged) return;

  const logicalAllowed = isUnderAny(logical, allowedPrefixes);
  if (logicalAllowed) {
    return;
  }

  if (isUnderAny(physical, allowedPrefixes)) {
    return;
  }

  throw new Error(
    `Read of "${projectPath}" rejected: path is outside allowed directories.`,
  );
}

/**
 * path-access-checker — 渲染层 IPC 路径权限单源
 *
 * 路径权限治理 Wave 2 落地。把"文件系统 / git / checkpoint IPC 是否允许
 * 操作这条路径"的判定收敛到一份实现，消费 v3
 * `WorkspaceSnapshot.allowedPaths`，与 LLM 工具链路（tabcode-adapter →
 * action-tools）共享同一份权限单源。
 *
 * 替代的老模型：
 *   - O6 `file-system/ipc.ts: isPathAllowed`（被 14 处 IPC handler 调用）
 *   - O7 `getShellAllowedDirs` 硬编码 4 条目录
 *   - O8 `getEffectiveDenyReadPaths` / `updateSpaceDenyPaths`（注：O8 是死代码）
 *   - O9 `matchDenyPattern`（在 ipc.ts + git-ipc.ts 重复实现两份）
 *   - O11 `git-ipc.ts: isGitPathAllowed`
 *   - O12 `git-ipc.ts: getGitAllowedDirs`
 *   - O13 `git-ipc.ts: validateCwd`
 *   - O14 `checkpoint-ipc.ts: isProjectPathSafe`
 *
 * 设计要点：
 *   1. **唯一权威边界 = `WorkspaceSnapshot.allowedPaths`**——通过
 *      `getAllowedPaths()` 闭包动态消费当前 session 的快照。单根契约
 *      （docs/single-root-space-prd.md §2.1）下 allowedPaths 由 main 端从
 *      `sources.sandbox + sources.workingDir + sources.sessionApprovedPaths`
 *      派生：working_dir 来自 agent.working_dir，sessionApprovedPaths 来自
 *      ApprovalPanel 审批通过的路径（session 内有效）。
 *   2. **平台基础路径**（ 硬切后仅 `dataRoot` / downloads）作为
 *      `getPlatformAllowedDirs()` 单独传——它们是 IPC 层面的"恒定可访问
 *      区"（保存 Skills / 下载 / 会话归档等新布局数据），不进 snapshot 但永远允许。
 *      legacy `spacesRoot` / `platformDataRoot` **不再**列入生产允许目录——
 *      运行时读写已硬切新布局，遗留数据只经一次性迁移脚本搬迁，不作为
 *      IPC 边界放行依据。M3.1.1 起 home 已经默认进 snapshot.allowedPaths，
 *      不在这里重复。
 *   3. **修 inWorkspace=false bug**（断层 7）：调 `checkSensitivePath` 时
 *      用真值的 inWorkspace（`isPathInAllowedRoots(path, allRoots)`），跟
 *      v3 judge step 4 同语义。旧 `isPathAllowed` / `isGitPathAllowed` 都
 *      是硬编码 false，让"工作区内的敏感读"差异化语义失效。
 *   4. **错误信息 actionable**：所有拒绝都给"为什么拒 + 用户该怎么办"
 *      —— 与 Wave 1 在 action-tools 的错误文案对齐。
 *
 * 不变量（深度防御）：
 *   - 红线（`matchSensitivePath` + `checkHardlinePath`）永远先于 boundary。
 *     即便 allowedPaths 包含某条路径，落到 `/etc/shadow` 仍然被拒。
 *   - 敏感路径四态（`checkSensitivePath`）夹在红线之后、deny 列表之前——
 *     与 Wave 1 `checkFilePathSecurity` 的语义对齐。
 *
 * spaceId 路由（Wave 3 落定 / 多窗口为后续遗留）：
 *
 * **Wave 3 现状**：providers.getAllowedPaths 闭包**按当前活跃 spaceId 取单
 * session 的 allowedPaths**，不再 union 所有 session（修 L14）。装配代码在
 * `ElectronAgentHost.ts:setRendererWorkspaceProviders` 处——闭包通过
 * `findSessionSnapshotByActiveSpaceId()` 查 main 端 cli-context 的 currentSpaceId
 * （由 `space:set-active` IPC 在 Space 切换时同步更新），找到对应 session 后取
 * 它的 snapshot。
 *
 * 多 Space 隔离场景（dogfood 单窗口模式）已闭环：
 *   - Space A 用户在 TabCode 打开 `/Users/me/proj-A/`
 *   - Space B 用户在 TabFolder 打开 `/Volumes/外接盘/proj-B/`
 *   - 用户切到 Space B 后调 `fs:writeFile('/Volumes/外接盘/proj-B/x')` →
 *     getCLISpaceId()=B → 取 B session.allowedPaths → 命中 → 放行
 *   - 用户切到 Space A 后调同一 IPC → 取 A session.allowedPaths → 不命中 →
 *     拒（不会再"借 B 的路径走 A"）
 *
 * **后续遗留**：multi-window split view（每个 BrowserWindow 持有不同活跃
 * Space）超出 Wave 3 范围——`getCLISpaceId()` 是 main 模块单例，不能区分多
 * 窗口。要改进时 providers 闭包内部从"无参数读全局"切到"按 IPC sender 路由"
 * 即可，工厂 API 形态不变；但 IPC 调用入口需要带 sender 上下文。归后续 wave。
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import {
  checkHardlinePath,
  checkSensitivePath,
  isPathInAllowedRoots,
} from '@tabtin/security-policy'
import { matchSensitivePath } from '@tabtin/terminal-core'

// packaged Electron 主进程是纯 ESM bundle（electron-vite 输出 format='es'，
// 顶部无 esbuild `__require` polyfill / 全局 `require` 守卫）。下面 lazy
// require 段如果直接写裸 `require(...)`，bundle 会原样保留字面量，运行时
// `ReferenceError: require is not defined` —— W7c 现场 checkpoint:init /
// checkpoint:writeTree 撞此雷整链不工作。
//
// 解法照抄 SubprocessPtyHost.ts 的范式：在文件顶部用 createRequire 显式
// 构造一份本地 require，bundle 后被 esbuild 重命名（如 `require$1`）以
// 避免与全局名冲突；packaged ESM 与 dev 双边都安全。
//
// dev 模式下不受影响：同名变量 shadow 全局即可（createRequire 本身幂等）。
const require = createRequire(import.meta.url)

// ─── 常量 ────────────────────────────────────────────────────────────

/**
 * 默认 deny read 列表——凭据 / 系统配置子树。
 *
 * 来源：原 `file-system/ipc.ts` + `git-ipc.ts` 各自维护一份的同名常量
 * （冗余 4：完全重复实现）合并到此。Wave 2 收敛后两个 IPC 模块共享。
 */
const DEFAULT_DENY_READ_PATTERNS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.netrc',
  '~/.kube',
  '~/.config/gcloud',
  '~/.config/op',
  '~/.config/gh',
  '~/.docker/config.json',
  '~/.npmrc',
  '~/.pypirc',
]

/**
 * 默认 deny write 列表——`.env` / `.env.*` 这类敏感配置。
 */
const DEFAULT_DENY_WRITE_PATTERNS: readonly string[] = ['.env', '.env.*']

// ─── Public types ──────────────────────────────────────────────────

export type PathAccessAction = 'read' | 'write' | 'delete'

/**
 * 拒绝原因枚举。
 *
 * UI 文案 / 日志区分时按此分类——产品上：
 * - `hardline`：系统红线，永远拒（用户也不能解锁）
 * - `sensitive`：敏感子目录（凭据等）；出现在工作区外的写、敏感读
 * - `deny_list`：用户 / Space 配置的 deny pattern 命中
 * - `outside_workspace`：路径不在当前 workspace + 平台基础路径之内
 *   → 这是用户**可以**解决的："请在 TabFolder/TabCode 打开该文件夹"
 * - `invalid_path`：参数本身无效（空 / 非字符串）
 */
export type PathAccessReasonCode =
  | 'hardline'
  | 'sensitive'
  | 'deny_list'
  | 'outside_workspace'
  | 'invalid_path'

export interface PathAccessReason {
  reasonCode: PathAccessReasonCode
  message: string
}

export interface PathAccessResult {
  allowed: boolean
  /** 拒绝时一定有；放行时为 undefined。 */
  reason?: PathAccessReason
}

export interface PathAccessCheckerOptions {
  /**
   * 闭包：返回当前 session 的 v3 `WorkspaceSnapshot.allowedPaths`。
   *
   * 每次 `check()` 调用时取——用户在 TabCode / TabFolder 临时打开 / 关闭
   * 项目时实时同步进来（`workspace:paths-changed` IPC mutate snapshot）。
   *
   * 注意：snapshot 可能为空（用户还没打开任何项目）。空数组时 boundary
   * 完全靠 `getPlatformAllowedDirs()` 的平台基础路径兜底——跟 LLM 工具
   * 链路语义对齐（headless 直调 + workspaceRoots 为空时只走红线兜底）。
   */
  getAllowedPaths: () => readonly string[]

  /**
   * 闭包：返回当前 session 的 `WorkspaceSnapshot.allowedFiles`。
   *
   * 多数 fs / git / checkpoint IPC 调用方拿不到文件级精确名单（这是
   * 附件级 attachment，不是工作区级），缺省返回空数组。保留闭包形式
   * 给将来"附件 fs 操作"用。
   */
  getAllowedFiles?: () => readonly string[]

  /**
   * 平台基础数据路径——IPC 层面的"恒定可访问区"，不进 snapshot 但永远
   * 算在工作区内。
   *
   *  硬切后组成：
   *   - `app.getPath('downloads')`：用户下载目录（fs IPC 用，git / checkpoint 一般不用）
   *   - `resolveDataRoot()`：新布局 skills / plugins / conversations / downloads / sites 根
   *   - `app.getPath('home')`：用户家（M3.1.1 后默认在 snapshot 里也有，
   *     但我们仍把它列在这里——平台路径是 IPC 自带语义，不依赖 snapshot
   *     状态；snapshot 为空时也得让 home 通过）
   *
   * **不再**包含 `resolveSpacesRoot()` / `resolvePlatformDataRoot()`——这两
   * 个是 legacy 布局根，运行时读写已硬切到 `dataRoot + userId`，遗留数据
   * 只经一次性迁移脚本搬迁，不作为生产允许目录。working_dir 本身通过
   * `getAllowedPaths()`（v3 WorkspaceSnapshot）传入，不在此列。
   */
  getPlatformAllowedDirs: () => readonly string[]

  /**
   * 自定义 deny read pattern 列表（追加到 `DEFAULT_DENY_READ_PATTERNS`）。
   *
   * Space 级 deny 注入接口曾经存在（O8 `updateSpaceDenyPaths`）但实际上
   * 没有 caller——Wave 2 收敛时一并删除。如果将来恢复 Space 级 deny，
   * 通过此参数从外部传入即可。
   */
  denyReadPatterns?: readonly string[]

  /** 自定义 deny write pattern 列表（追加到 `DEFAULT_DENY_WRITE_PATTERNS`）。 */
  denyWritePatterns?: readonly string[]

  /** 用于 `~/` 展开；缺省走 `process.env.HOME`。 */
  homeDir: string
}

export interface PathAccessChecker {
  /**
   * 判定一条路径是否允许执行指定动作。
   *
   * 输入：
   *   - `filePath`：调用方应已经过 `path.resolve(...)` 转成绝对路径——
   *     工厂内部不再做 resolve，避免反复抖磁盘
   *   - `action`：`'read'` / `'write'` / `'delete'`；`'delete'` 在 deny
   *     列表 / 敏感路径侧按写处理（与原 `isPathAllowed` 对齐）
   *
   * 输出：
   *   - `{ allowed: true }`：放行
   *   - `{ allowed: false, reason: { reasonCode, message } }`：拒绝
   *
   * 不抛异常——所有边界情况转 result envelope（与 IPC handler 风格一致）。
   */
  check(filePath: string, action: PathAccessAction): PathAccessResult
}

// ─── 工厂 ───────────────────────────────────────────────────────────

export function createPathAccessChecker(
  options: PathAccessCheckerOptions,
): PathAccessChecker {
  const denyReadPatterns: readonly string[] = options.denyReadPatterns
    ? [...DEFAULT_DENY_READ_PATTERNS, ...options.denyReadPatterns]
    : DEFAULT_DENY_READ_PATTERNS
  const denyWritePatterns: readonly string[] = options.denyWritePatterns
    ? [...DEFAULT_DENY_WRITE_PATTERNS, ...options.denyWritePatterns]
    : DEFAULT_DENY_WRITE_PATTERNS

  return {
    check(filePath: string, action: PathAccessAction): PathAccessResult {
      if (!filePath || typeof filePath !== 'string') {
        return {
          allowed: false,
          reason: {
            reasonCode: 'invalid_path',
            message: 'Path is required and must be a non-empty string.',
          },
        }
      }

      const isWrite = action === 'write' || action === 'delete'

      // 1) 红线：永远先于 boundary。即使 allowedPaths 包含也得拒。
      const hardline = checkHardlinePath(filePath, 'file')
      if (hardline.hit) {
        return {
          allowed: false,
          reason: {
            reasonCode: 'hardline',
            message:
              hardline.description ??
              `Operation blocked: path '${filePath}' hits the system hardline.`,
          },
        }
      }
      // matchSensitivePath（terminal-core）独立于 v3 judge——专为
      // /etc/shadow / .ssh/id_rsa 等"无论上下文都不让碰"的路径黑名单。
      const sensitiveLabel = matchSensitivePath(filePath)
      if (sensitiveLabel) {
        return {
          allowed: false,
          reason: {
            reasonCode: 'hardline',
            message: `Access to sensitive path '${sensitiveLabel}' is blocked for security reasons.`,
          },
        }
      }

      // 2) deny pattern：用户 / 平台显式禁的子树
      const denyPatterns = isWrite
        ? [...denyWritePatterns, ...denyReadPatterns]
        : denyReadPatterns
      for (const pattern of denyPatterns) {
        if (matchDenyPattern(filePath, pattern, options.homeDir)) {
          return {
            allowed: false,
            reason: {
              reasonCode: 'deny_list',
              message:
                `Path '${filePath}' is blocked by ${isWrite ? 'write' : 'read'} deny list ` +
                `(pattern: ${pattern}). Adjust Agent Security settings if this is intentional.`,
            },
          }
        }
      }

      // 3) 敏感路径四态：用真值的 inWorkspace 算（修旧实现 inWorkspace=false 硬编码 bug）
      const normalizedPath = normalizeBoundaryPath(filePath)
      const allowedPaths = options.getAllowedPaths()
        .map(normalizeBoundaryPath)
        .filter(Boolean)
      const allowedFiles = (options.getAllowedFiles?.() ?? [])
        .map(normalizeBoundaryPath)
        .filter(Boolean)
      const platformDirs = options.getPlatformAllowedDirs()
        .map(normalizeBoundaryPath)
        .filter(Boolean)
      // 工作区判定的"全集" = v3 snapshot 的 allowedPaths ∪ 平台基础路径
      // 两者都对当前用户而言是合法工作区——前者动态、后者恒定。
      const allRoots: readonly string[] = [...allowedPaths, ...platformDirs]
      const inWorkspace = isPathInAllowedRoots(normalizedPath, allRoots, allowedFiles)

      const sensitive = checkSensitivePath(filePath, 'file', inWorkspace, isWrite)
      if (sensitive.hit && sensitive.action === 'deny') {
        return {
          allowed: false,
          reason: {
            reasonCode: 'sensitive',
            message:
              sensitive.description ??
              `Operation blocked: path '${filePath}' resolves to a sensitive location.`,
          },
        }
      }

      // 4) workspace boundary
      if (!inWorkspace) {
        return {
          allowed: false,
          reason: {
            reasonCode: 'outside_workspace',
            message:
              `Path '${filePath}' is outside your workspace. ` +
              `Open this folder in TabFolder/TabCode to authorize, ` +
              `or toggle Super Permissions in Agent Security settings.`,
          },
        }
      }

      return { allowed: true }
    },
  }
}

// ─── singleton + 渲染层 IPC 共享入口 ───────────────────────────────
//
// fs / git / checkpoint 三个 IPC 模块共享同一个 checker 实例——避免每个
// 模块各自拼装 platformAllowedDirs / 闭包 / homeDir，集中"装配点"在此。
//
// 注入时序：ElectronAgentHost 在 sessions 体系起来之后调
// `setRendererWorkspaceProviders` 把"按当前活跃 spaceId 取单 session
// snapshot.allowedPaths 闭包"塞进来；IPC handler 在请求进来时 lazy
// `getDefaultPathAccessChecker()` 取实例 → check()。
//
// Wave 3 落定：providers 闭包按 `getCLISpaceId()` 路由到当前活跃 Space 的
// session（修 L14）。多窗口 split view 下 getCLISpaceId 是模块单例不能区分
// 多窗口——后续 wave 改进路径见文件顶部 "spaceId 路由" 段。
//
// 测试场景下若不调 setRendererWorkspaceProviders，闭包默认返回 [] —— 允许
// 列表只包含 platformAllowedDirs（home / dataRoot / downloads）。这跟
// "用户没在 TabFolder/TabCode 打开任何项目"的真实场景一致——sandbox 那条
// 仍可用，跨盘项目不行。

interface RendererWorkspaceProviders {
  getAllowedPaths: () => readonly string[]
  getAllowedFiles?: () => readonly string[]
}

let _rendererProviders: RendererWorkspaceProviders | null = null

/**
 * 注入"渲染层 IPC 共享的工作区 providers 闭包"。
 *
 * 由 ElectronAgentHost 在初始化 sessions 链路时调用一次。后续每次
 * `getDefaultPathAccessChecker().check()` 时通过闭包动态取最新值——
 * 用户在 TabCode / TabFolder 临时打开新项目（`workspace:paths-changed`
 * IPC mutate snapshot）时无需重新装配 checker。
 *
 * **Wave 3 落定**：闭包按当前活跃 spaceId 取单 session 的 allowedPaths
 * （修 L14 多 Space 互相污染）。装配代码 host 端用 `findSessionSnapshotByActiveSpaceId`
 * 查 cli-context.currentSpaceId（由 `space:set-active` IPC 同步更新）。
 * 多窗口 split view（每个窗口独立 active Space）超出 Wave 3 范围——闭包内部
 * 行为可后续替换为"按 IPC sender 路由"，工厂 API 不变。
 */
export function setRendererWorkspaceProviders(providers: RendererWorkspaceProviders): void {
  _rendererProviders = providers
  // 注意：不重置 `_defaultChecker`——它通过 `_rendererProviders` 闭包动态
  // 取值，模块级变量更新即可（Wave 2 第一轮技术 Review P2-4 简化）。
}

/** 仅限测试：重置 providers（不影响 singleton checker，闭包语义保证）。 */
export function resetRendererWorkspaceProvidersForTest(): void {
  _rendererProviders = null
}

let _defaultChecker: PathAccessChecker | null = null

/**
 * 渲染层 IPC 共享的 checker 实例（singleton）。
 *
 * lazy 初始化——第一次 IPC 调用时才构造。避免 module 顶层 import 期
 * eager 拉 `electron` / `@tabtin/terminal-core`（测试场景可能跑在
 * non-electron 进程）。
 */
export function getDefaultPathAccessChecker(): PathAccessChecker {
  if (_defaultChecker) return _defaultChecker

  // lazy require——测试可以替换 `_defaultChecker` 走自己的 stub。
  // 这里的 `require` 是文件顶部 `createRequire(import.meta.url)` 显式构造
  // 的本地 require（不是全局），packaged ESM bundle 也工作；千万别改回
  // 顶部 ESM static import，否则测试场景（vitest 跑 main 单测）module
  // load 期就会拉 `electron` 模块，在 non-electron 进程里直接炸。
  const { app } = require('electron') as typeof import('electron')
  const {
    resolveDataRoot,
  } = require('@tabtin/terminal-core') as typeof import('@tabtin/terminal-core')

  let homeDir: string
  try {
    homeDir = app.getPath('home')
  } catch {
    homeDir = process.env.HOME ?? ''
  }

  _defaultChecker = createPathAccessChecker({
    getAllowedPaths: () => _rendererProviders?.getAllowedPaths() ?? [],
    getAllowedFiles: () => _rendererProviders?.getAllowedFiles?.() ?? [],
    getPlatformAllowedDirs: () => {
      const dirs: string[] = []
      try {
        dirs.push(app.getPath('home'))
      } catch {
        // app 未 ready 时（极早期启动）跳过——getAllowedPaths 闭包仍可兜
      }
      try {
        dirs.push(app.getPath('downloads'))
      } catch {
        // 同上
      }
      try {
        dirs.push(resolveDataRoot())
      } catch {
        // dataRoot 未初始化时跳过（ 新单根，覆盖 users/.../workspaces）
      }
      // ：resolveSpacesRoot() / resolvePlatformDataRoot() 硬切移除——
      // legacy 布局根不再作为生产允许目录，遗留数据只经一次性迁移脚本搬迁。
      return dirs
    },
    homeDir,
  })
  return _defaultChecker
}

/** 仅限测试：重置 singleton（不重置 providers）。 */
export function resetDefaultPathAccessCheckerForTest(): void {
  _defaultChecker = null
}

/**
 * 拿当前 session 的 v3 snapshot.allowedPaths——给 FrontendActionBridge 调
 * `validateProjectPath` 时透传用。
 *
 * 与 `getDefaultPathAccessChecker().check()` 不同的是：本函数仅返回数组，
 * 不做判定——`validateProjectPath`（@tabtin/action-tools/headless）有自己
 * 的语义（platformDataRoot 兜底 / read 的 logical-vs-physical 双层放行
 * 等），不能直接被 path-access-checker.check() 替代。
 *
 * 没注入 providers 时返回空数组——`validateProjectPath` 会退化到 platform
 * data 兜底 + 红线，与 LLM 工具链路 headless 直调时的语义对齐。
 */
export function getCurrentAllowedWorkspaceRoots(): readonly string[] {
  return _rendererProviders?.getAllowedPaths() ?? []
}

// ─── 内部 helper ─────────────────────────────────────────────────────

/**
 * deny pattern 匹配。
 *
 * 来自原 `file-system/ipc.ts` + `git-ipc.ts` 的逐字重复实现（冗余 4），
 * Wave 2 收敛到本工厂内的私有 helper。两个调用方共享同一份语义。
 *
 * 支持三种 pattern 形态：
 *   - `~/.ssh` → 展开 ~ 后做前缀匹配（`/Users/x/.ssh` 命中）
 *   - `.env`   → 仅 basename 匹配
 *   - `.env.*` → glob 通配 basename
 */
function matchDenyPattern(filePath: string, pattern: string, homeDir: string): boolean {
  const norm = normalizeBoundaryPath(filePath)
  let expanded = pattern
  if (pattern.startsWith('~/')) {
    expanded = normalizeBoundaryPath(homeDir).replace(/\/+$/, '') + pattern.slice(1)
  }
  const ne = normalizeBoundaryPath(expanded)
  if (ne.includes('*')) {
    const base = basenameBoundaryPath(norm)
    // glob 转 regex：仅展开最后一段（`.env.*` → 匹配 `.env.local` 之类）
    const lastSegment = basenameBoundaryPath(ne)
    if (lastSegment) {
      const re = new RegExp(
        '^' + lastSegment.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
      )
      if (re.test(base)) return true
    }
  }
  if (norm === ne || norm.startsWith(ne + '/')) return true
  if (!expanded.startsWith('/') && !expanded.startsWith('~/')) {
    if (basenameBoundaryPath(norm) === ne) return true
  }
  return false
}

function normalizeBoundaryPath(filePath: string): string {
  const looksWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\')
  const useWindowsRules = process.platform === 'win32' || looksWindowsAbsolute
  let normalized = useWindowsRules
    ? path.win32.normalize(filePath).replace(/\\/g, '/')
    : filePath

  if (normalized.length > 1 && normalized.endsWith('/')) {
    if (!/^[a-zA-Z]:\/$/.test(normalized) && normalized !== '/') {
      normalized = normalized.replace(/\/+$/, '')
    }
  }
  if (useWindowsRules) {
    normalized = normalized.toLowerCase()
  }
  try {
    return normalized.normalize('NFC')
  } catch {
    return normalized
  }
}

function basenameBoundaryPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? ''
}

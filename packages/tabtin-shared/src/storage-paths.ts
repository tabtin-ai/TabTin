/**
 * storage-paths — TabTin 本地存储路径决议的唯一 SSoT。
 *
 * 所有客户端 / packages 需要决议本地存储路径时必须通过本模块导出的
 * 函数，禁止在业务代码里直接拼 `os.homedir() + '.tabtin'` 等路径。
 *
 * ## 目标物理布局（ 硬切后）
 *
 * ```
 * {dataRoot}/                              ← getDataRoot()
 * │                                          默认等于 getPlatformBaseRoot()
 * │                                          env `TABTIN_DATA_ROOT` 可覆盖
 * │
 * └── users/{userId}/                     ← per-user 命名空间
 *     │
 *     ├── skills/{slug}/                  ← 用户个人 Skill
 *     ├── common/                         ← 用户跨组织共享
 *     └── organizations/{orgId}/          ← per-organization 命名空间
 *         ├── skills/{slug}/              ← 组织 Skill
 *         ├── plugins/                    ← Personal Plugin 挂在组织下（不在 workspace）
 *         │   ├── registry.json
 *         │   └── installed/{pluginId}/
 *         ├── shared/                     ← 组织级共享物件
 *         └── workspaces/{workspaceId}/   ← 仅承载**元数据**（不是 Agent cwd）
 *             ├── downloads/
 *             ├── conversations/
 *             │   ├── sessions/{sessionId}/*.jsonl
 *             │   └── tool-logs/{sessionId}/*.md
 *             └── sites/{siteSlug}/
 * ```
 *
 * ## 关键设计
 *
 *   1. **单 dataRoot**：所有平台托管数据统一挂在 `getDataRoot()` 下的 `users/`
 *      子树，废除历史的 `spaces/` 分层与 `spacesRoot`/`platformDataRoot` 双前缀。
 *   2. **Workspace 只装元数据**：`{dataRoot}/users/.../workspaces/{workspaceId}/`
 *      承载 downloads / conversations / sites 等 Agent 元数据。用户的项目目录
 *      （Agent shell cwd = `Workspace.working_dir`）**不在**这棵树里。
 *   3. **Skill 双层**：`users/{userId}/skills` 为个人 Skill；
 *      `users/{userId}/organizations/{orgId}/skills` 为组织 Skill。scanner 双层扫描。
 *   4. **过渡兼容**：老 `getSpacesRoot()` / `getPlatformDataRoot()` 仍导出，标记
 *      `@deprecated`；调用方逐步迁移到 dataRoot + `resolveWorkspace*` 系列。
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

// ── ~/.tabtin/（跨 app 共享根）──────────────────────────────────

/**
 * 用户主目录下的 TabTin 共享根。三平台一致 `~/.tabtin/...`。
 * 用于 Electron / Daemon / CLI 都要写的全局物件（screenshots / checkpoints / mcp 等）。
 *
 * **不要**在此存放 per-Workspace 数据——走 `getDataRoot()` +
 * `resolveWorkspaceMetadataRoot()`。
 */
export function getHomeTabtinPath(...subSegments: string[]): string {
  const runtimeRoot = (process.env.TABTIN_RUNTIME_ROOT || '').trim()
  const root = runtimeRoot ? path.resolve(runtimeRoot) : path.join(os.homedir(), '.tabtin')
  return path.join(root, ...subSegments)
}

// ── ~/.tabtin-daemon/（Daemon 私有配置）────────────────────────

let _daemonHomeOverride: string | undefined

/**
 * 覆盖 Daemon 私有根目录。Daemon CLI 的 `--config-dir` 参数在
 * 进程启动时调用此函数一次，后续所有 `getDaemonHomePath` 调用
 * 使用覆盖值。传 `undefined` 恢复默认。
 */
export function setDaemonHomeOverride(override: string | undefined): void {
  _daemonHomeOverride = override
}

/**
 * Daemon 私有配置目录。默认 `~/.tabtin-daemon/...`，
 * 可通过 `setDaemonHomeOverride` 覆盖。
 */
export function getDaemonHomePath(...subSegments: string[]): string {
  const root = _daemonHomeOverride ?? path.join(os.homedir(), '.tabtin-daemon')
  return path.join(root, ...subSegments)
}

// ── Electron userData ────────────────────────────────────────────

let _userDataOverride: string | undefined

/**
 * 覆盖 Electron userData 根。**仅在 Electron 主进程可用时**由 App 启动期
 * 调用一次（app.whenReady() 之后，读一次 `app.getPath('userData')` 注入）。
 *
 * 非 Electron 进程（Daemon / CLI / 测试）不调此函数，调用 `getUserDataPath`
 * 会抛错——这是预期行为：Electron 专属路径不应在非 Electron 环境里读。
 */
export function setUserDataOverride(override: string | undefined): void {
  _userDataOverride = override
}

/**
 * Electron `userData` 目录下的路径。示例：
 *   - `getUserDataPath('Partitions')` → `{userData}/Partitions`
 *   - `getUserDataPath('recordings', 'x.mp4')` → `{userData}/recordings/x.mp4`
 *
 * **调用约束**：
 *   - 必须在 `setUserDataOverride` 之后调用；否则抛 `Error('userData not initialized')`
 *   - Electron 主进程在启动期 `app.whenReady()` 之后应立即调用
 *     `setUserDataOverride(app.getPath('userData'))`，让所有模块通过本函数决议路径
 */
export function getUserDataPath(...subSegments: string[]): string {
  if (!_userDataOverride) {
    throw new Error(
      '[storage-paths] userData not initialized — call setUserDataOverride(app.getPath("userData")) in Electron main startup before using',
    )
  }
  return path.join(_userDataOverride, ...subSegments)
}

// ── Platform base（OS-appropriate app data 根）───────────────────

/**
 * TabTin 的平台存储前缀。平台分支：
 *   - macOS:   `~/Library/Application Support/TabTin/`
 *   - Windows: `%APPDATA%/TabTin/`
 *   - Linux:   `~/.tabtin/`
 *
 * env 覆盖：`TABTIN_PLATFORM_BASE_ROOT`（主要测试用）。
 */
export function getPlatformBaseRoot(): string {
  const envRoot = (process.env.TABTIN_PLATFORM_BASE_ROOT || '').trim()
  if (envRoot) {
    return path.resolve(envRoot)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TabTin')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'TabTin')
  }
  return path.join(os.homedir(), '.tabtin')
}

// ── Data Root（ 单根 SSoT）─────────────────────────

/**
 * TabTin 本地数据根（ 引入）。**新代码只经此函数取根**。
 *
 * 决议顺序：
 *   1. env `TABTIN_DATA_ROOT`（主要测试 / 多环境隔离用）
 *   2. `getPlatformBaseRoot()`
 *
 * 所有新的 `resolveUserRoot` / `resolveOrganizationRoot` / `resolveWorkspaceMetadataRoot`
 * 等 helper 都以此为父前缀。
 */
export function getDataRoot(): string {
  const envRoot = (process.env.TABTIN_DATA_ROOT || '').trim()
  if (envRoot) {
    return path.resolve(envRoot)
  }
  return getPlatformBaseRoot()
}

// ── 段合法性校验（与 agent-runtime / terminal-core 同源）───────

const SAFE_STORAGE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._@-]*$/

/** （硬切）：存储段必填，空值直接抛错（禁止 `_unscoped`）。 */
function requireSegment(value: string | undefined, label: string): string {
  if (!value || value.length === 0) {
    throw new Error(
      `storage-paths: ${label} is required ( hard-cut — no _unscoped fallback)`,
    )
  }
  return value
}

/** 单段路径是否安全（不含 / \ .. 等），供路径 helper 调用方前置校验。 */
export function isSafeStoragePathSegment(value: string | undefined): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed !== value) return false
  if (trimmed === '.' || trimmed === '..') return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  if (path.isAbsolute(trimmed)) return false
  return SAFE_STORAGE_SEGMENT_RE.test(trimmed) && !trimmed.includes('..')
}

// ── User / Organization / Workspace 元数据路径────

/** `{dataRoot}/users/{userId}/` */
export function resolveUserRoot(dataRoot: string, userId: string): string {
  return path.join(dataRoot, 'users', requireSegment(userId, 'userId'))
}

/** 用户个人 Skill 目录：`{dataRoot}/users/{userId}/skills/` */
export function resolveUserSkillsDir(dataRoot: string, userId: string): string {
  return path.join(resolveUserRoot(dataRoot, userId), 'skills')
}

/** 用户个人 Skill 单包目录：`{dataRoot}/users/{userId}/skills/{slug}/` */
export function resolveUserSkillDir(
  dataRoot: string,
  userId: string,
  skillSlug: string,
): string {
  return path.join(resolveUserSkillsDir(dataRoot, userId), skillSlug)
}

/** 用户跨组织共享目录：`{dataRoot}/users/{userId}/common/` */
export function resolveUserCommonDir(dataRoot: string, userId: string): string {
  return path.join(resolveUserRoot(dataRoot, userId), 'common')
}

/** `{dataRoot}/users/{userId}/organizations/{orgId}/` */
export function resolveOrganizationRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveUserRoot(dataRoot, userId), 'organizations', requireSegment(orgId, 'orgId'))
}

/** 组织内当前用户的 Agent 撤销快照：`.../organizations/{orgId}/checkpoints/`。 */
export function resolveOrganizationCheckpointsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'checkpoints')
}

/** 组织 Skill 目录：`.../organizations/{orgId}/skills/` */
export function resolveOrganizationSkillsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'skills')
}

/** 组织 Skill 单包目录：`.../organizations/{orgId}/skills/{slug}/` */
export function resolveOrganizationSkillDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  skillSlug: string,
): string {
  return path.join(resolveOrganizationSkillsDir(dataRoot, userId, orgId), skillSlug)
}

/**
 * 组织级 Personal Plugin 根目录：`.../organizations/{orgId}/plugins/`
 *
 * ：Plugin 从 workspace 提到组织层——同组织内所有 workspace 共享。
 */
export function resolveOrganizationPluginsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'plugins')
}

/** 组织级 Personal Plugin registry 文件：`.../plugins/registry.json` */
export function resolveOrganizationPluginRegistryFile(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationPluginsDir(dataRoot, userId, orgId), 'registry.json')
}

/** 组织级单个 Personal Plugin 安装目录：`.../plugins/installed/{pluginId}/` */
export function resolveOrganizationPluginDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  pluginId: string,
): string {
  return path.join(resolveOrganizationPluginsDir(dataRoot, userId, orgId), 'installed', pluginId)
}

/** 组织级共享物件目录：`.../organizations/{orgId}/shared/` */
export function resolveOrganizationSharedDir(
  dataRoot: string,
  userId: string,
  orgId: string,
): string {
  return path.join(resolveOrganizationRoot(dataRoot, userId, orgId), 'shared')
}

/**
 * Workspace 元数据根：`.../organizations/{orgId}/workspaces/{workspaceId}/`。
 *
 * **注意语义**（ §核心）：Workspace 在此路径下**只放元数据**
 * （downloads / conversations / sites）。Agent 的 shell cwd（`Workspace.working_dir`）
 * 由业务侧另行解析，不落在此树里。
 */
export function resolveWorkspaceMetadataRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveOrganizationRoot(dataRoot, userId, orgId),
    'workspaces',
    requireSegment(workspaceId, 'workspaceId'),
  )
}

/** Workspace downloads 目录：`.../workspaces/{workspaceId}/downloads/` */
export function resolveWorkspaceDownloadsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'downloads',
  )
}

/** Workspace conversations 根：`.../workspaces/{workspaceId}/conversations/` */
export function resolveWorkspaceConversationsRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'conversations',
  )
}

/** Workspace 文件回退备份：`.../workspaces/{workspaceId}/file-history/`。 */
export function resolveWorkspaceFileHistoryRoot(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'file-history',
  )
}

/** Session 归档目录：`.../conversations/sessions/{sessionId}/*.jsonl` 的父目录 */
export function resolveWorkspaceSessionArchiveDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceConversationsRoot(dataRoot, userId, orgId, workspaceId),
    'sessions',
  )
}

/** 工具日志目录：`.../conversations/tool-logs/{sessionId}/*.md` 的父目录 */
export function resolveWorkspaceToolLogsDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
): string {
  return path.join(
    resolveWorkspaceConversationsRoot(dataRoot, userId, orgId, workspaceId),
    'tool-logs',
  )
}

/** 单个 TabSite 项目目录：`.../workspaces/{workspaceId}/sites/{siteSlug}/` */
export function resolveWorkspaceSiteDir(
  dataRoot: string,
  userId: string,
  orgId: string,
  workspaceId: string,
  siteSlug: string,
): string {
  return path.join(
    resolveWorkspaceMetadataRoot(dataRoot, userId, orgId, workspaceId),
    'sites',
    siteSlug,
  )
}

// ── 旧 API（deprecated；仅供未迁移的历史调用方过渡期使用）─────

/**
 * @deprecated ：改用 `getDataRoot()` + `resolveWorkspaceMetadataRoot`
 * 等新 helper。此函数返回旧「spacesRoot」布局（`{platformBase}/organizations/`），
 * 仅供未迁移的调用方过渡编译；新代码不得引用。
 */
export function getSpacesRoot(): string {
  return path.join(getPlatformBaseRoot(), 'organizations')
}

/**
 * @deprecated ：改用 `getDataRoot()` + `resolveWorkspaceMetadataRoot`
 * / `resolveOrganizationSkillsDir` 等新 helper。此函数返回旧「platformDataRoot」布局
 * （`{platformBase}/platform-data/organizations/`），仅供过渡编译，新代码不得引用。
 */
export function getPlatformDataRoot(): string {
  return path.join(getPlatformBaseRoot(), 'platform-data', 'organizations')
}

// ── Checkpoints ─────────────────────────────────────────────────

/** Checkpoint shadow git 根：`~/.tabtin/checkpoints`（旧方案，迁移期保留给孤儿清理）。 */
export function getCheckpointsRoot(): string {
  return getHomeTabtinPath('checkpoints')
}

/** Per-file 内容快照根：`~/.tabtin/file-history`（per-file 回退，替代 shadow git）。 */
export function getFileHistoryRoot(): string {
  return getHomeTabtinPath('file-history')
}

// ── Command sandbox root（OS-level sandbox runtime dir）──────────

/**
 * 命令执行沙箱的工作父目录。用于 `CommandExecutor` / `SandboxManager`
 * 下的 threadId 子目录（`{root}/{threadId}/project|tmp`）。
 *
 * **与 per-Workspace 元数据不同**：这是 OS 级命令沙箱的临时工作区，
 * 跟 organization / workspace 维度无关，只按 thread 隔离。
 *
 * 默认 `~/.tabtin/command-sandboxes/`；可被 `TABTIN_COMMAND_SANDBOX_ROOT`
 * env 覆盖（主要测试用）。
 */
export function getCommandSandboxRoot(): string {
  const envRoot = (process.env.TABTIN_COMMAND_SANDBOX_ROOT || '').trim()
  if (envRoot) {
    return path.resolve(envRoot)
  }
  return getHomeTabtinPath('command-sandboxes')
}

// ── 临时目录 ────────────────────────────────────────────────────

/** 在 OS tmpdir 下创建 `tabtin-{prefix}-XXXXXX` 临时目录并返回路径。 */
export async function getTabtinTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `tabtin-${prefix}-`))
}

// ── 已知存储根描述符 ────────────────────────────────────────────

export interface StorageRootDescriptor {
  /** 机器可读 id，跨版本稳定 */
  id: string
  /** 人类可读标签（用于 UI / CLI 展示） */
  label: string
  /** 返回该根的绝对路径 */
  pathFn: () => string
  /** 归属范围 */
  scope: 'shared' | 'daemon-only' | 'platform-dependent'
}

/**
 * 返回所有已知的本地存储根目录描述符。
 * "卸载残留扫描"遍历此列表，检查每个 pathFn() 返回的目录是否存在。
 */
export function getKnownStorageRoots(): StorageRootDescriptor[] {
  return [
    {
      id: 'home-tabtin',
      label: '~/.tabtin',
      pathFn: () => getHomeTabtinPath(),
      scope: 'shared',
    },
    {
      id: 'daemon-home',
      label: '~/.tabtin-daemon',
      pathFn: () => getDaemonHomePath(),
      scope: 'daemon-only',
    },
    {
      id: 'platform-base',
      label: 'TabTin platform base (workspaces + platform-data)',
      pathFn: getPlatformBaseRoot,
      scope: 'platform-dependent',
    },
    {
      id: 'data-root',
      label: 'TabTin data root (users/…/organizations/…/workspaces/…)',
      pathFn: getDataRoot,
      scope: 'platform-dependent',
    },
    {
      id: 'spaces-root',
      label: 'Legacy user workspaces (deprecated, retained for uninstall scan)',
      pathFn: getSpacesRoot,
      scope: 'platform-dependent',
    },
    {
      id: 'platform-data-root',
      label: 'Legacy platform-managed data (deprecated, retained for uninstall scan)',
      pathFn: getPlatformDataRoot,
      scope: 'platform-dependent',
    },
    {
      id: 'checkpoints-root',
      label: 'Checkpoints',
      pathFn: getCheckpointsRoot,
      scope: 'shared',
    },
  ]
}

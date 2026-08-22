/**
 * agent-storage-buckets — W2.2-G2 抽离的 storage-manager 注册逻辑。
 *
 * 设计：
 *   - 纯函数 + 内部 helper，不依赖 ElectronAgentHost 实例字段；
 *   - 不 import 任何 Electron / WS / 沉重副作用模块——只用 `fs` + `path`
 *     + `@tabtin/storage-manager` + `@tabtin/terminal-core` 路径常量。
 *     这样测试可以直接 import 它而不触发 ipcMain / powerMonitor / WS
 *     gateway 等启动期副作用；
 *   - 7 个 bucket（agent:conversations:* + agent:tool-* + agent:sync-*）
 *     的 sizeFn / listFn / clearFn 全部内置；
 *   - 唯一对外入口 `registerAgentStorageBuckets({ dataRoot,
 *     syncRoot })`，由 ElectronAgentHost.start() 调用一次。
 *
 * **路径约定（ 硬切）**：
 *   conversations 和 tool-logs 在
 *   `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/conversations/{sessions|tool-logs}/`。
 *   不再枚举 legacy `{platformDataRoot}/{organizationId}/spaces/{spaceId}/conversations/...`
 *   双层布局。
 *
 * 跟 RFC §四 4.2 & §4.3 的对齐：
 *   - 四轴聚合（User → Organization → Workspace → Session）：listFn 维度 v1 落到
 *     Workspace 级（"产品决策：v1 不细到 sessionId"）；clearFn 接受 itemIds 形如
 *     `<userId>/<organizationId>/<workspaceId>` 做精准过滤；
 *   - data 类（messages / sync-pending）warnings 必填非空，requiresConfirmation
 *     由 storage-manager 默认推导为 hard；
 *   - sync-* clearFn 严守不变量：永远只删 owner 桶里的目标文件，绝不
 *     递归 rm 整个 syncRoot——防误删兄弟账号。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  type BucketItem,
  getBucket,
  registerStorageBucket,
} from '@tabtin/storage-manager'

// ─── 内部 helper ─────────────────────────────────────────────────────

interface AgentSessionLike {
  userId: string
  organizationId: string
  workspaceId: string
  sessionId: string
  sessionDir: string
}

interface StorageOwner {
  userId: string
  organizationId: string
}

function _safeStatSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

async function _safeStatSizeAsync(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * 枚举所有 session 的 `conversations/sessions/{sid}/` 目录。
 *
 * 路径约定：
 * `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/conversations/sessions/{sid}/`。
 * `workspaceDir` 指向 `.../workspaces/{workspaceId}/`（通过读 `conversations/`
 * 子目录派生），便于消费方再取 tool-logs 等同级目录。
 */
function _enumerateWorkspaceSessions(
  dataRoot: string,
  owner: StorageOwner,
): AgentSessionLike[] {
  const out: AgentSessionLike[] = []
  const organizationsParent = path.join(dataRoot, 'users', owner.userId, 'organizations')
  let organizations: fs.Dirent[]
  try {
    organizations = fs.readdirSync(organizationsParent, { withFileTypes: true })
  } catch {
    return out
  }
  for (const organization of organizations) {
    if (!organization.isDirectory()) continue
    const workspacesParent = path.join(organizationsParent, organization.name, 'workspaces')
    let workspaces: fs.Dirent[]
    try {
      workspaces = fs.readdirSync(workspacesParent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      const workspaceDir = path.join(workspacesParent, workspace.name)
      const sessionsDir = path.join(workspaceDir, 'conversations', 'sessions')
      let sessions: fs.Dirent[]
      try {
        sessions = fs.readdirSync(sessionsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        out.push({
          userId: owner.userId,
          organizationId: organization.name,
          workspaceId: workspace.name,
          sessionId: session.name,
          sessionDir: path.join(sessionsDir, session.name),
        })
      }
    }
  }
  return out
}

/**
 * 枚举所有 Workspace 的 `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/` 目录。
 *
 * `workspaceDir` 是 Workspace 的元数据根（含 downloads/sites/conversations 等
 * 子目录）。消费方要取 tool-logs / tool-results 时自己拼
 * `path.join(workspaceDir, 'conversations', 'tool-logs')` 等。
 */
function _enumerateWorkspaceDirs(dataRoot: string, owner: StorageOwner): Array<{
  userId: string
  organizationId: string
  workspaceId: string
  workspaceDir: string
}> {
  const out: Array<{ userId: string; organizationId: string; workspaceId: string; workspaceDir: string }> = []
  const organizationsParent = path.join(dataRoot, 'users', owner.userId, 'organizations')
  let organizations: fs.Dirent[]
  try {
    organizations = fs.readdirSync(organizationsParent, { withFileTypes: true })
  } catch {
    return out
  }
  for (const organization of organizations) {
    if (!organization.isDirectory()) continue
    const workspacesParent = path.join(organizationsParent, organization.name, 'workspaces')
    let workspaces: fs.Dirent[]
    try {
      workspaces = fs.readdirSync(workspacesParent, { withFileTypes: true })
    } catch {
      continue
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      out.push({
        userId: owner.userId,
        organizationId: organization.name,
        workspaceId: workspace.name,
        workspaceDir: path.join(workspacesParent, workspace.name),
      })
    }
  }
  return out
}

function _calcDirSizeSync(dir: string): { bytes: number; itemCount: number } {
  if (!fs.existsSync(dir)) return { bytes: 0, itemCount: 0 }
  let bytes = 0
  let itemCount = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, itemCount: 0 }
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        const sub = _calcDirSizeSync(full)
        bytes += sub.bytes
        itemCount += sub.itemCount
      } else if (entry.isFile()) {
        bytes += fs.statSync(full).size
        itemCount += 1
      }
    } catch { /* ignore */ }
  }
  return { bytes, itemCount }
}

// ─── 5s TTL dataRoot 树扫描缓存 ───────────────────────────────────
//
// R3 修复（性能 P0）：5 个 conversation bucket 的 sizeFn 同时被 UI 调
// 用时不能各自独立 readdirSync 整树。本缓存按 dataRoot + 当前 owner 维度
// memoize `_enumerateWorkspaceSessions` / `_enumerateWorkspaceDirs` 的结果——
// 5s 内重复调用直接复用，5s 后失效重扫。
const SCAN_CACHE_TTL_MS = 5_000

interface ScanCacheEntry {
  ts: number
  sessions: AgentSessionLike[]
  workspaces: Array<{ userId: string; organizationId: string; workspaceId: string; workspaceDir: string }>
}

const _scanCache = new Map<string, ScanCacheEntry>()

function _scanCacheKey(dataRoot: string, owner: StorageOwner): string {
  return `${dataRoot}\0${owner.userId}`
}

function _getCachedSessions(dataRoot: string, owner: StorageOwner): AgentSessionLike[] {
  const now = Date.now()
  const cacheKey = _scanCacheKey(dataRoot, owner)
  const entry = _scanCache.get(cacheKey)
  if (entry && now - entry.ts < SCAN_CACHE_TTL_MS) {
    return entry.sessions
  }
  const sessions = _enumerateWorkspaceSessions(dataRoot, owner)
  const workspaces = _enumerateWorkspaceDirs(dataRoot, owner)
  _scanCache.set(cacheKey, { ts: now, sessions, workspaces })
  return sessions
}

function _getCachedWorkspaces(dataRoot: string, owner: StorageOwner): Array<{
  userId: string
  organizationId: string
  workspaceId: string
  workspaceDir: string
}> {
  const now = Date.now()
  const cacheKey = _scanCacheKey(dataRoot, owner)
  const entry = _scanCache.get(cacheKey)
  if (entry && now - entry.ts < SCAN_CACHE_TTL_MS) {
    return entry.workspaces
  }
  // 触发缓存填充
  _getCachedSessions(dataRoot, owner)
  return _scanCache.get(cacheKey)?.workspaces ?? []
}

/** 测试辅助：手动失效缓存。 */
export function __resetAgentBucketsCacheForTesting(): void {
  _scanCache.clear()
}

/**
 * 聚合 conversations 树下指定文件名的总容量（如 `messages.jsonl`）。
 * 一次 readdir 树遍历，O(N) 个 stat，缓存命中则 O(1)。
 */
function _scanConversationFile(
  sessions: AgentSessionLike[],
  fileName: 'messages.jsonl' | 'snapshots.jsonl' | 'events.jsonl',
): { bytes: number; itemCount: number } {
  let bytes = 0
  let itemCount = 0
  for (const session of sessions) {
    const filePath = path.join(session.sessionDir, fileName)
    if (!fs.existsSync(filePath)) continue
    bytes += _safeStatSize(filePath)
    itemCount += 1
  }
  return { bytes, itemCount }
}

function _scanToolLogsTree(
  workspaces: Array<{ workspaceDir: string }>,
): { bytes: number; itemCount: number } {
  let bytes = 0
  let itemCount = 0
  for (const workspace of workspaces) {
    const toolLogsDir = path.join(workspace.workspaceDir, 'conversations', 'tool-logs')
    if (!fs.existsSync(toolLogsDir)) continue
    const sub = _calcDirSizeSync(toolLogsDir)
    bytes += sub.bytes
    itemCount += sub.itemCount
  }
  return { bytes, itemCount }
}

function _scanToolResultsTree(
  workspaces: Array<{ workspaceDir: string }>,
): { bytes: number; itemCount: number } {
  let bytes = 0
  let itemCount = 0
  // FileToolResultStorage 的 `_dir = path.join(sessionDir, 'tool-results')`，
  // 而宿主传入的 sessionDir 现在是
  // `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/conversations/sessions/`，
  // 因此 tool-results 实际目录是
  // `.../conversations/sessions/tool-results/`
  // ——按 Workspace 共享一份，不按 sessionId 分桶。详见 tool-result-storage.ts。
  for (const workspace of workspaces) {
    const trDir = path.join(workspace.workspaceDir, 'conversations', 'sessions', 'tool-results')
    if (!fs.existsSync(trDir)) continue
    const sub = _calcDirSizeSync(trDir)
    bytes += sub.bytes
    itemCount += sub.itemCount
  }
  return { bytes, itemCount }
}

function _workspaceLevelItemId(userId: string, organizationId: string, workspaceId: string): string {
  return `${userId}/${organizationId}/${workspaceId}`
}

function _workspaceLevelListItem(
  bucketLabel: string,
  userId: string,
  organizationId: string,
  workspaceId: string,
  bytes: number,
  itemCount: number,
): BucketItem {
  return {
    id: _workspaceLevelItemId(userId, organizationId, workspaceId),
    label: `${bucketLabel}：${userId.slice(0, 8)}…/${organizationId.slice(0, 8)}…/${workspaceId.slice(0, 8)}…`,
    bytes,
    metadata: {
      userId,
      organizationId,
      workspaceId,
      itemCount,
    },
  }
}

interface SyncOwner {
  userId: string
  organizationId: string
  ownerDir: string
}

// ─── 公开 API ────────────────────────────────────────────────────────

export interface RegisterAgentBucketsOptions {
  /**
   * TabTin 本地数据根（ SSoT， 硬切唯一扫描根）。
   *
   * bucket 内部按
   * `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/conversations/...`
   * 遍历 session 归档（messages / snapshots / events jsonl）和 tool-logs /
   * tool-results。通常 `resolveDataRoot()` 的返回值。
   */
  dataRoot: string
  /** SyncQueue 持久化根目录。通常 `path.join(userData, 'agent-sync')`。 */
  syncRoot: string
  /**
   * 动态返回当前登录账号与当前组织。每次统计、下钻和清理都重新读取；
   * 身份缺失或读取失败时必须 fail closed，不得扫描其他本地账号。
   */
  getCurrentOwner: () => Promise<{
    userId: string
    organizationId: string
  } | null>
}

/**
 * 注册 W2.2-G2 范围内 main 进程的 7 个 agent:* / agent:conversations:*
 * / agent:tool-* / agent:sync-* bucket 到 storage-manager 中心。
 *
 * 幂等：每个 bucket 注册前先 `getBucket(id)` 检查，已存在则跳过。
 * 这让 host stop/start 周期或 hot-reload 安全。
 *
 * 不抛错：register 内部用 try/catch 守护——单个 bucket schema 错不会
 * 影响其他 bucket 注册（极端情况 storage-manager 的 assertValidBucket
 * 抛 InvalidBucketError，由调用方 try/catch；正常路径下 7 个 schema 都
 * 应通过校验，本期单测覆盖）。
 */
export function registerAgentStorageBuckets(options: RegisterAgentBucketsOptions): void {
  const { dataRoot, syncRoot, getCurrentOwner } = options

  const resolveCurrentOwner = async (): Promise<{
    userId: string
    organizationId: string
  } | null> => {
    try {
      const owner = await getCurrentOwner()
      if (!owner?.userId || !owner.organizationId) return null
      return owner
    } catch {
      return null
    }
  }
  const getScopedSessions = async (): Promise<AgentSessionLike[]> => {
    const owner = await resolveCurrentOwner()
    if (!owner) return []
    return _getCachedSessions(dataRoot, owner)
  }
  const getScopedWorkspaces = async () => {
    const owner = await resolveCurrentOwner()
    if (!owner) return []
    return _getCachedWorkspaces(dataRoot, owner)
  }
  const getScopedSyncOwners = async (): Promise<SyncOwner[]> => {
    const owner = await resolveCurrentOwner()
    if (!owner) return []
    const userRoot = path.join(syncRoot, owner.userId)
    let organizations: fs.Dirent[]
    try {
      organizations = fs.readdirSync(userRoot, { withFileTypes: true })
    } catch {
      return []
    }
    return organizations
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        userId: owner.userId,
        organizationId: entry.name,
        ownerDir: path.join(userRoot, entry.name),
      }))
  }

  // ─── agent:conversations:messages ───────────────────────────
  if (!getBucket('agent:conversations:messages')) {
    registerStorageBucket({
      id: 'agent:conversations:messages',
      category: 'data',
      group: 'conversation',
      displayName: '对话历史 · 消息流',
      description: 'Agent 跟你聊过的所有消息（按用户 / 组织 / Workspace 分组）',
      warnings: [
        '清除后所有 Agent 历史对话彻底清空，不可恢复',
        '云端如果同步未跟上则对话彻底丢失',
        '建议在网络稳定时再清；面板里"未上云的对话片段"数量为 0 时最安全',
      ],
      sizeFn: async () => _scanConversationFile(await getScopedSessions(), 'messages.jsonl'),
      listFn: async () => {
        const items: BucketItem[] = []
        const grouped = new Map<string, { bytes: number; sessions: number }>()
        for (const s of await getScopedSessions()) {
          const fp = path.join(s.sessionDir, 'messages.jsonl')
          if (!fs.existsSync(fp)) continue
          const key = _workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId)
          const cur = grouped.get(key) ?? { bytes: 0, sessions: 0 }
          cur.bytes += _safeStatSize(fp)
          cur.sessions += 1
          grouped.set(key, cur)
        }
        for (const [key, info] of grouped) {
          const [userId, organizationId, workspaceId] = key.split('/')
          items.push(_workspaceLevelListItem('Messages', userId, organizationId, workspaceId, info.bytes, info.sessions))
        }
        return items
      },
      clearFn: async (options) => {
        const targets = await getScopedSessions()
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const s of targets) {
          if (targetSet && !targetSet.has(_workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId))) continue
          const fp = path.join(s.sessionDir, 'messages.jsonl')
          if (!fs.existsSync(fp)) continue
          const sz = _safeStatSize(fp)
          if (options?.dryRun) {
            bytes += sz
            count += 1
            continue
          }
          try {
            fs.unlinkSync(fp)
            bytes += sz
            count += 1
          } catch (err) {
            errors.push(`unlink(${fp}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!options?.dryRun) _scanCache.clear()
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:conversations:snapshots ──────────────────────────
  if (!getBucket('agent:conversations:snapshots')) {
    registerStorageBucket({
      id: 'agent:conversations:snapshots',
      category: 'semi-cache',
      group: 'conversation',
      displayName: '对话历史 · LLM 调用快照',
      description: '每次 LLM 调用的现场快照（用于 debug / replay，云端无备份）',
      sizeFn: async () => _scanConversationFile(await getScopedSessions(), 'snapshots.jsonl'),
      listFn: async () => {
        const items: BucketItem[] = []
        const grouped = new Map<string, { bytes: number; sessions: number }>()
        for (const s of await getScopedSessions()) {
          const fp = path.join(s.sessionDir, 'snapshots.jsonl')
          if (!fs.existsSync(fp)) continue
          const key = _workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId)
          const cur = grouped.get(key) ?? { bytes: 0, sessions: 0 }
          cur.bytes += _safeStatSize(fp)
          cur.sessions += 1
          grouped.set(key, cur)
        }
        for (const [key, info] of grouped) {
          const [userId, organizationId, workspaceId] = key.split('/')
          items.push(_workspaceLevelListItem('Snapshots', userId, organizationId, workspaceId, info.bytes, info.sessions))
        }
        return items
      },
      clearFn: async (options) => {
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const s of await getScopedSessions()) {
          if (targetSet && !targetSet.has(_workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId))) continue
          const fp = path.join(s.sessionDir, 'snapshots.jsonl')
          if (!fs.existsSync(fp)) continue
          const sz = _safeStatSize(fp)
          if (options?.dryRun) {
            bytes += sz
            count += 1
            continue
          }
          try {
            fs.unlinkSync(fp)
            bytes += sz
            count += 1
          } catch (err) {
            errors.push(`unlink(${fp}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!options?.dryRun) _scanCache.clear()
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:conversations:events ─────────────────────────────
  if (!getBucket('agent:conversations:events')) {
    registerStorageBucket({
      id: 'agent:conversations:events',
      category: 'semi-cache',
      group: 'conversation',
      displayName: '对话历史 · 事件流',
      description: '完整事件流（用于离线回放 / audit，云端无备份）',
      sizeFn: async () => _scanConversationFile(await getScopedSessions(), 'events.jsonl'),
      listFn: async () => {
        const items: BucketItem[] = []
        const grouped = new Map<string, { bytes: number; sessions: number }>()
        for (const s of await getScopedSessions()) {
          const fp = path.join(s.sessionDir, 'events.jsonl')
          if (!fs.existsSync(fp)) continue
          const key = _workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId)
          const cur = grouped.get(key) ?? { bytes: 0, sessions: 0 }
          cur.bytes += _safeStatSize(fp)
          cur.sessions += 1
          grouped.set(key, cur)
        }
        for (const [key, info] of grouped) {
          const [userId, organizationId, workspaceId] = key.split('/')
          items.push(_workspaceLevelListItem('Events', userId, organizationId, workspaceId, info.bytes, info.sessions))
        }
        return items
      },
      clearFn: async (options) => {
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const s of await getScopedSessions()) {
          if (targetSet && !targetSet.has(_workspaceLevelItemId(s.userId, s.organizationId, s.workspaceId))) continue
          const fp = path.join(s.sessionDir, 'events.jsonl')
          if (!fs.existsSync(fp)) continue
          const sz = _safeStatSize(fp)
          if (options?.dryRun) {
            bytes += sz
            count += 1
            continue
          }
          try {
            fs.unlinkSync(fp)
            bytes += sz
            count += 1
          } catch (err) {
            errors.push(`unlink(${fp}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!options?.dryRun) _scanCache.clear()
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:tool-logs ────────────────────────────────────────
  if (!getBucket('agent:tool-logs')) {
    registerStorageBucket({
      id: 'agent:tool-logs',
      category: 'semi-cache',
      group: 'conversation',
      displayName: '工具调用日志',
      description: '工具调用的完整 input/output（30 天 TTL 自动清理；当前 Agent 还在用的也会一并清掉）',
      sizeFn: async () => _scanToolLogsTree(await getScopedWorkspaces()),
      listFn: async () => {
        const items: BucketItem[] = []
        for (const workspace of await getScopedWorkspaces()) {
          const toolLogsDir = path.join(workspace.workspaceDir, 'conversations', 'tool-logs')
          if (!fs.existsSync(toolLogsDir)) continue
          const sub = _calcDirSizeSync(toolLogsDir)
          if (sub.bytes === 0 && sub.itemCount === 0) continue
          items.push(_workspaceLevelListItem('Tool Logs', workspace.userId, workspace.organizationId, workspace.workspaceId, sub.bytes, sub.itemCount))
        }
        return items
      },
      clearFn: async (options) => {
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const workspace of await getScopedWorkspaces()) {
          if (targetSet && !targetSet.has(_workspaceLevelItemId(workspace.userId, workspace.organizationId, workspace.workspaceId))) continue
          const toolLogsDir = path.join(workspace.workspaceDir, 'conversations', 'tool-logs')
          if (!fs.existsSync(toolLogsDir)) continue
          const sub = _calcDirSizeSync(toolLogsDir)
          if (options?.dryRun) {
            bytes += sub.bytes
            count += sub.itemCount
            continue
          }
          try {
            fs.rmSync(toolLogsDir, { recursive: true, force: true })
            bytes += sub.bytes
            count += sub.itemCount
          } catch (err) {
            errors.push(`rm(${toolLogsDir}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!options?.dryRun) _scanCache.clear()
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:tool-results ─────────────────────────────────────
  if (!getBucket('agent:tool-results')) {
    registerStorageBucket({
      id: 'agent:tool-results',
      category: 'semi-cache',
      group: 'conversation',
      displayName: '工具调用结果归档',
      description: '工具调用的结果信封（24h TTL 自动清理；用于失败重试 / 历史查阅）',
      sizeFn: async () => _scanToolResultsTree(await getScopedWorkspaces()),
      listFn: async () => {
        const items: BucketItem[] = []
        for (const workspace of await getScopedWorkspaces()) {
          const trDir = path.join(workspace.workspaceDir, 'conversations', 'sessions', 'tool-results')
          if (!fs.existsSync(trDir)) continue
          const sub = _calcDirSizeSync(trDir)
          if (sub.bytes === 0 && sub.itemCount === 0) continue
          items.push(_workspaceLevelListItem('Tool Results', workspace.userId, workspace.organizationId, workspace.workspaceId, sub.bytes, sub.itemCount))
        }
        return items
      },
      clearFn: async (options) => {
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const workspace of await getScopedWorkspaces()) {
          if (targetSet && !targetSet.has(_workspaceLevelItemId(workspace.userId, workspace.organizationId, workspace.workspaceId))) continue
          const trDir = path.join(workspace.workspaceDir, 'conversations', 'sessions', 'tool-results')
          if (!fs.existsSync(trDir)) continue
          const sub = _calcDirSizeSync(trDir)
          if (options?.dryRun) {
            bytes += sub.bytes
            count += sub.itemCount
            continue
          }
          try {
            fs.rmSync(trDir, { recursive: true, force: true })
            bytes += sub.bytes
            count += sub.itemCount
          } catch (err) {
            errors.push(`rm(${trDir}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (!options?.dryRun) _scanCache.clear()
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:sync-pending ─────────────────────────────────────
  // 关键不变量：clearFn 只删 owner 桶下的 pending.jsonl 单文件，永不
  // 递归 rm 整个 syncRoot（防误删兄弟账号）。守护测试 storage-buckets.test.ts
  // 用 grep 卡住此模式不出现。
  if (!getBucket('agent:sync-pending')) {
    registerStorageBucket({
      id: 'agent:sync-pending',
      category: 'data',
      group: 'conversation',
      displayName: '未上云的对话片段（待重试）',
      description: '网络断了或同步失败时落盘的对话片段，等待网络恢复后自动上传',
      warnings: [
        '清除后未上传的对话片段将永久丢失，云端不会有这些数据',
        '只清当前账号的桶，不影响其他账号的同步队列',
        '离线状态下清除风险更大——这些片段才刚刚落盘',
        '建议先在网络好时让同步圈圈跑完再清理',
      ],
      sizeFn: async () => {
        let bytes = 0
        let count = 0
        for (const o of await getScopedSyncOwners()) {
          const fp = path.join(o.ownerDir, 'pending.jsonl')
          if (!fs.existsSync(fp)) continue
          bytes += await _safeStatSizeAsync(fp)
          count += 1
        }
        return { bytes, itemCount: count }
      },
      listFn: async () => {
        const items: BucketItem[] = []
        for (const o of await getScopedSyncOwners()) {
          const fp = path.join(o.ownerDir, 'pending.jsonl')
          if (!fs.existsSync(fp)) continue
          items.push({
            id: `${o.userId}/${o.organizationId}`,
            label: `账号 ${o.userId.slice(0, 8)}…/组织 ${o.organizationId.slice(0, 8)}…`,
            bytes: await _safeStatSizeAsync(fp),
            metadata: { userId: o.userId, organizationId: o.organizationId },
          })
        }
        return items
      },
      clearFn: async (options) => {
        const targets = await getScopedSyncOwners()
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const o of targets) {
          if (targetSet && !targetSet.has(`${o.userId}/${o.organizationId}`)) continue
          const fp = path.join(o.ownerDir, 'pending.jsonl')
          if (!fs.existsSync(fp)) continue
          const sz = await _safeStatSizeAsync(fp)
          if (options?.dryRun) {
            bytes += sz
            count += 1
            continue
          }
          try {
            await fs.promises.unlink(fp)
            bytes += sz
            count += 1
          } catch (err) {
            errors.push(`unlink(${fp}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }

  // ─── agent:sync-archive ─────────────────────────────────────
  if (!getBucket('agent:sync-archive')) {
    registerStorageBucket({
      id: 'agent:sync-archive',
      category: 'semi-cache',
      group: 'conversation',
      displayName: '已归档的同步 batch',
      description: '多次重试仍上传失败的对话片段（已永久放弃同步，建议先导出再清理）',
      sizeFn: async () => {
        let bytes = 0
        let count = 0
        for (const o of await getScopedSyncOwners()) {
          const fp = path.join(o.ownerDir, 'archive.jsonl')
          if (!fs.existsSync(fp)) continue
          bytes += await _safeStatSizeAsync(fp)
          count += 1
        }
        return { bytes, itemCount: count }
      },
      listFn: async () => {
        const items: BucketItem[] = []
        for (const o of await getScopedSyncOwners()) {
          const fp = path.join(o.ownerDir, 'archive.jsonl')
          if (!fs.existsSync(fp)) continue
          items.push({
            id: `${o.userId}/${o.organizationId}`,
            label: `归档 ${o.userId.slice(0, 8)}…/${o.organizationId.slice(0, 8)}…`,
            bytes: await _safeStatSizeAsync(fp),
            metadata: { userId: o.userId, organizationId: o.organizationId },
          })
        }
        return items
      },
      clearFn: async (options) => {
        const targets = await getScopedSyncOwners()
        const targetSet = options?.itemIds && options.itemIds.length > 0
          ? new Set(options.itemIds)
          : null
        let bytes = 0
        let count = 0
        const errors: string[] = []
        for (const o of targets) {
          if (targetSet && !targetSet.has(`${o.userId}/${o.organizationId}`)) continue
          const fp = path.join(o.ownerDir, 'archive.jsonl')
          if (!fs.existsSync(fp)) continue
          const sz = await _safeStatSizeAsync(fp)
          if (options?.dryRun) {
            bytes += sz
            count += 1
            continue
          }
          try {
            await fs.promises.unlink(fp)
            bytes += sz
            count += 1
          } catch (err) {
            errors.push(`unlink(${fp}) 失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return {
          clearedItemCount: count,
          freedBytes: bytes,
          ...(errors.length > 0 ? { errors } : {}),
        }
      },
    })
  }
}

/**
 * SkillsBucketRegistration — 把用户 / 组织 Skill 副本登记到 storage-manager。
 *
 * 背景（W2.2 G1，business-app）：
 *   每个用户 / 组织第一次用到某个 Skill 时，`packages/agent-runtime` 会把
 *   bundled platform / app skills 完整复制到
 *   `{dataRoot}/users/{userId}/skills/{slug}/`（个人）或
 *   `{dataRoot}/users/{userId}/organizations/{orgId}/skills/{slug}/`（组织）。
 *   随着用户 / 组织数量增长，这些副本累积可能达到 GB 级，但用户从未
 *   感知到"我装过 skill"——必须在「存储管理」里展示出来让用户能看见。
 *
 * （硬切）：本模块不再枚举 legacy
 * `{platformDataRoot}/{organizationId}/spaces/{spaceId}/skills/` 双层布局，
 * 只扫新的 `{dataRoot}/users/{userId}/[organizations/{orgId}/]skills/` 单树。
 *
 * 边界与约束：
 *   - 只读扫盘：不修改 ElectronAgentHost / agent-runtime / skill-preinstaller。
 *     由 SkillsBucketRegistration 自己负责扫 dataRoot，避免与 G2 / W2.3 撞车。
 *   - 只展示，不强制清理：本期 backlog（A4 §3.2 L1）只让用户看见，
 *     `clearFn` 提供按条目选择性清理能力，但默认 UI 倾向于"展示 + 警告"。
 *   - 多进程：本桶只在 Electron 主进程注册；Daemon 端的 skills 桶由 W2.3 单独
 *     注册到 Daemon 进程的 storage-manager singleton。
 */

import { stat, readdir } from 'node:fs/promises'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { registerStorageBucket } from '@tabtin/storage-manager'
import { getDataRoot } from '@tabtin/shared/storage-paths'
import { resolveUserSkillsDir, resolveOrganizationSkillsDir } from '@tabtin/terminal-core'
import { logger } from '../utils/logger'

const TAG = 'SkillsBucketRegistration'

interface UserSkillsEntry {
  userId: string
  organizationId?: string
  scope: 'user' | 'org'
  bytes: number
  skillCount: number
}

function _entryId(entry: UserSkillsEntry): string {
  return entry.scope === 'user' ? `user:${entry.userId}` : `org:${entry.userId}/${entry.organizationId}`
}

function _entrySkillsDir(dataRoot: string, entry: UserSkillsEntry): string {
  return entry.scope === 'user'
    ? resolveUserSkillsDir(dataRoot, entry.userId)
    : resolveOrganizationSkillsDir(dataRoot, entry.userId, entry.organizationId!)
}

async function _dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        total += await _dirSize(full)
      } else if (entry.isFile()) {
        const st = await stat(full)
        total += st.size
      }
    } catch {
      // ignore single-file errors
    }
  }
  return total
}

async function _countSkillDirs(skillsDir: string): Promise<number> {
  let skillCount = 0
  try {
    const skillDirs = await readdir(skillsDir, { withFileTypes: true })
    for (const skill of skillDirs) {
      if (skill.isDirectory()) skillCount += 1
    }
  } catch {
    // ignore
  }
  return skillCount
}

// R3-5b 修复：数十用户 × 数千文件递归扫描串行会破 1s。
// 同 tabvideo:projects 的优化策略：跨用户 / 组织并发扫盘 + 200ms 记忆化避免
// sizeFn / listFn / clearFn 同一渲染周期重复扫盘。
const _SKILLS_AGGREGATE_TTL_MS = 200
let _skillsAggregateCache: { at: number; promise: Promise<{
  bytes: number
  itemCount: number
  entries: UserSkillsEntry[]
}> } | null = null

async function _doAggregateUserSkillsSize(): Promise<{
  bytes: number
  itemCount: number
  entries: UserSkillsEntry[]
}> {
  //  硬切后：skills 目录唯一布局是
  // `{dataRoot}/users/{userId}/skills/`（个人）+
  // `{dataRoot}/users/{userId}/organizations/{orgId}/skills/`（组织）。
  // 扫描先列 users/*，再对每个 user 检查个人 skills + 列 organizations/*。
  const dataRoot = getDataRoot()
  const usersRoot = join(dataRoot, 'users')

  if (!existsSync(usersRoot)) {
    return { bytes: 0, itemCount: 0, entries: [] }
  }

  let userDirs: Array<{ name: string; isDirectory: () => boolean }>
  try {
    userDirs = await readdir(usersRoot, { withFileTypes: true })
  } catch {
    return { bytes: 0, itemCount: 0, entries: [] }
  }

  const entriesPerUser = await Promise.all(
    userDirs.filter((d) => d.isDirectory()).map(async (userDirent) => {
      const userId = userDirent.name
      const out: UserSkillsEntry[] = []

      const userSkillsDir = resolveUserSkillsDir(dataRoot, userId)
      if (existsSync(userSkillsDir)) {
        const [skillCount, bytes] = await Promise.all([
          _countSkillDirs(userSkillsDir),
          _dirSize(userSkillsDir),
        ])
        out.push({ userId, scope: 'user', bytes, skillCount })
      }

      const organizationsParent = join(usersRoot, userId, 'organizations')
      let orgDirs: Array<{ name: string; isDirectory: () => boolean }>
      try {
        orgDirs = await readdir(organizationsParent, { withFileTypes: true })
      } catch {
        orgDirs = []
      }

      const orgEntries = await Promise.all(
        orgDirs.filter((d) => d.isDirectory()).map(async (orgDirent) => {
          const organizationId = orgDirent.name
          const orgSkillsDir = resolveOrganizationSkillsDir(dataRoot, userId, organizationId)
          if (!existsSync(orgSkillsDir)) return null

          const [skillCount, bytes] = await Promise.all([
            _countSkillDirs(orgSkillsDir),
            _dirSize(orgSkillsDir),
          ])
          return { userId, organizationId, scope: 'org', bytes, skillCount } as UserSkillsEntry
        }),
      )
      out.push(...orgEntries.filter((e): e is UserSkillsEntry => e !== null))

      return out
    }),
  )

  const flattened = entriesPerUser.flat()
  const totalBytes = flattened.reduce((acc, e) => acc + e.bytes, 0)
  return { bytes: totalBytes, itemCount: flattened.length, entries: flattened }
}

async function _aggregateUserSkillsSize(): Promise<{
  bytes: number
  itemCount: number
  entries: UserSkillsEntry[]
}> {
  const now = Date.now()
  if (_skillsAggregateCache && now - _skillsAggregateCache.at < _SKILLS_AGGREGATE_TTL_MS) {
    return _skillsAggregateCache.promise
  }
  const promise = _doAggregateUserSkillsSize()
  _skillsAggregateCache = { at: now, promise }
  promise.catch(() => {
    if (_skillsAggregateCache?.promise === promise) _skillsAggregateCache = null
  })
  return promise
}

/**
 * 注册 skills:preinstalled bucket（聚合所有用户 / 组织的 skills 副本占用）。
 * 在 startup-services 启动期调用。函数本身幂等：重复调用会因 storage-manager
 * 抛 BucketAlreadyRegisteredError，被 try/catch 吞掉。
 *
 * @returns unregister 函数（仅供测试 / 模块卸载使用；生产 startup 不解注册）
 */
export function registerSkillsPreinstalledBucket(): () => void {

  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'skills:preinstalled',
      category: 'semi-cache',
      group: 'business-app',
      displayName: 'Agent 工具脚本',
      description: 'TabTin 在每个 Agent 工作区里自动准备的工具脚本（让 AI 能调用平台和业务 App 的能力）。你不需要手动管理。',
      warnings: [
        '清理后下次进入对应 Agent 工作区会自动重新准备（首次会比平时慢几秒）',
        '若你曾在工具脚本目录里手动改过文件（高级用法），这些修改会被一并清掉',
      ],
      requiresConfirmation: 'soft',
      sizeFn: async () => {
        try {
          const { bytes, itemCount } = await _aggregateUserSkillsSize()
          return { bytes, itemCount }
        } catch {
          return { bytes: 0, itemCount: 0 }
        }
      },
      listFn: async () => {
        try {
          const { entries } = await _aggregateUserSkillsSize()
          return entries.map((entry) => ({
            id: _entryId(entry),
            label: entry.scope === 'user'
              ? `用户 ${entry.userId.slice(0, 8)}… 个人工具脚本（含 ${entry.skillCount} 个）`
              : `用户 ${entry.userId.slice(0, 8)}… / 组织 ${entry.organizationId!.slice(0, 8)}… 工具脚本（含 ${entry.skillCount} 个）`,
            bytes: entry.bytes,
            metadata: { userId: entry.userId, organizationId: entry.organizationId, skillCount: entry.skillCount },
          }))
        } catch {
          return []
        }
      },
      clearFn: async (options) => {
        const { bytes, itemCount, entries } = await _aggregateUserSkillsSize().catch(() => ({
          bytes: 0,
          itemCount: 0,
          entries: [] as UserSkillsEntry[],
        }))

        if (options?.dryRun) {
          if (options.itemIds?.length) {
            const idSet = new Set(options.itemIds)
            let bytesEstimate = 0
            let countEstimate = 0
            for (const entry of entries) {
              if (idSet.has(_entryId(entry))) {
                bytesEstimate += entry.bytes
                countEstimate += 1
              }
            }
            return { clearedItemCount: countEstimate, freedBytes: bytesEstimate }
          }
          return { clearedItemCount: itemCount, freedBytes: bytes }
        }

        const dataRoot = getDataRoot()
        const target = options?.itemIds && options.itemIds.length > 0
          ? entries.filter((entry) => options.itemIds!.includes(_entryId(entry)))
          : entries

        const errors: string[] = []
        let cleared = 0
        let freed = 0
        for (const entry of target) {
          const skillsDir = _entrySkillsDir(dataRoot, entry)
          try {
            rmSync(skillsDir, { recursive: true, force: true })
            cleared += 1
            freed += entry.bytes
          } catch (err) {
            errors.push(`${_entryId(entry)}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { clearedItemCount: cleared, freedBytes: freed, errors: errors.length ? errors : undefined }
      },
    })
    logger.debug(TAG, 'skills:preinstalled bucket registered')
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    logger.warn(TAG, 'skills:preinstalled bucket registration skipped:', err)
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}

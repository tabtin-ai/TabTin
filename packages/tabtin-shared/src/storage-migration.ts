/**
 * storage-migration —  一次性迁移 helper：
 * 旧 `platformData/organizations/{org}/spaces/{sp}/…` → 新
 * `dataRoot/users/{userId}/[organizations/{org}/]{skills|workspaces}/…`。
 *
 * ## 迁移策略
 *
 *   - `platform-data/organizations/{org}/spaces/{id}/skills/*` → 组织 skills
 *     （给定 orgId 上下文时）或用户 skills（作为兜底，仅当 orgId 未知）。
 *   - `platform-data/organizations/{org}/spaces/{id}/{downloads,conversations,sites,plugins}`
 *     → workspace 元数据 `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{id}/…`
 *     （plugins 迁到组织级 `organizations/{orgId}/plugins/`——同组织内所有 workspace 共享）。
 *   - `platform-data/workteams/{org}/spaces/{id}/…`（更老布局）按同一规则迁入。
 *   - `conversations` / `downloads` / `sites` **按子项合并**：目标根已存在时仍搬
 *     尚未出现的 session / tool-log / 子目录（避免「整目录 skipped」留下 leftover）。
 *   - 旧 `organizations/{org}/spaces/{id}/*`（不含 platform-data，纯用户文件区）
 *     **不搬**到元数据树——那些是用户内容，由 Workspace.working_dir 语义接管。
 *
 * ## 幂等
 *
 *   - 已经存在的目标目录不覆盖：单个 skill / session 目录已存在则跳过（不删源，交给调用方
 *     决定是否清理）。
 *   - 已写 `.migrated` 的 space **仍会补齐 leftover** workspace 元数据（迁移后若仍有
 *     writer 写回旧树，下次登录可再搬）。
 *   - 迁移失败逐条记录到 `errors`；不 throw 全局中断，让宿主可以拿到 report 决定
 *     是否上报 telemetry / 保留兜底。
 *
 * ## 非目标
 *
 *   - 不做数据变形：文件字节原样移动，格式 / 元数据不改。
 *   - 不做 UI 通知：迁移结果由调用方翻译成用户可见文案。
 *   - 不删旧目录：即便目标已存在，源头保留由调用方决定（默认策略：迁移成功后
 *     标记 `.migrated`，避免下次重复扫描 skills）。
 */

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

import {
  resolveOrganizationPluginsDir,
  resolveOrganizationSkillsDir,
  resolveUserSkillsDir,
  resolveWorkspaceMetadataRoot,
} from './storage-paths.js'

export interface StorageMigrationOptions {
  /** 新数据根（`getDataRoot()`） */
  dataRoot: string
  /** 旧 platform-data 根（`{platformBase}/platform-data/organizations/`） */
  legacyPlatformDataRoot: string
  /**
   * 当前用户 ID。skill 迁到用户目录时必填；缺失时 skill 迁移会跳过并记 warning。
   */
  userId: string | undefined
  /**
   * 可选：仅迁移这批 organizationId。缺省扫全部 organization 子目录。
   */
  organizationIds?: readonly string[]
  /**
   * skills 迁移落点：`'org'` 默认——按发现的 organizationId 落到组织 skills；
   * `'user'` 强制落到 `users/{userId}/skills`（供无 org 上下文测试用）。
   */
  skillDestination?: 'org' | 'user'
  /** 迁移完成后是否在源目录写 `.migrated` 标记，跳过下次扫描。默认 `true`。 */
  markMigrated?: boolean
  logger?: {
    info: (msg: string) => void
    warn: (msg: string) => void
    error: (msg: string) => void
  }
}

export interface StorageMigrationReport {
  scannedOrganizations: number
  scannedSpaces: number
  movedSkills: number
  skippedSkills: number
  movedWorkspaceSubdirs: number
  skippedWorkspaceSubdirs: number
  errors: string[]
}

const MIGRATED_MARKER = '.migrated'
const WORKSPACE_METADATA_SUBDIRS = ['downloads', 'conversations', 'sites'] as const

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return []
    throw err
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

async function copyDirRecursive(from: string, to: string): Promise<void> {
  await fsp.cp(from, to, { recursive: true })
}

async function moveOrCopyIfNotExists(
  from: string,
  to: string,
): Promise<'moved' | 'skipped'> {
  if (await pathExists(to)) return 'skipped'
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
    return 'moved'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // EXDEV：跨设备无法 rename，退回复制 + 删源
    if (code !== 'EXDEV') throw err
    await copyDirRecursive(from, to)
    await fsp.rm(from, { recursive: true, force: true })
    return 'moved'
  }
}

async function migrateSkillsDir(args: {
  fromDir: string
  toDir: string
  logger?: StorageMigrationOptions['logger']
  report: StorageMigrationReport
}): Promise<void> {
  const { fromDir, toDir, logger, report } = args
  const entries = await safeReaddir(fromDir)
  if (entries.length === 0) return
  await fsp.mkdir(toDir, { recursive: true })
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name.startsWith('.')) continue
    const from = path.join(fromDir, entry.name)
    const to = path.join(toDir, entry.name)
    try {
      const result = await moveOrCopyIfNotExists(from, to)
      if (result === 'moved') {
        report.movedSkills += 1
        logger?.info(`[storage-migration] skill moved: ${from} → ${to}`)
      } else {
        report.skippedSkills += 1
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      report.errors.push(`skill ${from}: ${msg}`)
      logger?.error(`[storage-migration] skill move failed: ${from} → ${to}: ${msg}`)
    }
  }
}

/**
 * 整目录搬迁（downloads / sites / plugins）：目标已存在则 skip。
 */
async function migrateWorkspaceSubdir(args: {
  fromDir: string
  toDir: string
  label: string
  logger?: StorageMigrationOptions['logger']
  report: StorageMigrationReport
}): Promise<void> {
  const { fromDir, toDir, label, logger, report } = args
  if (!(await pathExists(fromDir))) return
  try {
    const result = await moveOrCopyIfNotExists(fromDir, toDir)
    if (result === 'moved') {
      report.movedWorkspaceSubdirs += 1
      logger?.info(`[storage-migration] ${label} moved: ${fromDir} → ${toDir}`)
    } else {
      report.skippedWorkspaceSubdirs += 1
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    report.errors.push(`${label} ${fromDir}: ${msg}`)
    logger?.error(`[storage-migration] ${label} move failed: ${fromDir}: ${msg}`)
  }
}

/**
 * conversations 合并式搬迁：目标根已存在时，仍逐个搬 `sessions/*` 与 `tool-logs/*`。
 * 这样迁移后若仍有 writer 写回旧树，下次登录可以把 leftover session 补齐到新树。
 */
async function migrateConversationsDir(args: {
  fromDir: string
  toDir: string
  logger?: StorageMigrationOptions['logger']
  report: StorageMigrationReport
}): Promise<void> {
  const { fromDir, toDir, logger, report } = args
  if (!(await pathExists(fromDir))) return

  if (!(await pathExists(toDir))) {
    await migrateWorkspaceSubdir({
      fromDir,
      toDir,
      label: 'conversations',
      logger,
      report,
    })
    return
  }

  for (const bucket of ['sessions', 'tool-logs'] as const) {
    const fromBucket = path.join(fromDir, bucket)
    const toBucket = path.join(toDir, bucket)
    const entries = await safeReaddir(fromBucket)
    if (entries.length === 0) continue
    await fsp.mkdir(toBucket, { recursive: true })
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      const from = path.join(fromBucket, entry.name)
      const to = path.join(toBucket, entry.name)
      try {
        const result = await moveOrCopyIfNotExists(from, to)
        if (result === 'moved') {
          report.movedWorkspaceSubdirs += 1
          logger?.info(`[storage-migration] conversations/${bucket} moved: ${from} → ${to}`)
        } else {
          report.skippedWorkspaceSubdirs += 1
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        report.errors.push(`conversations/${bucket} ${from}: ${msg}`)
        logger?.error(
          `[storage-migration] conversations/${bucket} move failed: ${from}: ${msg}`,
        )
      }
    }
  }
}

async function migrateOneSpace(args: {
  spaceDir: string
  organizationId: string
  workspaceId: string
  options: StorageMigrationOptions
  report: StorageMigrationReport
  /** 已有 `.migrated`：只补齐 leftover 元数据，不再扫 skills（避免重复计数噪音） */
  leftoverOnly: boolean
}): Promise<void> {
  const { spaceDir, organizationId, workspaceId, options, report, leftoverOnly } = args
  const { dataRoot, userId, logger } = options
  const skillDestination = options.skillDestination ?? 'org'
  const markMigrated = options.markMigrated ?? true

  if (!leftoverOnly) {
    const skillsFrom = path.join(spaceDir, 'skills')
    if (await pathExists(skillsFrom)) {
      if (!userId) {
        report.errors.push(
          `skill migration skipped for organization=${organizationId} space=${workspaceId}: userId missing`,
        )
        logger?.warn(
          `[storage-migration] skill migration skipped: userId missing (org=${organizationId} space=${workspaceId})`,
        )
      } else {
        const skillsTo = skillDestination === 'user'
          ? resolveUserSkillsDir(dataRoot, userId)
          : resolveOrganizationSkillsDir(dataRoot, userId, organizationId)
        await migrateSkillsDir({
          fromDir: skillsFrom,
          toDir: skillsTo,
          logger,
          report,
        })
      }
    }

    const pluginsFrom = path.join(spaceDir, 'plugins')
    if (userId && (await pathExists(pluginsFrom))) {
      const pluginsTo = resolveOrganizationPluginsDir(dataRoot, userId, organizationId)
      await migrateWorkspaceSubdir({
        fromDir: pluginsFrom,
        toDir: pluginsTo,
        label: 'plugins',
        logger,
        report,
      })
    }
  }

  const workspaceMetaTo = userId
    ? resolveWorkspaceMetadataRoot(dataRoot, userId, organizationId, workspaceId)
    : undefined
  if (workspaceMetaTo) {
    for (const sub of WORKSPACE_METADATA_SUBDIRS) {
      const fromDir = path.join(spaceDir, sub)
      const toDir = path.join(workspaceMetaTo, sub)
      if (sub === 'conversations') {
        await migrateConversationsDir({ fromDir, toDir, logger, report })
      } else {
        await migrateWorkspaceSubdir({
          fromDir,
          toDir,
          label: sub,
          logger,
          report,
        })
      }
    }
  } else if (!leftoverOnly) {
    report.errors.push(
      `workspace metadata migration skipped for organization=${organizationId} space=${workspaceId}: userId missing`,
    )
  }

  if (markMigrated) {
    const markerPath = path.join(spaceDir, MIGRATED_MARKER)
    try {
      await fsp.writeFile(markerPath, new Date().toISOString(), 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      report.errors.push(`mark ${markerPath}: ${msg}`)
    }
  }
}

async function scanLegacySpacesTree(args: {
  spacesRoot: string
  options: StorageMigrationOptions
  report: StorageMigrationReport
}): Promise<void> {
  const { spacesRoot, options, report } = args
  const orgFilter = options.organizationIds
    ? new Set(options.organizationIds)
    : null

  const orgEntries = await safeReaddir(spacesRoot)
  for (const orgEntry of orgEntries) {
    if (!orgEntry.isDirectory()) continue
    const organizationId = orgEntry.name
    if (organizationId === '_unscoped') continue
    if (orgFilter && !orgFilter.has(organizationId)) continue
    report.scannedOrganizations += 1

    const spacesParent = path.join(spacesRoot, organizationId, 'spaces')
    const spaceEntries = await safeReaddir(spacesParent)
    for (const spaceEntry of spaceEntries) {
      if (!spaceEntry.isDirectory()) continue
      const workspaceId = spaceEntry.name
      if (workspaceId === '_unscoped') continue
      report.scannedSpaces += 1

      const spaceDir = path.join(spacesParent, workspaceId)
      const markerPath = path.join(spaceDir, MIGRATED_MARKER)
      const leftoverOnly = await pathExists(markerPath)
      await migrateOneSpace({
        spaceDir,
        organizationId,
        workspaceId,
        options,
        report,
        leftoverOnly,
      })
    }
  }
}

/**
 * 一次性迁移旧 platform-data 布局到新 data-root 布局。返回汇总报告。
 *
 * **调用点建议**：Electron / Daemon 主进程在完成登录（拿到 userId + organizationId）
 * 后各调一次；同一 `(dataRoot, userId)` 幂等，重复调用仅补齐上次未完成部分。
 */
export async function migrateLegacyPlatformDataToDataRoot(
  options: StorageMigrationOptions,
): Promise<StorageMigrationReport> {
  const report: StorageMigrationReport = {
    scannedOrganizations: 0,
    scannedSpaces: 0,
    movedSkills: 0,
    skippedSkills: 0,
    movedWorkspaceSubdirs: 0,
    skippedWorkspaceSubdirs: 0,
    errors: [],
  }

  const { legacyPlatformDataRoot, logger } = options

  // 主布局：platform-data/organizations/{org}/spaces/{space}/…
  await scanLegacySpacesTree({
    spacesRoot: legacyPlatformDataRoot,
    options,
    report,
  })

  // 更老布局：platform-data/workteams/{org}/spaces/{space}/…（与 organizations 同级）
  const workteamsRoot = path.join(path.dirname(legacyPlatformDataRoot), 'workteams')
  if (await pathExists(workteamsRoot)) {
    logger?.info(`[storage-migration] scanning legacy workteams root: ${workteamsRoot}`)
    await scanLegacySpacesTree({
      spacesRoot: workteamsRoot,
      options,
      report,
    })
  }

  return report
}

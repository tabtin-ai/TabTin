/**
 * CheckpointService — Electron 平台适配层
 *
 * 核心逻辑由 @tabtin/checkpoint-core 提供，本文件仅负责：
 * - 将 Electron 的 createLogger 适配为 CheckpointLogger 接口
 * - 将撤销快照写入当前用户、当前组织的私有数据目录
 * - 按账号范围提供单例缓存（getCheckpointService / destroyCheckpointService）
 */

import {
  CheckpointService,
  createServiceCacheManager,
  type CheckpointLogger,
} from '@tabtin/checkpoint-core'
import { resolveOrganizationCheckpointsDir, resolveUserRoot } from '@tabtin/shared'
import { resolveDataRoot } from '@tabtin/terminal-core'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'
import { TokenManager } from '../auth'
import { getCLIOrganizationId } from '../cli/cli-context'

export { CheckpointService } from '@tabtin/checkpoint-core'
export type { CheckpointDiffEntry } from '@tabtin/checkpoint-core'

const rawLog = createLogger('Checkpoint')

const electronLogger: CheckpointLogger = {
  info: (msg, ...args) => rawLog.info(msg, ...args),
  warn: (msg, ...args) => rawLog.warn(msg, ...args),
  error: (msg, ...args) => rawLog.error(msg, ...args),
  debug: (msg, ...args) => rawLog.debug(msg, ...args),
}

type ServiceCache = ReturnType<typeof createServiceCacheManager>

const cachesByOwnerRoot = new Map<string, ServiceCache>()

function getCurrentUserId(): string | null {
  const userInfo = TokenManager.getCachedUserInfo() as {
    id?: unknown
    user_id?: unknown
    userId?: unknown
  } | null
  const rawUserId = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  return rawUserId === undefined || rawUserId === null || rawUserId === ''
    ? null
    : String(rawUserId)
}

/** 当前账号/组织的撤销快照目录；身份未就绪时拒绝回退到全局目录。 */
export function getCurrentCheckpointRoot(): string | null {
  const userId = getCurrentUserId()
  const organizationId = getCLIOrganizationId()
  if (!userId || !organizationId) return null
  return resolveOrganizationCheckpointsDir(
    resolveDataRoot(),
    userId,
    organizationId,
  )
}

/** 当前登录用户在本设备上的全部组织快照目录，仅供设备存储统计使用。 */
export function getCurrentUserCheckpointRoots(): Array<{
  organizationId: string
  checkpointsRoot: string
}> {
  const userId = getCurrentUserId()
  if (!userId) return []
  const organizationsRoot = path.join(resolveUserRoot(resolveDataRoot(), userId), 'organizations')
  try {
    return fs.readdirSync(organizationsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({
        organizationId: entry.name,
        checkpointsRoot: path.join(organizationsRoot, entry.name, 'checkpoints'),
      }))
  } catch {
    return []
  }
}

function requireCurrentCache(): ServiceCache {
  const checkpointsRoot = getCurrentCheckpointRoot()
  if (!checkpointsRoot) {
    throw new Error('当前账号或组织尚未就绪，无法访问撤销快照')
  }
  let cache = cachesByOwnerRoot.get(checkpointsRoot)
  if (!cache) {
    cache = createServiceCacheManager(
      (normalizedPath) =>
        new CheckpointService(normalizedPath, checkpointsRoot, electronLogger),
    )
    cachesByOwnerRoot.set(checkpointsRoot, cache)
  }
  return cache
}

export function getCheckpointService(projectPath: string): CheckpointService {
  return requireCurrentCache().get(projectPath)
}

export async function destroyCheckpointService(projectPath: string): Promise<void> {
  await requireCurrentCache().destroy(projectPath)
}

export async function destroyCheckpointServiceAtRoot(
  projectPath: string,
  checkpointsRoot: string,
): Promise<void> {
  let cache = cachesByOwnerRoot.get(checkpointsRoot)
  if (!cache) {
    cache = createServiceCacheManager(
      (normalizedPath) =>
        new CheckpointService(normalizedPath, checkpointsRoot, electronLogger),
    )
    cachesByOwnerRoot.set(checkpointsRoot, cache)
  }
  await cache.destroy(projectPath)
}

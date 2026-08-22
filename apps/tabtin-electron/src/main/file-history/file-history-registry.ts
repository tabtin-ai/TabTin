/**
 * File-history registry —— Electron 主进程侧的 per-thread FileHistoryService 接入。
 *
 * 进程内模块级单例（与 checkpoint 的 `getCheckpointService` 同款缓存模式）：
 * - host `createRuntimeForSession` 调 `getOrCreateFileHistory` 注入 `EngineConfig.fileHistory`；
 * - file-history IPC 回退入口调 `getFileHistory` 拿已建实例做 rewind / preview；
 * - session 销毁调 `removeFileHistory`、host 停止调 `clearAllFileHistory` 防内存泄漏。
 *
 * 平台相关只在这一层（logger / historyRoot）；per-thread 缓存与生命周期逻辑下沉到
 * `@tabtin/file-history-core` 的平台无关 `FileHistoryRegistry`。
 */
import { FileHistoryRegistry, type FileHistoryService } from '@tabtin/file-history-core'
import { resolveWorkspaceFileHistoryRoot } from '@tabtin/shared'
import { resolveDataRoot } from '@tabtin/terminal-core'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger'
import { TokenManager } from '../auth'

const log = createLogger('FileHistory')

export interface FileHistoryOwner {
  userId: string
  organizationId: string
  workspaceId: string
}

export interface FileHistoryRoot {
  organizationId: string
  workspaceId: string
  historyRoot: string
}

const registriesByRoot = new Map<string, FileHistoryRegistry>()
const rootsByThreadId = new Map<string, { historyRoot: string; userId: string }>()

function registry(historyRoot: string): FileHistoryRegistry {
  let value = registriesByRoot.get(historyRoot)
  if (!value) {
    value = new FileHistoryRegistry({ historyRoot, logger: log })
    registriesByRoot.set(historyRoot, value)
  }
  return value
}

function currentUserId(): string | null {
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

/** 当前登录用户在本设备上的全部 Workspace 文件回退目录。 */
export function getCurrentUserFileHistoryRoots(): FileHistoryRoot[] {
  const userId = currentUserId()
  if (!userId) return []
  const organizationsRoot = path.join(resolveDataRoot(), 'users', userId, 'organizations')
  const roots: FileHistoryRoot[] = []
  let organizations: fs.Dirent[]
  try {
    organizations = fs.readdirSync(organizationsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const organization of organizations) {
    if (!organization.isDirectory()) continue
    const workspacesRoot = path.join(organizationsRoot, organization.name, 'workspaces')
    let workspaces: fs.Dirent[]
    try {
      workspaces = fs.readdirSync(workspacesRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue
      roots.push({
        organizationId: organization.name,
        workspaceId: workspace.name,
        historyRoot: path.join(workspacesRoot, workspace.name, 'file-history'),
      })
    }
  }
  return roots
}

/** 按 threadId 取/建 per-thread 回退引擎（host 装配期注入用）。不存在才 new + resume。 */
export function getOrCreateFileHistory(
  threadId: string,
  workspaceRoot: string,
  owner: FileHistoryOwner,
): Promise<FileHistoryService> {
  const historyRoot = resolveWorkspaceFileHistoryRoot(
    resolveDataRoot(),
    owner.userId,
    owner.organizationId,
    owner.workspaceId,
  )
  rootsByThreadId.set(threadId, { historyRoot, userId: owner.userId })
  return registry(historyRoot).getOrCreate(threadId, workspaceRoot)
}

/** 取已建实例（仅内存缓存命中）。未跑过 query 的 thread → undefined。 */
export function getFileHistory(threadId: string): FileHistoryService | undefined {
  const active = rootsByThreadId.get(threadId)
  if (!active || active.userId !== currentUserId()) return undefined
  return registry(active.historyRoot).get(threadId)
}

/**
 * 回退入口（IPC rewind / preview）用：取已建实例，**内存 miss 时从磁盘 manifest lazy
 * 恢复**（Bug 1）。修"进程重启后对一个没再发过消息的历史会话点回退失败"——重启后内存空
 * 但磁盘账本仍在。磁盘也没有 → undefined（调用方据此拒绝回退，绝不静默成功）。
 */
export async function getOrResumeFileHistory(threadId: string): Promise<FileHistoryService | undefined> {
  const userId = currentUserId()
  if (!userId) return undefined
  const active = rootsByThreadId.get(threadId)
  if (active?.userId === userId) return registry(active.historyRoot).getOrResume(threadId)
  if (active) rootsByThreadId.delete(threadId)
  for (const { historyRoot } of getCurrentUserFileHistoryRoots()) {
    const service = await registry(historyRoot).getOrResume(threadId)
    if (service) {
      rootsByThreadId.set(threadId, { historyRoot, userId })
      return service
    }
  }
  return undefined
}

/** session 销毁时从缓存移除（保留磁盘备份，后续可 resume）。 */
export async function removeFileHistory(threadId: string): Promise<void> {
  const active = rootsByThreadId.get(threadId)
  if (!active || active.userId !== currentUserId()) return
  await registry(active.historyRoot).remove(threadId)
  rootsByThreadId.delete(threadId)
}

/** host 停止时清空全部缓存（保留磁盘备份）。registry 未初始化则 no-op。 */
export async function clearAllFileHistory(): Promise<void> {
  await Promise.all(Array.from(registriesByRoot.values(), value => value.clear()))
  rootsByThreadId.clear()
}

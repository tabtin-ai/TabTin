/**
 * 外部 Agent 导入：Electron 主进程 IPC 装配（spec §2.5）。
 *
 * - 构造 AgentImportRunnerImpl（注入进度广播 + 用户数据目录下 attachmentDir）
 * - createImportSurfaces(runner) → registerSurfaceAsIpc 逐个挂到 ipcMain
 *   （channel: import:detect / scan / run / status / cancel / rollback）
 * - 进度事件 import:progress 仅投递给发起 run 的窗口（有 owner 时），
 *   renderer 通过 window.tabtin.import.onProgress 订阅
 */

import { BrowserWindow } from 'electron'
import { okResponse, errResponse } from '@tabtin/agent-wire'
import {
  SurfaceError,
  createImportSurfaces,
  getSurfaceContext,
  IMPORT_PROGRESS_CHANNEL,
  type ImportProgressEvent,
  type ImportRunInput,
} from '@tabtin/cli-server-core'
import { registerSurfaceAsIpc } from '../wire/register-surface-as-ipc'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'
import { AgentImportRunnerImpl, resolveImportAttachmentDir } from './runner'
import {
  bindOpenedSession,
  deleteArchives,
  readArchive,
  readIndex,
  trySafeImportSource,
  trySafeOrganizationId,
} from './archive-store'

const log = createLogger('AgentImportIPC')

const archiveSeedInFlight = new Map<string, Promise<{ seeded: boolean; reason: string }>>()

async function seedArchiveTranscriptForSession(input: {
  organizationId: string
  source: string
  sourceSessionId: string
  sessionId: string
  spaceId?: string
}): Promise<{ seeded: boolean; reason: string }> {
  const archive = readArchive(
    input.organizationId,
    input.source,
    input.sourceSessionId,
  )
  if (!archive) {
    return { seeded: false, reason: 'archive_missing' }
  }
  const spaceId = input.spaceId?.trim() || archive.meta.workspaceId?.trim() || ''
  if (!spaceId) {
    return { seeded: false, reason: 'space_missing' }
  }
  const seedKey = input.sessionId
  const pending = archiveSeedInFlight.get(seedKey)
  if (pending) return pending

  const task = (async () => {
  try {
    const { electronAgentHost } = await import('../agent/ElectronAgentHost')
    return await electronAgentHost.seedExternalArchiveTranscript({
      sessionId: input.sessionId,
      spaceId,
      organizationId: input.organizationId,
      messages: archive.messages,
      meta: {
        source: archive.meta.source,
        sourceSessionId: archive.meta.sourceSessionId,
        title: archive.meta.title,
        cwd: archive.meta.cwd,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('导入档案写入 transcript 失败', {
      organizationId: input.organizationId,
      source: input.source,
      sourceSessionId: input.sourceSessionId,
      sessionId: input.sessionId,
      error: message,
    }, err)
    return { seeded: false, reason: 'seed_failed' }
  }
  })()
  archiveSeedInFlight.set(seedKey, task)
  try {
    return await task
  } finally {
    if (archiveSeedInFlight.get(seedKey) === task) {
      archiveSeedInFlight.delete(seedKey)
    }
  }
}

/** import surface 的 6 个 IPC channel（unregister 时移除用）。 */
export const IMPORT_SURFACE_CHANNELS = [
  'import:detect',
  'import:scan',
  'import:run',
  'import:status',
  'import:cancel',
  'import:rollback',
] as const

/** 本机档案 IPC（unregister / hot reload 时与 surface 一并移除）。 */
export const IMPORT_ARCHIVE_CHANNELS = [
  'import:listArchives',
  'import:getArchive',
  'import:deleteArchive',
  'import:deleteArchivesForWorkspace',
  'import:bindOpenedSession',
  'import:seedSessionTranscript',
] as const

let _registered = false

/** 广播进度：有 IPC owner 时只投递给发起窗口，避免跨窗口泄露路径信息。 */
function broadcastProgress(
  payload: ImportProgressEvent,
  ownerWebContentsId: number | null,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (
      ownerWebContentsId != null
      && win.webContents.id !== ownerWebContentsId
    ) {
      continue
    }
    try {
      win.webContents.send(IMPORT_PROGRESS_CHANNEL, payload)
    } catch {
      /* 窗口销毁竞态：忽略 */
    }
  }
}

/**
 * 注册 import surface 为 IPC handler。幂等（hot reload 场景重复调用安全）——
 * definePlatformSurface 全局注册表对重复 channel 会抛错，故用 flag 守卫只跑一次。
 */
export function registerAgentImportSurfaces(): void {
  if (_registered) return
  const runner = new AgentImportRunnerImpl({
    emitProgress: broadcastProgress,
    attachmentDir: resolveImportAttachmentDir(),
  })
  const surfaces = createImportSurfaces(runner)
  registerSurfaceAsIpc(surfaces.importDetect)
  registerSurfaceAsIpc(surfaces.importScan)
  // import:run 单独挂：注入发起窗口 id，供进度隔离与 job owner 绑定
  guardedHandle(
    'import:run',
    async (event, rawInput: ImportRunInput | Record<string, unknown>) => {
      runner.noteIpcOwnerWebContentsId(event.sender.id)
      try {
        const ctx = getSurfaceContext()
        const result = await surfaces.importRun.def.handler(
          rawInput as ImportRunInput,
          ctx,
        )
        return okResponse(result)
      } catch (err: unknown) {
        if (err instanceof SurfaceError) {
          return errResponse(err.code, err.message, { detail: err.detail })
        }
        const message = err instanceof Error ? err.message : String(err)
        log.error('import:run 未预期异常', {}, err)
        return errResponse('INTERNAL_ERROR', message)
      } finally {
        runner.noteIpcOwnerWebContentsId(null)
      }
    },
  )
  registerSurfaceAsIpc(surfaces.importStatus)
  registerSurfaceAsIpc(surfaces.importCancel)
  registerSurfaceAsIpc(surfaces.importRollback)

  // 本机档案只读查询（特化展示用；不走 PlatformSurface / CLI）。
  // 必须返 wire envelope，preload invokeIpc 才会 unwrap（见 ipc-shim）。
  // organizationId / source 经 trySafe* 拒绝 ../ 与非法枚举。
  guardedHandle('import:listArchives', (_e, organizationId: string) => {
    if (!trySafeOrganizationId(organizationId)) {
      return okResponse([])
    }
    return okResponse(readIndex(organizationId))
  })
  guardedHandle(
    'import:getArchive',
    (
      _e,
      input: { organizationId: string; source: string; sourceSessionId: string },
    ) => {
      if (
        !trySafeOrganizationId(input?.organizationId)
        || !trySafeImportSource(input?.source)
        || !input?.sourceSessionId
      ) {
        return okResponse(null)
      }
      return okResponse(
        readArchive(input.organizationId, input.source, input.sourceSessionId),
      )
    },
  )
  guardedHandle(
    'import:bindOpenedSession',
    async (
      _e,
      input: {
        organizationId: string
        source: string
        sourceSessionId: string
        sessionId: string
      },
    ) => {
      if (
        !trySafeOrganizationId(input?.organizationId)
        || !trySafeImportSource(input?.source)
        || !input?.sourceSessionId
        || !input?.sessionId
      ) {
        return okResponse({ ok: false })
      }
      const bound = bindOpenedSession(input)
      if (!bound) {
        return okResponse({ ok: false, seeded: false, reason: 'not_bound' })
      }
      const seed = await seedArchiveTranscriptForSession(input)
      return okResponse({ ok: true, ...seed })
    },
  )
  guardedHandle(
    'import:seedSessionTranscript',
    async (
      _e,
      input: {
        organizationId: string
        source: string
        sourceSessionId: string
        sessionId: string
        spaceId?: string
      },
    ) => {
      if (
        !trySafeOrganizationId(input?.organizationId)
        || !trySafeImportSource(input?.source)
        || !input?.sourceSessionId
        || !input?.sessionId
      ) {
        return okResponse({ seeded: false, reason: 'invalid_input' })
      }
      const result = await seedArchiveTranscriptForSession(input)
      return okResponse(result)
    },
  )

  // 侧栏单条删除本机外部档案（source + sourceSessionId）。
  guardedHandle(
    'import:deleteArchive',
    (
      _e,
      input: {
        organizationId: string
        source: string
        sourceSessionId: string
      },
    ) => {
      if (
        !trySafeOrganizationId(input?.organizationId)
        || !trySafeImportSource(input?.source)
        || !input?.sourceSessionId
      ) {
        return okResponse({ deleted: 0 })
      }
      try {
        const result = deleteArchives({
          organizationId: input.organizationId,
          source: input.source,
          sourceSessionIds: [input.sourceSessionId],
        })
        if (result.deleted > 0) {
          log.info('删除本机外部档案', {
            organizationId: input.organizationId,
            source: input.source,
            sourceSessionId: input.sourceSessionId,
            deleted: result.deleted,
          })
        }
        return okResponse(result)
      } catch (err) {
        log.error('删除本机外部档案失败', {
          organizationId: input?.organizationId,
          source: input?.source,
          sourceSessionId: input?.sourceSessionId,
        }, err)
        return errResponse('INTERNAL_ERROR', '删除外部档案失败')
      }
    },
  )

  // 删 Workspace 后清理本机档案（workspaceId 或同 cwd，OR）。
  guardedHandle(
    'import:deleteArchivesForWorkspace',
    (
      _e,
      input: {
        organizationId: string
        workspaceId: string
        workingDir?: string | null
      },
    ) => {
      if (!trySafeOrganizationId(input?.organizationId) || !input?.workspaceId) {
        return okResponse({ deleted: 0 })
      }
      try {
        const result = deleteArchives({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          cwd: input.workingDir ?? null,
        })
        if (result.deleted > 0) {
          log.info('删 Workspace 顺带清本机档案', {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            workingDir: input.workingDir ?? null,
            deleted: result.deleted,
          })
        }
        return okResponse(result)
      } catch (err) {
        // 删 Workspace 主路径已成功时，本机档案清理失败不阻断；软失败给 0。
        log.warn('删 Workspace 清本机档案失败（忽略）', err)
        return okResponse({ deleted: 0 })
      }
    },
  )

  _registered = true
  log.info('import surfaces 注册完成', {
    channels: IMPORT_SURFACE_CHANNELS.length + IMPORT_ARCHIVE_CHANNELS.length,
  })
}

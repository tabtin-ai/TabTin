/**
 * AgentImportRunner · 本机档案馆编排（轻量化正典）。
 *
 * 流程：
 *   1. parseSession（agent-import）
 *   2. 常态 Workspace：list → 同设备精确目录或最长父目录命中则合流到已有工作空间；
 *      同批已新建则复用；否则 POST create
 *   3. 写入本机特化档案（userData/external-archives）；同源会话已存在则拒绝
 *   4. 进度事件；失败单会话不中断整批
 *
 * 不做：Django /api/import/*、ChatSession 灌库、CLI。
 * SessionStorage：展开绑定真会话时由 seedSessionTranscript 写入本机 transcript
 * （不上云）；导入扫描阶段尚无 session id，无法提前落盘。
 */

import * as path from 'node:path'
import { app } from 'electron'
import {
  NodeImportIO,
  assertImportSourcePath,
  detectAll,
  getAdapter,
} from '@tabtin/agent-import'
import type {
  ImportIO,
  SessionRef,
  UnifiedMessage,
  ImportSource,
} from '@tabtin/agent-import'
import type {
  AgentImportRunner,
  ImportCancelInput,
  ImportCancelOutput,
  ImportDetectOutput,
  ImportDetectResult,
  ImportProgressEvent,
  ImportRollbackInput,
  ImportRollbackOutput,
  ImportRunInput,
  ImportRunOutput,
  ImportRunReport,
  ImportScanInput,
  ImportScanResult,
  ImportSessionRef,
  ImportStatusInput,
  ImportStatusOutput,
  ImportJobState,
  SurfaceContext,
  DjangoRequestFn,
  ImportSourceId,
} from '@tabtin/cli-server-core'
import { getCLIOrganizationId } from '../cli/cli-context'
import { createLogger } from '../logger'
import { unifiedBlocksToContentBlocks } from './block-conversion'
import {
  archiveExists,
  deleteArchives,
  resolveArchiveDir,
  trySafeOrganizationId,
  writeArchive,
  type ArchiveMessage,
} from './archive-store'
import { materializeSessionImages } from './materialize-images'
import { resolveAuthoritativeSessionRefs } from './resolve-session-refs'

const log = createLogger('AgentImport')

interface ImportJob {
  jobId: string
  state: ImportJobState
  progress: { done: number; total: number }
  report: ImportRunReport
  organizationId: string
  importedArchives: Array<{ source: ImportSourceId; sourceSessionId: string }>
  createdWorkspaceIds: string[]
  deviceId: string
  /** IPC 发起窗口；进度只投递给它。HTTP/CLI 路径为 null。 */
  ownerWebContentsId: number | null
  cancelled: boolean
}

export interface AgentImportRunnerDeps {
  emitProgress: (
    payload: ImportProgressEvent,
    ownerWebContentsId: number | null,
  ) => void
  attachmentDir: string
}

function emptyReport(): ImportRunReport {
  return {
    visible: 0,
    archived: 0,
    titleOnly: 0,
    skipped: 0,
    failed: 0,
    subagentSessions: 0,
    failures: [],
  }
}

function unwrapData(result: { status: number; data: unknown }): Record<string, unknown> {
  const d = result.data as Record<string, unknown> | undefined
  if (d && typeof d === 'object' && 'data' in d && typeof d.data === 'object' && d.data !== null) {
    return d.data as Record<string, unknown>
  }
  return (d ?? {}) as Record<string, unknown>
}

function errMessage(result: { status: number; data: unknown }): string {
  const msg = unwrapData(result).message
  return typeof msg === 'string' && msg ? msg : `HTTP ${result.status}`
}

function basenameTitle(cwd: string | null | undefined, fallback: string): string {
  if (!cwd) return fallback
  const base = path.basename(cwd.replace(/[/\\]+$/, ''))
  return base || fallback
}

class WorkingDirConflictError extends Error {
  constructor(workingDir: string) {
    super(`Workspace 已存在（WORKING_DIR_CONFLICT）：${workingDir}`)
    this.name = 'WorkingDirConflictError'
  }
}

function isWorkingDirConflict(err: unknown): boolean {
  return err instanceof WorkingDirConflictError
}

export function resolveImportAttachmentDir(): string {
  return path.join(app.getPath('userData'), 'import-attachments')
}

export class AgentImportRunnerImpl implements AgentImportRunner {
  private readonly attachmentDir: string
  private readonly emitProgress: (
    payload: ImportProgressEvent,
    ownerWebContentsId: number | null,
  ) => void
  private readonly jobs = new Map<string, ImportJob>()
  /** 下一次 run 绑定的 IPC sender；HTTP 路径保持 null。 */
  private nextOwnerWebContentsId: number | null = null

  constructor(deps: AgentImportRunnerDeps) {
    this.attachmentDir = deps.attachmentDir
    this.emitProgress = deps.emitProgress
  }

  /** IPC 装配在调用 run 前注入发起窗口 id，用于进度投递隔离。 */
  noteIpcOwnerWebContentsId(webContentsId: number | null): void {
    this.nextOwnerWebContentsId = webContentsId
  }

  getJobOrganizationId(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.organizationId
  }

  getJobOwnerWebContentsId(jobId: string): number | null | undefined {
    return this.jobs.get(jobId)?.ownerWebContentsId
  }

  async detect(): Promise<ImportDetectOutput> {
    const detectIo = new NodeImportIO(this.attachmentDir)
    const detections = await detectAll(detectIo)
    return { sources: detections as unknown as ImportDetectResult[] }
  }

  async scan(input: ImportScanInput): Promise<ImportScanResult> {
    const adapter = getAdapter(input.source as ImportSource)
    const io = new NodeImportIO(this.attachmentDir)
    const result = await adapter.scan(io, {
      ...(input.since ? { since: new Date(input.since) } : {}),
      ...(typeof input.includeArchived === 'boolean' ? { includeArchived: input.includeArchived } : {}),
    })
    return result as unknown as ImportScanResult
  }

  async run(input: ImportRunInput, ctx: SurfaceContext): Promise<ImportRunOutput> {
    const orgId = trySafeOrganizationId(input.options.targetOrganizationId)
    if (!orgId) {
      throw new Error(
        `非法 targetOrganizationId（须为单层安全键）: ${String(input.options.targetOrganizationId)}`,
      )
    }
    const total = input.sources.reduce((acc, s) => acc + (s.sessionRefs?.length ?? 0), 0)
    const ownerWebContentsId = this.nextOwnerWebContentsId
    this.nextOwnerWebContentsId = null
    const job: ImportJob = {
      jobId: input.jobId,
      state: 'running',
      progress: { done: 0, total },
      report: emptyReport(),
      organizationId: orgId,
      importedArchives: [],
      createdWorkspaceIds: [],
      deviceId: input.options.deviceId,
      ownerWebContentsId,
      cancelled: false,
    }
    this.jobs.set(input.jobId, job)
    const djangoRequest = ctx.djangoRequest
    const io = new NodeImportIO(this.attachmentDir)
    void this._runJob(job, input, djangoRequest, io).catch((err) => {
      job.state = 'error'
      log.error('import job 未捕获异常', { jobId: job.jobId }, err)
    })
    return { jobId: input.jobId }
  }

  /** 调用方组织与 job 不一致时当作不存在（防跨 org 探活 / 取消）。 */
  private _authorizeJob(jobId: string): ImportJob | null {
    const job = this.jobs.get(jobId)
    if (!job) return null
    const callerOrg = getCLIOrganizationId()
    if (callerOrg && trySafeOrganizationId(callerOrg) && callerOrg !== job.organizationId) {
      return null
    }
    return job
  }

  async status(input: ImportStatusInput): Promise<ImportStatusOutput> {
    const job = this._authorizeJob(input.jobId)
    if (!job) return { state: 'error', progress: { done: 0, total: 0 } }
    return { state: job.state, progress: { ...job.progress }, report: { ...job.report } }
  }

  async cancel(input: ImportCancelInput): Promise<ImportCancelOutput> {
    const job = this._authorizeJob(input.jobId)
    if (!job || job.state !== 'running') return { cancelled: false }
    job.cancelled = true
    return { cancelled: true }
  }

  /** 删除本机档案；按 jobId 完整回滚时，同时删除本次导入新建的 Workspace。 */
  async rollback(input: ImportRollbackInput, ctx: SurfaceContext): Promise<ImportRollbackOutput> {
    const job = input.jobId ? this._authorizeJob(input.jobId) : undefined
    if (input.jobId && !job) return { deletedSessions: 0, deletedMessages: 0 }
    const organizationId = input.organization ?? job?.organizationId ?? getCLIOrganizationId() ?? undefined
    if (!organizationId || !trySafeOrganizationId(organizationId)) {
      return { deletedSessions: 0, deletedMessages: 0 }
    }
    // 有 job 时禁止用另一个 organization 覆盖删档
    if (job && input.organization && input.organization !== job.organizationId) {
      return { deletedSessions: 0, deletedMessages: 0 }
    }

    if (job && !input.source && (!Array.isArray(input.sessionIds) || input.sessionIds.length === 0)) {
      let deleted = 0
      const bySource = new Map<ImportSourceId, string[]>()
      for (const archive of job.importedArchives) {
        const list = bySource.get(archive.source) ?? []
        list.push(archive.sourceSessionId)
        bySource.set(archive.source, list)
      }
      for (const [source, sourceSessionIds] of bySource) {
        deleted += deleteArchives({
          organizationId,
          source,
          sourceSessionIds,
        }).deleted
      }
      await this._deleteCreatedWorkspaces(job, ctx.djangoRequest)
      return { deletedSessions: deleted, deletedMessages: 0 }
    }

    const { deleted } = deleteArchives({
      organizationId,
      ...(input.source ? { source: input.source } : {}),
      ...(Array.isArray(input.sessionIds) && input.sessionIds.length > 0
        ? { sourceSessionIds: input.sessionIds }
        : {}),
    })
    return { deletedSessions: deleted, deletedMessages: 0 }
  }

  private async _deleteCreatedWorkspaces(
    job: ImportJob,
    djangoRequest: DjangoRequestFn,
  ): Promise<void> {
    const uniqueWorkspaceIds = [...new Set(job.createdWorkspaceIds.filter(Boolean))]
    for (const workspaceId of uniqueWorkspaceIds) {
      const query = job.deviceId ? `?device_id=${encodeURIComponent(job.deviceId)}` : ''
      try {
        const res = await djangoRequest(
          'DELETE',
          `/api/context/workspaces/${encodeURIComponent(workspaceId)}${query}`,
        )
        if (res.status >= 400 && res.status !== 404) {
          log.warn('删除导入创建的 Workspace 失败（继续回滚档案）', {
            jobId: job.jobId,
            workspaceId,
            status: res.status,
            message: errMessage(res),
          })
        }
      } catch (err) {
        log.warn('删除导入创建的 Workspace 异常（继续回滚档案）', {
          jobId: job.jobId,
          workspaceId,
        }, err)
      }
    }
  }

  /**
   * 客户端 sessionRefs 只当「选择清单」(source + sourceSessionId)；
   * sourcePath 一律丢弃，由主进程 scan 结果权威重解析（阻塞项 1）。
   */
  private async _resolveAuthoritativeRefs(
    job: ImportJob,
    group: { source: ImportSourceId; sessionRefs?: ImportSessionRef[] },
    since?: string,
  ): Promise<ImportSessionRef[]> {
    let scanned: ImportScanResult
    try {
      scanned = await this.scan({
        source: group.source,
        ...(since ? { since } : {}),
      })
    } catch (err) {
      log.warn('权威 scan 失败，跳过该 source', { source: group.source }, err)
      return []
    }
    const { refs, failures } = resolveAuthoritativeSessionRefs({
      groupSource: group.source,
      scanned,
      clientRefs: group.sessionRefs,
    })
    for (const f of failures) {
      job.report.failed += 1
      job.report.failures.push(f)
    }
    return refs
  }

  private async _runJob(
    job: ImportJob,
    input: ImportRunInput,
    djangoRequest: DjangoRequestFn,
    io: ImportIO,
  ): Promise<void> {
    const { targetOrganizationId, deviceId, redact } = input.options
    const safeOrg = trySafeOrganizationId(targetOrganizationId)
    if (!safeOrg) {
      job.state = 'error'
      job.report.failed += 1
      job.report.failures.push({
        source: input.sources[0]?.source ?? 'codex',
        sourceSessionId: '',
        error: `非法 targetOrganizationId: ${targetOrganizationId}`,
      })
      this._emit(job, '', 'error')
      return
    }

    const allRefs: ImportSessionRef[] = []
    for (const group of input.sources) {
      const refs = await this._resolveAuthoritativeRefs(job, group, input.options.since)
      if (!group.sessionRefs || group.sessionRefs.length === 0) {
        // CLI 缺省清单：total 以 scan 为准重算
        job.progress.total += refs.length
      }
      allRefs.push(...refs)
    }
    // 同批存在父子目录时先处理父目录：父 Workspace 创建后会写回 existingWorkspaces，
    // 后续子目录即可按最长前缀合流，避免导入结果依赖 scan / 用户勾选顺序。
    allRefs.sort((a, b) => importPathLength(a.cwd) - importPathLength(b.cwd))
    // UI 显式清单：total = 成功解析数 + 已记入 failures 的条数（保持进度分母稳定）
    if (input.sources.some((s) => (s.sessionRefs?.length ?? 0) > 0)) {
      job.progress.total = allRefs.length + job.report.failed
    }

    // 预取组织下 Workspace。同设备同目录命中则合流；同批内先建后复用。
    const existingWorkspaces = await this._listWorkspaces(djangoRequest, safeOrg)

    for (const rawRef of allRefs) {
      if (job.cancelled) break
      try {
        await this._importOneSession(job, {
          io,
          ref: rawRef,
          djangoRequest,
          targetOrganizationId: safeOrg,
          deviceId,
          redact: redact ?? true,
          existingWorkspaces,
        })
      } catch (err) {
        job.report.failed += 1
        job.report.failures.push({
          source: rawRef.source,
          sourceSessionId: rawRef.sourceSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        log.warn('单会话导入失败（不中断整批）', {
          source: rawRef.source,
          sourceSessionId: rawRef.sourceSessionId,
        }, err)
      }
      job.progress.done += 1
      this._emit(job, this._workspaceLabel(rawRef), 'importing')
    }

    if (job.cancelled) {
      job.state = 'cancelled'
      this._emit(job, '', 'cancelled')
      return
    }
    job.state = 'completed'
    this._emit(job, '', 'done')
  }

  private async _importOneSession(
    job: ImportJob,
    args: {
      io: ImportIO
      ref: ImportSessionRef
      djangoRequest: DjangoRequestFn
      targetOrganizationId: string
      deviceId: string
      redact: boolean
      existingWorkspaces: WorkspaceRow[]
    },
  ): Promise<void> {
    const {
      io,
      ref,
      djangoRequest,
      targetOrganizationId,
      deviceId,
      redact,
      existingWorkspaces,
    } = args

    if (archiveExists(targetOrganizationId, ref.source, ref.sourceSessionId)) {
      job.report.skipped += 1
      job.report.failures.push({
        source: ref.source as ImportSourceId,
        sourceSessionId: ref.sourceSessionId,
        error: '会话已导入过（一次性）。删除对应 Workspace 或本机档案后可重来。',
      })
      return
    }

    const adapter = getAdapter(ref.source as ImportSource)
    this._emit(job, this._workspaceLabel(ref), 'parsing')
    // 防御：即便 scan 结果异常，也不读白名单外 / 红线路径
    assertImportSourcePath(io, ref.source as ImportSource, ref.sourcePath)
    const session = await adapter.parseSession(io, ref as unknown as SessionRef, { redact })

    // 无消息：不建 Workspace、不落档案（避免侧栏堆「无标题 / 0 消息」）
    if (!(session.messages?.length)) {
      job.report.skipped += 1
      return
    }

    const cwd = session.cwd?.trim() || null
    let workspaceId: string | null = null
    let workspaceName: string | null = null

    if (cwd) {
      const hit = this._findWorkspaceForDir(existingWorkspaces, deviceId, cwd)
      if (hit) {
        // 导入前已有，或同批刚建 → 合流到该工作空间（挂外部对话档案，不改 Workspace 字段）。
        workspaceId = hit.id
        workspaceName = hit.name || basenameTitle(cwd, 'Imported')
      } else {
        try {
          const created = await this._createWorkspace(djangoRequest, {
            organizationId: targetOrganizationId,
            deviceId,
            workingDir: cwd,
            name: basenameTitle(cwd, session.title || 'Imported'),
          })
          workspaceId = created.id
          workspaceName = created.name
          job.createdWorkspaceIds.push(created.id)
          existingWorkspaces.push({
            id: created.id,
            name: created.name,
            device_id: deviceId,
            working_dir: cwd,
          })
        } catch (err) {
          // 列表与创建之间被他人占目录：刷新后合流，避免误报「请先删除」。
          if (!isWorkingDirConflict(err)) throw err
          const refreshed = await this._listWorkspaces(djangoRequest, targetOrganizationId)
          existingWorkspaces.splice(0, existingWorkspaces.length, ...refreshed)
          const again = this._findWorkspaceForDir(existingWorkspaces, deviceId, cwd)
          if (!again) throw err
          workspaceId = again.id
          workspaceName = again.name || basenameTitle(cwd, 'Imported')
        }
      }
    }

    // Workspace 定下来后再拷图落档，避免拒绝路径留下孤儿 attachments/
    const archivePath = resolveArchiveDir(
      targetOrganizationId,
      ref.source,
      ref.sourceSessionId,
    )
    const materialized = materializeSessionImages(
      session.messages,
      path.join(archivePath, 'attachments'),
    )
    const messages = this._messagesFromList(materialized, session.sourceSessionId)
    if (messages.length === 0) {
      job.report.skipped += 1
      return
    }

    writeArchive({
      meta: {
        source: ref.source as ImportSourceId,
        sourceSessionId: ref.sourceSessionId,
        title: session.title || basenameTitle(cwd, ref.sourceSessionId),
        cwd,
        workspaceId,
        workspaceName,
        deviceId,
        organizationId: targetOrganizationId,
        importedAt: new Date().toISOString(),
        layer: session.layer || 'full',
        messageCount: messages.length,
        archived: Boolean(session.archived),
        kind: 'external_archive',
      },
      messages,
    })
    job.importedArchives.push({
      source: ref.source as ImportSourceId,
      sourceSessionId: ref.sourceSessionId,
    })

    // 子会话：同样只落本机档案，挂同一 workspaceId；已存在则跳过。
    for (const sub of session.subagents ?? []) {
      const subKey = `${ref.sourceSessionId}::sub::${sub.sourceId}`
      if (archiveExists(targetOrganizationId, ref.source, subKey)) {
        job.report.skipped += 1
        continue
      }
      if (!(sub.messages?.length)) continue
      const subArchivePath = resolveArchiveDir(targetOrganizationId, ref.source, subKey)
      const subMaterialized = materializeSessionImages(
        sub.messages,
        path.join(subArchivePath, 'attachments'),
      )
      const subMessages = this._messagesFromList(subMaterialized, subKey)
      if (subMessages.length === 0) continue
      writeArchive({
        meta: {
          source: ref.source as ImportSourceId,
          sourceSessionId: subKey,
          title: sub.description || `${session.title || 'Imported'} · sub`,
          cwd,
          workspaceId,
          workspaceName,
          deviceId,
          organizationId: targetOrganizationId,
          importedAt: new Date().toISOString(),
          layer: session.layer || 'full',
          messageCount: subMessages.length,
          archived: Boolean(session.archived),
          kind: 'external_archive',
        },
        messages: subMessages,
      })
      job.importedArchives.push({
        source: ref.source as ImportSourceId,
        sourceSessionId: subKey,
      })
      job.report.subagentSessions += 1
    }

    if (session.archived) job.report.archived += 1
    else job.report.visible += 1
  }

  private _messagesFromList(
    messages: UnifiedMessage[],
    idPrefix = 'msg',
  ): ArchiveMessage[] {
    const out: ArchiveMessage[] = []
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user'
      const content_blocks = unifiedBlocksToContentBlocks(msg.blocks ?? [])
      out.push({
        id: msg.id || `${idPrefix}-${out.length}`,
        role,
        content_blocks,
        created_at: msg.createdAt || new Date().toISOString(),
        model_name: msg.model ?? null,
      })
    }
    return out
  }

  private async _listWorkspaces(
    djangoRequest: DjangoRequestFn,
    organizationId: string,
  ): Promise<WorkspaceRow[]> {
    const res = await djangoRequest(
      'GET',
      `/api/context/workspaces?organization_id=${encodeURIComponent(organizationId)}`,
    )
    if (res.status >= 400) {
      throw new Error(`list workspaces: ${errMessage(res)}`)
    }
    const data = unwrapData(res)
    const list = Array.isArray(data.workspaces) ? data.workspaces : []
    return list.map((raw) => {
      const w = raw as Record<string, unknown>
      return {
        id: String(w.id ?? ''),
        name: typeof w.name === 'string' ? w.name : '',
        device_id: String(w.device_id ?? w.deviceId ?? ''),
        working_dir: typeof w.working_dir === 'string' ? w.working_dir : '',
      }
    }).filter((w) => w.id)
  }

  private _findWorkspaceForDir(
    workspaces: WorkspaceRow[],
    deviceId: string,
    cwd: string,
  ): WorkspaceRow | undefined {
    const target = normalizeDir(cwd)
    if (!target) return undefined

    return workspaces
      .filter((workspace) => workspace.device_id === deviceId)
      .map((workspace) => ({ workspace, dir: normalizeDir(workspace.working_dir) }))
      .filter(({ dir }) => dir && (dir === target || target.startsWith(`${dir}/`)))
      .sort((a, b) => b.dir.length - a.dir.length)[0]?.workspace
  }

  private async _createWorkspace(
    djangoRequest: DjangoRequestFn,
    args: {
      organizationId: string
      deviceId: string
      workingDir: string
      name: string
    },
  ): Promise<{ id: string; name: string }> {
    const res = await djangoRequest('POST', '/api/context/workspaces', {
      organization_id: args.organizationId,
      device_id: args.deviceId,
      working_dir: args.workingDir,
      name: args.name,
    })
    if (res.status === 409) {
      throw new WorkingDirConflictError(args.workingDir)
    }
    if (res.status >= 400) {
      throw new Error(`create workspace: ${errMessage(res)}`)
    }
    const data = unwrapData(res)
    const id = String(data.id ?? '')
    if (!id) throw new Error('create workspace 响应缺少 id')
    return { id, name: typeof data.name === 'string' ? data.name : args.name }
  }

  private _workspaceLabel(ref: ImportSessionRef): string {
    return ref.cwd || ref.title || ref.sourceSessionId
  }

  private _emit(job: ImportJob, workspace: string, phase: string): void {
    this.emitProgress(
      {
        jobId: job.jobId,
        workspace,
        done: job.progress.done,
        total: job.progress.total,
        phase,
      },
      job.ownerWebContentsId,
    )
  }
}

interface WorkspaceRow {
  id: string
  name: string
  device_id: string
  working_dir: string
}

function normalizeDir(dir: string): string {
  return dir.replace(/[/\\]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function importPathLength(dir: string | null | undefined): number {
  const normalized = normalizeDir(dir ?? '')
  return normalized ? normalized.length : Number.MAX_SAFE_INTEGER
}

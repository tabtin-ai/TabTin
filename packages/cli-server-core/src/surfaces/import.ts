/**
 * import — 外部 Agent 工具（Cursor / Codex / Claude Code / WorkBuddy）本地会话
 * 数据导入的宿主编排 PlatformSurface（spec §2.1）。
 *
 * 分层职责：
 *   - **cli-server-core（本文件）**：只定义 surface 壳 + I/O 契约类型 +
 *     `AgentImportRunner` 注入接口。detect/scan/run/status/cancel/rollback 六个
 *     verb 的 IPC channel（`import:*`）与 HTTP path（`/import/*`）由此派生，
 *     供 renderer 向导 UI 与 `tabtin import` CLI 双 binding 对接。
 *   - **Electron 主进程（apps/tabtin-electron/src/main/agent-import/）**：实现
 *     `AgentImportRunner`——注入 NodeImportIO（白名单在 agent-import paths.ts 已拦、
 *     attachmentDir 落用户数据目录）、parseSession、UnifiedBlock→ContentBlock 转换、
 *     调 Django ensure-session / append-messages、写本地 transcript、推进度事件。
 *   - **Django（apps/tabtin_django/**）**：两段式导入 API（另一 agent 并行实现）。
 *
 * 注入模式参照 `@tabtin/cli-routes` 的 `configureCLIRoutes` / `createSessionSurfaces`：
 * 宿主启动时 `createImportSurfaces(runner)` 用闭包捕获运行能力，surface 定义本身
 * 不耦合 Electron 特有类。
 *
 * 契约不变量（spec §5）由 runner 兑现：会话/消息双幂等键、子会话 thread_id 含
 * `-sub-`、占位会话落说明消息、Workspace get 不改字段、源时间戳保真、默认个人
 * 组织、失败单会话不中断整批。
 */

import { randomUUID } from 'node:crypto'
import { definePlatformSurface } from '../surface/define-platform-surface.js'
import { SurfaceError, type SurfaceContext } from '../surface/types.js'

// ─── 源枚举与检测 / 扫描结果（与 @tabtin/agent-import 同构，本层不硬依赖该包）──

export type ImportSourceId = 'claude_code' | 'codex' | 'cursor' | 'workbuddy'

export const IMPORT_SOURCE_IDS: readonly ImportSourceId[] = [
  'claude_code',
  'codex',
  'cursor',
  'workbuddy',
]

/** Cursor 三级正文可得性；其余源恒为 'full'。 */
export type ImportContentLayer = 'full' | 'bubble' | 'jsonl' | 'header_only'

/** detect：banner 场景亚秒级只读索引计数（与 agent-import DetectResult 同构）。 */
export interface ImportDetectResult {
  source: ImportSourceId
  installed: boolean
  sessionCount: number
  workspaceCount: number
  newestActivityAt: string | null
  oldestActivityAt: string | null
  note?: string
}

/** scan / run 选择粒度：单会话引用（与 agent-import SessionRef 同构，可直接跨 IPC 传给 run）。 */
export interface ImportSessionRef {
  source: ImportSourceId
  sourceSessionId: string
  sourcePath: string
  title: string
  titleSource?: 'native' | 'custom' | 'derived'
  cwd: string | null
  createdAt: string
  updatedAt: string
  archived: boolean
  subagent: boolean
  layer: ImportContentLayer
}

export interface ImportScanWorkspace {
  cwd: string
  cwdExists: boolean
  sessions: ImportSessionRef[]
}

/** scan：workspace × 会话清单（与 agent-import ScanResult 同构）。 */
export interface ImportScanResult {
  source: ImportSourceId
  workspaces: ImportScanWorkspace[]
  /** cwd 为空/异常的会话（归默认 Workspace）。 */
  orphanSessions: ImportSessionRef[]
}

// ─── verb I/O 类型（spec §2.1 表）───────────────────────────────────────

export interface ImportDetectOutput {
  sources: ImportDetectResult[]
}

export interface ImportScanInput {
  source: ImportSourceId
  /** ISO8601；只要 updatedAt 晚于该时刻的会话（默认由上层传 近30天）。 */
  since?: string
  /** 是否包含源侧已归档会话（默认 true）。 */
  includeArchived?: boolean
}

/** run 输入（契约不变量 §5：jobId + 分源 sessionRefs + options）。 */
export interface ImportRunInput {
  jobId: string
  /**
   * 分源会话清单。`sessionRefs` 可选：
   * - UI 场景：先 scan 展示、用户勾选，传显式 sessionRefs（精确导入所选）。
   * - CLI 便捷场景：`tabtin import run --source codex --since 30d` 不逐条列
   *   sessionRefs，缺省时 runner 内部按 (source, options.since) 自动 scan 全部再导。
   */
  sources: Array<{ source: ImportSourceId; sessionRefs?: ImportSessionRef[] }>
  options: {
    since?: string
    /** secret 打码（默认 true，透传 parseSession）。 */
    redact?: boolean
    /** 目标组织（默认个人组织，确认页可切换）。 */
    targetOrganizationId: string
    /** 组织默认 Agent（小Tin）。 */
    agentId: string
    /** 当前 Electron 设备。 */
    deviceId: string
  }
}

/** run 异步：立即返回 jobId，进度走 IPC event `import:progress`。 */
export interface ImportRunOutput {
  jobId: string
}

export type ImportJobState = 'running' | 'completed' | 'cancelled' | 'error'

/** 结果分类对账（契约不变量 §5.7：解析 = 可见 + 归档 + 仅标题 + 跳过 + 失败）。 */
export interface ImportRunReport {
  /** 可见（未归档且有正文）落库会话数。 */
  visible: number
  /** 源侧已归档、落 TabTin archived 态的会话数。 */
  archived: number
  /** header_only / 无正文、仅落标题 + 一条占位说明消息的会话数。 */
  titleOnly: number
  /** 幂等命中已导入（ensure-session created=false）跳过的会话数。 */
  skipped: number
  /** 解析 / 落库失败的会话数（不中断整批）。 */
  failed: number
  /** 子会话落库数（子会话另计，不进上面五类的整批对账分母）。 */
  subagentSessions: number
  /** 失败明细（source + sourceSessionId + 错误摘要）。 */
  failures: Array<{ source: ImportSourceId; sourceSessionId: string; error: string }>
}

export interface ImportStatusInput {
  jobId: string
}

export interface ImportStatusOutput {
  state: ImportJobState
  progress: { done: number; total: number }
  report?: ImportRunReport
}

export interface ImportCancelInput {
  jobId: string
}

export interface ImportCancelOutput {
  cancelled: boolean
}

/** rollback 维度三选一：jobId / source / sessionIds（spec §1.5 / §2.1）。 */
export interface ImportRollbackInput {
  jobId?: string
  source?: ImportSourceId
  sessionIds?: string[]
  /** 目标组织（CLI --source 维度撤销时显式指定；缺省回退当前 CLI 组织）。 */
  organization?: string
}

export interface ImportRollbackOutput {
  deletedSessions: number
  deletedMessages: number
}

/** IPC event `import:progress` 载荷（契约不变量 §5）。 */
export interface ImportProgressEvent {
  jobId: string
  /** 当前处理会话所属 workspace 标识（cwd / basename / '默认 Workspace'）。 */
  workspace: string
  done: number
  total: number
  /** parsing / importing / done / error 等阶段标记。 */
  phase: string
}

/** `import:progress` IPC channel 名（renderer 订阅、runner 推送双方对齐）。 */
export const IMPORT_PROGRESS_CHANNEL = 'import:progress'

// ─── 宿主注入接口 ───────────────────────────────────────────────────────

/**
 * 导入运行能力——由 Electron 主进程实现并在启动时通过 `createImportSurfaces`
 * 注入。需要 Django 代理的 verb（run / rollback）额外收 `SurfaceContext`，从
 * `ctx.djangoRequest` 打两段式导入 API（与 chat-export-md 同款）。
 *
 * detect / scan 直接调 agent-import（轻，主进程内同步跑）；run 触发后台编排
 * （P0 主进程内直接跑，worker 化留 follow-up），立即返回 jobId。
 */
export interface AgentImportRunner {
  detect(): Promise<ImportDetectOutput>
  scan(input: ImportScanInput): Promise<ImportScanResult>
  run(input: ImportRunInput, ctx: SurfaceContext): Promise<ImportRunOutput>
  status(input: ImportStatusInput): Promise<ImportStatusOutput>
  cancel(input: ImportCancelInput): Promise<ImportCancelOutput>
  rollback(input: ImportRollbackInput, ctx: SurfaceContext): Promise<ImportRollbackOutput>
}

// ─── 工厂 ───────────────────────────────────────────────────────────────

function _requireSource(source: unknown): ImportSourceId {
  if (typeof source !== 'string' || !IMPORT_SOURCE_IDS.includes(source as ImportSourceId)) {
    throw new SurfaceError(
      'VALIDATION_ERROR',
      `source 必须是 ${IMPORT_SOURCE_IDS.join(' / ')} 之一，收到: ${String(source)}`,
    )
  }
  return source as ImportSourceId
}

/** 组织 id：单层安全键，禁止 ../ 与路径分隔符（与 archive-store 对齐）。 */
const SAFE_ORG_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

function _requireOrganizationId(organizationId: unknown, field: string): string {
  if (typeof organizationId !== 'string' || !SAFE_ORG_ID_RE.test(organizationId)) {
    throw new SurfaceError(
      'VALIDATION_ERROR',
      `${field} 须为单层安全键（字母数字/._-），禁止路径段；收到: ${String(organizationId)}`,
    )
  }
  return organizationId
}

/**
 * sessionRefs 只作「选择清单」：校验 sourceSessionId + source 一致性。
 * sourcePath 可出现在载荷里（UI 回传），但 runner 会丢弃并按主进程 scan 重解析。
 */
function _validateSessionRefs(
  groupSource: ImportSourceId,
  sessionRefs: unknown,
): void {
  if (sessionRefs === undefined) return
  if (!Array.isArray(sessionRefs)) {
    throw new SurfaceError('VALIDATION_ERROR', `source ${groupSource} 的 sessionRefs 必须是数组`)
  }
  for (const raw of sessionRefs) {
    const ref = raw as { source?: unknown; sourceSessionId?: unknown; sourcePath?: unknown }
    if (!ref || typeof ref !== 'object') {
      throw new SurfaceError('VALIDATION_ERROR', `source ${groupSource} 的 sessionRefs 含非法项`)
    }
    if (typeof ref.sourceSessionId !== 'string' || !ref.sourceSessionId.trim()) {
      throw new SurfaceError(
        'VALIDATION_ERROR',
        `source ${groupSource} 的 sessionRefs[].sourceSessionId 必填`,
      )
    }
    if (ref.source !== undefined && ref.source !== groupSource) {
      throw new SurfaceError(
        'VALIDATION_ERROR',
        `sessionRef.source (${String(ref.source)}) 必须等于分组 source (${groupSource})`,
      )
    }
  }
}

/**
 * CLI 扁平 run 输入（声明式 flag 无法表达嵌套 sources/options）。
 * handler 会 `_normalizeRunInput` 归一到结构化 `ImportRunInput`。
 */
export interface ImportRunFlatInput {
  source: ImportSourceId
  since?: string
  redact?: boolean
  organization: string
  agent: string
  device: string
  jobId?: string
}

/** @internal 导出仅供单测；非公共 API。 */
export function _isFlatRunInput(input: unknown): input is ImportRunFlatInput {
  return (
    !!input &&
    typeof input === 'object' &&
    'source' in input &&
    typeof (input as { source: unknown }).source === 'string' &&
    !Array.isArray((input as { sources?: unknown }).sources)
  )
}

/**
 * CLI 别名归一：CLI 走 HTTP 发 snake_case body（`kebabToSnake`），UI 走 IPC 发
 * camelCase 对象——PlatformSurface HTTP handler 不做 snake→camel（create-surface-
 * http-handler.ts 直接 handler(parseBody)），故在此把 CLI flag 别名补成 camelCase。
 * 只处理与 camelCase 不同形的顶层 key（单词 flag 如 source/since snake=camel，无需处理）。
 */
/** @internal 导出仅供单测；非公共 API。 */
export function _cliAlias<T>(input: unknown): T {
  if (!input || typeof input !== 'object') return input as T
  const o = { ...(input as Record<string, unknown>) }
  if (o.job !== undefined && o.jobId === undefined) o.jobId = o.job
  if (o.include_archived !== undefined && o.includeArchived === undefined) {
    o.includeArchived = o.include_archived
  }
  if (o.session_ids !== undefined && o.sessionIds === undefined) o.sessionIds = o.session_ids
  return o as T
}

/** 扁平 CLI 输入 → 结构化 ImportRunInput（jobId 缺省生成；UI 结构化输入原样返回）。 */
/** @internal 导出仅供单测；非公共 API。 */
export function _normalizeRunInput(input: ImportRunInput | ImportRunFlatInput): ImportRunInput {
  if (!_isFlatRunInput(input)) return input as ImportRunInput
  const flat = input
  return {
    jobId: flat.jobId || randomUUID(),
    sources: [{ source: flat.source }], // sessionRefs 缺省 → runner 自动 scan
    options: {
      ...(flat.since ? { since: flat.since } : {}),
      ...(typeof flat.redact === 'boolean' ? { redact: flat.redact } : {}),
      targetOrganizationId: flat.organization,
      agentId: flat.agent,
      deviceId: flat.device,
    },
  }
}

/**
 * since 宽松解析——CLI（`--since 30d`）与 UI（直接算 ISO）的公共入口统一在此。
 * `Nd`（相对天数）→ ISO；`all` / 空 → undefined（全量）；其余按已是 ISO 原样透传。
 * runner 侧 opts.since 期望可 `new Date()` 的值，故这里收口把相对格式转成 ISO。
 */
/** @internal 导出仅供单测；非公共 API。 */
export function _resolveSince(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw === 'all') return undefined
  const rel = /^(\d+)d$/.exec(raw.trim())
  if (rel) return new Date(Date.now() - Number(rel[1]) * 86_400_000).toISOString()
  return raw
}

/**
 * 创建 import 模块的 6 个 PlatformSurface（detect/scan/run/status/cancel/rollback）。
 *
 * 调用时机：Electron 主进程 IPC 装配阶段（ipc-registry.ts），注入宿主 runner。
 * 内部 `definePlatformSurface` 自动注册到全局 registry，同一进程内 IPC + CLI HTTP
 * 双 binding 共享该注册。
 */
export function createImportSurfaces(runner: AgentImportRunner) {
  const importDetect = definePlatformSurface({
    module: 'import',
    verb: 'detect',
    kind: 'local',
    errorCodes: ['IMPORT_FAILED'] as const,
    bindings: { ipc: true, http: true },
    handler: async (): Promise<ImportDetectOutput> => {
      return runner.detect()
    },
  })

  const importScan = definePlatformSurface({
    module: 'import',
    verb: 'scan',
    kind: 'local',
    errorCodes: ['VALIDATION_ERROR', 'IMPORT_FAILED'] as const,
    bindings: { ipc: true, http: true },
    handler: async (rawInput: ImportScanInput): Promise<ImportScanResult> => {
      const input = _cliAlias<ImportScanInput>(rawInput)
      const source = _requireSource(input?.source)
      const since = _resolveSince(input?.since)
      return runner.scan({
        source,
        ...(since ? { since } : {}),
        ...(typeof input?.includeArchived === 'boolean'
          ? { includeArchived: input.includeArchived }
          : {}),
      })
    },
  })

  const importRun = definePlatformSurface({
    module: 'import',
    verb: 'run',
    kind: 'local',
    risk: 'write', // 落库 + 写本地 transcript（可 rollback）
    errorCodes: ['VALIDATION_ERROR', 'IMPORT_FAILED'] as const,
    bindings: { ipc: true, http: true },
    handler: async (rawInput: ImportRunInput | ImportRunFlatInput, ctx: SurfaceContext): Promise<ImportRunOutput> => {
      // CLI 声明式只能传扁平 flag（无法表达嵌套 sources/options）——归一到结构化。
      // UI 传结构化 input.sources，直接用；CLI 传扁平 input.source，在此组装。
      const input = _normalizeRunInput(rawInput)
      if (!input?.jobId || typeof input.jobId !== 'string') {
        throw new SurfaceError('VALIDATION_ERROR', 'jobId 是必填参数')
      }
      if (!Array.isArray(input.sources) || input.sources.length === 0) {
        throw new SurfaceError('VALIDATION_ERROR', 'sources 至少需要一项')
      }
      const opts = input.options
      if (!opts?.targetOrganizationId || !opts?.agentId || !opts?.deviceId) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'options.targetOrganizationId / agentId / deviceId 均为必填'
            + '（CLI: --organization / --agent / --device）',
        )
      }
      _requireOrganizationId(opts.targetOrganizationId, 'options.targetOrganizationId')
      for (const s of input.sources) {
        const source = _requireSource(s?.source)
        _validateSessionRefs(source, s?.sessionRefs)
      }
      // since 收口：CLI 的 --since 30d → ISO；options.since 传给 runner 供自动 scan 用
      const runInput: ImportRunInput = {
        ...input,
        options: { ...input.options, since: _resolveSince(input.options.since) },
      }
      return runner.run(runInput, ctx)
    },
  })

  const importStatus = definePlatformSurface({
    module: 'import',
    verb: 'status',
    kind: 'local',
    errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },
    handler: async (rawInput: ImportStatusInput): Promise<ImportStatusOutput> => {
      const input = _cliAlias<ImportStatusInput>(rawInput)
      if (!input?.jobId) {
        throw new SurfaceError('VALIDATION_ERROR', 'jobId 是必填参数')
      }
      return runner.status(input)
    },
  })

  const importCancel = definePlatformSurface({
    module: 'import',
    verb: 'cancel',
    kind: 'local',
    risk: 'write',
    errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] as const,
    bindings: { ipc: true, http: true },
    handler: async (rawInput: ImportCancelInput): Promise<ImportCancelOutput> => {
      const input = _cliAlias<ImportCancelInput>(rawInput)
      if (!input?.jobId) {
        throw new SurfaceError('VALIDATION_ERROR', 'jobId 是必填参数')
      }
      return runner.cancel(input)
    },
  })

  const importRollback = definePlatformSurface({
    module: 'import',
    verb: 'rollback',
    kind: 'local',
    risk: 'high-risk-write', // 删除已导入会话 + 级联消息 + 本地 transcript，不可逆
    errorCodes: ['VALIDATION_ERROR', 'IMPORT_FAILED'] as const,
    bindings: { ipc: true, http: true },
    handler: async (rawInput: ImportRollbackInput, ctx: SurfaceContext): Promise<ImportRollbackOutput> => {
      const input = _cliAlias<ImportRollbackInput>(rawInput)
      if (!input?.jobId && !input?.source && !(Array.isArray(input?.sessionIds) && input.sessionIds.length)) {
        throw new SurfaceError(
          'VALIDATION_ERROR',
          'rollback 需要 jobId / source / sessionIds 三选一',
        )
      }
      if (input?.source) _requireSource(input.source)
      if (input?.organization !== undefined) {
        _requireOrganizationId(input.organization, 'organization')
      }
      return runner.rollback(input, ctx)
    },
  })

  return { importDetect, importScan, importRun, importStatus, importCancel, importRollback }
}

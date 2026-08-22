/**
 * WorkBuddy 数据源 adapter（~/.workbuddy）。
 *
 * 权威事实见 docs/prd/external-agent-import-research/workbuddy-data.md。
 * 两层数据：
 * - workbuddy.db 的 sessions 表 = 会话主索引（detect/scan；WAL，copySnapshot）。
 * - projects/<cwd转义名>/<sessionId>.jsonl = 对话正文（parseSession 流式）。
 *
 * 翻译要点（底稿 §2.2 / §4）：
 * - user 消息 97% 被 <system-reminder> 包裹，真实输入须用 <user_query>…</user_query>
 *   提取；无包裹时回退全文（子 Agent 转录即无包裹）。
 * - reasoning 的思考文本在 rawContent[].text（content 常为空数组）。
 * - function_call/function_call_result 按 callId 配对；结果里 blob_path 引用
 *   blobs/ 内容寻址图片 → image_ref。
 * - 主转录 function_call name="Agent" → 结果末尾 [Agent ID: agent-xxxx] 关联
 *   <sessionId>/subagents/agent-xxxx.jsonl（同格式）→ UnifiedSubagent。
 * - status:"incomplete" 的消息 → stopReason='aborted'。
 * - tool_result 合并进持有该 tool_use 的 assistant 消息（TabTin 协议）。
 */

import * as path from 'node:path'
import type { ImportIO, SqliteQueryOptions } from '../io.js'
import type {
  DetectResult,
  ParseOptions,
  ScanOptions,
  ScanResult,
  ScanWorkspace,
  SessionRef,
  SourceAdapter,
  UnifiedMessage,
  UnifiedSession,
  UnifiedSubagent,
  UnifiedUsage,
} from '../types.js'
import { resolveSourcePaths } from '../paths.js'
import { contentHashId, normalizeMessages } from '../normalize.js'
import { newRedactStats } from '../redact.js'

type Draft = UnifiedMessage & { _sourceId?: string | null }

/**
 * workbuddy.db 读取选项。
 * - copySnapshot：运行中客户端持锁时先拷三件套；有 sidecar 时 mode=ro 可读 WAL 帧。
 * - 无 sidecar 时 io 层回退 immutable=1（避免 error 14）；不必在此强制 immutable，
 *   否则成功拷到 WAL 时会丢掉未 checkpoint 的会话索引。
 */
const WB_DB_OPTS: SqliteQueryOptions = { copySnapshot: true }

const WB_COUNT_SQL = `
SELECT COUNT(*) AS n,
       COUNT(DISTINCT cwd) AS ws,
       MIN(COALESCE(updated_at, last_activity_at, created_at)) AS oldest,
       MAX(COALESCE(updated_at, last_activity_at, created_at)) AS newest
FROM sessions
WHERE deleted_at IS NULL
`.trim()

const WB_SCAN_SQL = `
SELECT id, cwd, title, custom_title, created_at, updated_at, last_activity_at
FROM sessions
WHERE deleted_at IS NULL
ORDER BY COALESCE(updated_at, last_activity_at, created_at) DESC
`.trim()

const USER_QUERY_PATTERN = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi
const AGENT_ID_PATTERN = /\[Agent ID:\s*(agent-[A-Za-z0-9_-]+)\]/i

function isoFromMillis(ms: unknown): string {
  const n = Number(ms)
  if (!Number.isFinite(n)) return new Date(0).toISOString()
  return new Date(n).toISOString()
}

/** cwd → projects 目录转义名：去前导 /，其余 / 换成 -（底稿 §2.2） */
function escapeCwd(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/\//g, '-')
}

function parseMaybe(value: unknown): unknown {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** content[]（input_text/output_text）→ 纯文本 */
function extractContentText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return ''
        if (typeof b === 'string') return b
        const o = b as Record<string, unknown>
        if (typeof o.text === 'string') return o.text
        if (typeof o.input_text === 'string') return o.input_text
        if (typeof o.output_text === 'string') return o.output_text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string') {
    return (content as Record<string, unknown>).text as string
  }
  return ''
}

/** 思考文本优先 rawContent[].text，content 常为空数组（底稿 §4.4） */
function extractReasoningText(v: any): string {
  const raw = Array.isArray(v.rawContent) && v.rawContent.length ? v.rawContent : v.content
  return extractContentText(raw)
}

/** <user_query>…</user_query> 提取真实输入；无包裹回退全文 */
function extractUserQuery(text: string): string {
  const parts: string[] = []
  let m: RegExpExecArray | null
  USER_QUERY_PATTERN.lastIndex = 0
  while ((m = USER_QUERY_PATTERN.exec(text))) parts.push(m[1].trim())
  return parts.length ? parts.join('\n\n') : text.trim()
}

interface BlobRef {
  path: string
  mime?: string
  size?: number
}

/** 工具输出 → 可读文本 + 引用的 blob 图片（{mime,size,blob_path}） */
function extractToolOutput(output: unknown): { text: string; blobs: BlobRef[] } {
  const texts: string[] = []
  const blobs: BlobRef[] = []
  const visit = (v: unknown): void => {
    if (v == null) return
    if (typeof v === 'string') {
      texts.push(v)
      return
    }
    if (Array.isArray(v)) {
      v.forEach(visit)
      return
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.blob_path === 'string') {
        blobs.push({
          path: o.blob_path,
          mime: typeof o.mime === 'string' ? o.mime : undefined,
          size: Number.isFinite(Number(o.size)) ? Number(o.size) : undefined,
        })
        return
      }
      if (typeof o.text === 'string') {
        texts.push(o.text)
        return
      }
      if (typeof o.output === 'string') {
        texts.push(o.output)
        return
      }
      let recursed = false
      for (const val of Object.values(o)) {
        if (val && typeof val === 'object') {
          visit(val)
          recursed = true
        }
      }
      if (!recursed) texts.push(safeJson(o))
    }
  }
  visit(output)
  return { text: texts.filter(Boolean).join('\n'), blobs }
}

/** providerData.rawUsage → UnifiedUsage */
function mapWbUsage(providerData: any): UnifiedUsage | null {
  const raw = providerData?.rawUsage
  if (!raw) return null
  const usage: UnifiedUsage = {}
  if (Number.isFinite(Number(raw.prompt_tokens))) usage.input_tokens = Number(raw.prompt_tokens)
  if (Number.isFinite(Number(raw.completion_tokens))) {
    usage.output_tokens = Number(raw.completion_tokens)
  }
  if (Number.isFinite(Number(raw.prompt_cache_hit_tokens))) {
    usage.cache_read_input_tokens = Number(raw.prompt_cache_hit_tokens)
  }
  return Object.keys(usage).length ? usage : null
}

interface Dispatch {
  callId: string
  description: string | null
  model: string | null
  agentId: string | null
}

interface TranscriptResult {
  messages: Draft[]
  unknownRecords: Record<string, number>
  dispatches: Dispatch[]
  aiTitle: string | null
  realModel: string | null
}

/**
 * 解析一份 WorkBuddy 转录（主会话或子 Agent 同格式）。
 * 按 providerData.messageId 划分模型调用边界 → 每次调用一条 assistant 消息；
 * tool_result 合并进持有对应 tool_use 的消息。
 */
async function parseTranscript(
  io: ImportIO,
  filePath: string,
  sessionId: string,
  opts: ParseOptions | undefined,
): Promise<TranscriptResult> {
  const messages: Draft[] = []
  const unknownRecords: Record<string, number> = {}
  const dispatches: Dispatch[] = []
  const callIdToMsg = new Map<string, Draft>()
  const bump = (k: string) => {
    unknownRecords[k] = (unknownRecords[k] ?? 0) + 1
  }

  let aiTitle: string | null = null
  let realModel: string | null = null
  let current: Draft | null = null
  let currentModelCallId: string | null = null
  let seq = 0

  const finalize = (m: Draft) => {
    if (!m.id) {
      const text = m.blocks
        .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
        .join('\n')
      m.id = m._sourceId || contentHashId(sessionId, m.role, seq++, text)
    }
    delete m._sourceId
  }
  const flush = () => {
    if (!current) return
    finalize(current)
    messages.push(current)
    current = null
    currentModelCallId = null
  }
  const ensureAssistant = (ts: unknown, mid: string | null, sourceId?: unknown): Draft => {
    if (current && mid && currentModelCallId && mid !== currentModelCallId) flush()
    if (!current) {
      current = { id: '', role: 'assistant', blocks: [], createdAt: isoFromMillis(ts) }
      currentModelCallId = mid ?? null
      if (realModel) current.model = realModel
    } else if (mid && !currentModelCallId) {
      currentModelCallId = mid
    }
    if (sourceId && !current._sourceId) current._sourceId = String(sourceId)
    return current
  }

  for await (const line of io.readJsonlLines(filePath)) {
    if (!line.trim()) continue
    let v: any
    try {
      v = JSON.parse(line)
    } catch {
      bump('_parse_error')
      continue
    }
    try {
      const type = v.type
      const pd = v.providerData ?? {}
      const mid: string | null = pd.messageId ? String(pd.messageId) : null
      const model = pd.model
      if (model && String(model).toLowerCase() !== 'auto') realModel = String(model)
      const ts = v.timestamp

      if (type === 'ai-title') {
        aiTitle = v.aiTitle ?? aiTitle
        continue
      }
      if (type === 'file-history-snapshot') continue // checkpoint 关联，忽略

      if (type === 'message' && v.role === 'user') {
        flush()
        const real = extractUserQuery(extractContentText(v.content))
        const um: Draft = {
          id: '',
          role: 'user',
          blocks: [{ type: 'text', text: real }],
          createdAt: isoFromMillis(ts),
          _sourceId: v.id ? String(v.id) : null,
        }
        if (v.status === 'incomplete') um.stopReason = 'aborted'
        finalize(um)
        messages.push(um)
        continue
      }

      if (type === 'message' && v.role === 'assistant') {
        const text = extractContentText(v.content)
        const a = ensureAssistant(ts, mid, v.id)
        if (text.trim()) a.blocks.push({ type: 'text', text })
        if (v.status === 'incomplete') a.stopReason = 'aborted'
        const usage = mapWbUsage(pd)
        if (usage) a.usage = usage
        continue
      }

      if (type === 'reasoning') {
        const text = extractReasoningText(v)
        if (!text.trim()) continue
        ensureAssistant(ts, mid).blocks.push({ type: 'thinking', thinking: text })
        continue
      }

      if (type === 'function_call') {
        const callId = String(v.callId ?? v.id ?? `call-${seq}-${messages.length}`)
        const name = String(v.name ?? 'tool')
        const input = parseMaybe(v.arguments) ?? v.arguments ?? {}
        const a = ensureAssistant(ts, mid)
        a.blocks.push({ type: 'tool_use', id: callId, name, input })
        callIdToMsg.set(callId, a)
        if (name === 'Agent') {
          const args = (parseMaybe(v.arguments) ?? {}) as Record<string, unknown>
          dispatches.push({
            callId,
            description: String(args.description ?? '').trim() || null,
            model: args.model != null ? String(args.model) : null,
            agentId: null,
          })
        }
        continue
      }

      if (type === 'function_call_result') {
        const callId = String(v.callId ?? v.id ?? '')
        const { text, blobs } = extractToolOutput(v.output)
        const holder = callIdToMsg.get(callId) ?? ensureAssistant(ts, mid)
        const isError =
          typeof v.status === 'string' && v.status !== 'completed' && v.status !== 'success'
        holder.blocks.push({
          type: 'tool_result',
          tool_use_id: callId,
          content: text,
          ...(isError ? { is_error: true } : {}),
        })
        for (const b of blobs) {
          if (!(await io.exists(b.path))) continue
          // blobs/ 是内容寻址的既存文件；attachmentDir 给定时抽入其中保产物自包含
          // （不依赖源目录持久存在），否则降级为路径引用。
          let refPath = b.path
          if (opts?.attachmentDir !== undefined) {
            try {
              const data = await io.readBinaryFile(b.path)
              refPath = await io.writeAttachment(path.basename(b.path), data)
            } catch {
              refPath = b.path
            }
          }
          holder.blocks.push({
            type: 'image_ref',
            path: refPath,
            mimeType: b.mime ?? 'image/webp',
            ...(b.size != null ? { byteSize: b.size } : {}),
          })
        }
        if (v.name === 'Agent') {
          const agentId = AGENT_ID_PATTERN.exec(text)?.[1] ?? null
          const d =
            dispatches.find((x) => x.callId === callId && !x.agentId) ??
            dispatches.find((x) => !x.agentId)
          if (d && agentId) d.agentId = agentId
        }
        continue
      }

      bump(`type:${type ?? 'unknown'}`)
    } catch {
      bump('_handler_error')
    }
  }
  flush()
  return { messages, unknownRecords, dispatches, aiTitle, realModel }
}

async function findTranscript(
  io: ImportIO,
  projectsDir: string,
  sessionId: string,
): Promise<string | null> {
  const entries = await io.readdir(projectsDir)
  for (const name of entries) {
    const candidate = path.join(projectsDir, name, `${sessionId}.jsonl`)
    if (await io.exists(candidate)) return candidate
  }
  return null
}

export const workbuddyAdapter: SourceAdapter = {
  source: 'workbuddy',

  async detect(io: ImportIO): Promise<DetectResult> {
    const paths = resolveSourcePaths(io, 'workbuddy')
    const base: DetectResult = {
      source: 'workbuddy',
      installed: false,
      sessionCount: 0,
      workspaceCount: 0,
      newestActivityAt: null,
      oldestActivityAt: null,
    }
    const dirStat = await io.stat(paths.roots[0])
    if (!dirStat || !dirStat.isDirectory) return { ...base, note: '~/.workbuddy 目录不存在' }
    const dbStat = await io.stat(paths.extras.db)
    if (!dbStat) return { ...base, note: 'workbuddy.db 不存在' }
    let rows: Record<string, unknown>[]
    try {
      rows = await io.querySqlite(paths.extras.db, WB_COUNT_SQL, WB_DB_OPTS)
    } catch (e) {
      return { ...base, note: `workbuddy.db 读取失败：${(e as Error).message}` }
    }
    const r = rows[0] ?? {}
    const n = Number(r.n) || 0
    // 目录 + DB 在但 sessions 为空：不算 installed（向导只列可导入源），但带 note
    // 方便 UI 灰显「装了却没历史」，避免用户以为探测坏了。
    return {
      source: 'workbuddy',
      installed: n > 0,
      sessionCount: n,
      workspaceCount: Number(r.ws) || 0,
      newestActivityAt: r.newest != null ? isoFromMillis(r.newest) : null,
      oldestActivityAt: r.oldest != null ? isoFromMillis(r.oldest) : null,
      ...(n === 0
        ? {
            note: '已安装 WorkBuddy，但本机尚无可导入的历史对话（sessions 索引为空）',
          }
        : {}),
    }
  },

  async scan(io: ImportIO, opts?: ScanOptions): Promise<ScanResult> {
    const paths = resolveSourcePaths(io, 'workbuddy')
    const projectsDir = paths.extras.projectsDir
    let rows: Record<string, unknown>[] = []
    try {
      rows = await io.querySqlite(paths.extras.db, WB_SCAN_SQL, WB_DB_OPTS)
    } catch {
      rows = []
    }
    // WorkBuddy 无归档态（deleted_at 已在 SQL 过滤），includeArchived 无适用会话
    const since = opts?.since ? opts.since.getTime() : null
    const byCwd = new Map<string, SessionRef[]>()
    const orphans: SessionRef[] = []

    for (const row of rows) {
      const updatedMs = Number(row.updated_at ?? row.last_activity_at ?? row.created_at)
      if (since != null && !(updatedMs > since)) continue
      const cwdRaw = row.cwd != null ? String(row.cwd) : ''
      const cwd = cwdRaw.trim() ? cwdRaw : null
      const customTitle = String(row.custom_title ?? '').trim()
      const title = customTitle || String(row.title ?? '').trim() || ''
      const id = String(row.id)
      const sourcePath = cwd ? path.join(projectsDir, escapeCwd(cwd), `${id}.jsonl`) : ''

      const ref: SessionRef = {
        source: 'workbuddy',
        sourceSessionId: id,
        sourcePath,
        title,
        titleSource: customTitle ? 'custom' : title ? 'native' : undefined,
        cwd,
        createdAt: isoFromMillis(row.created_at),
        updatedAt: isoFromMillis(row.updated_at ?? row.last_activity_at ?? row.created_at),
        archived: false,
        subagent: false,
        layer: 'full',
      }
      if (cwd) {
        const list = byCwd.get(cwd)
        if (list) list.push(ref)
        else byCwd.set(cwd, [ref])
      } else {
        orphans.push(ref)
      }
    }

    const workspaces: ScanWorkspace[] = []
    for (const [cwd, sessions] of byCwd) {
      workspaces.push({ cwd, cwdExists: await io.exists(cwd), sessions })
    }
    return { source: 'workbuddy', workspaces, orphanSessions: orphans }
  },

  async parseSession(
    io: ImportIO,
    ref: SessionRef,
    opts?: ParseOptions,
  ): Promise<UnifiedSession> {
    const paths = resolveSourcePaths(io, 'workbuddy')
    const projectsDir = paths.extras.projectsDir

    // sourcePath 由 scan 按 cwd 转义推导；若失配则回退在 projects 下浅扫定位
    let filePath = ref.sourcePath
    if (!filePath || !(await io.exists(filePath))) {
      const found = await findTranscript(io, projectsDir, ref.sourceSessionId)
      if (found) filePath = found
    }

    const main = await parseTranscript(io, filePath, ref.sourceSessionId, opts)

    // 子 Agent：主转录派发 + [Agent ID] 关联 <sessionId>/subagents/agent-*.jsonl
    const subagents: UnifiedSubagent[] = []
    const dir = filePath ? path.dirname(filePath) : projectsDir
    for (const d of main.dispatches) {
      if (!d.agentId) continue
      const subPath = path.join(dir, ref.sourceSessionId, 'subagents', `${d.agentId}.jsonl`)
      if (!(await io.exists(subPath))) continue
      const sub = await parseTranscript(io, subPath, d.agentId, opts)
      const subMessages = normalizeMessages(sub.messages, {
        source: 'workbuddy',
        redact: opts?.redact !== false,
        redactStats: newRedactStats(),
      })
      subagents.push({
        sourceId: d.agentId,
        ...(d.description ? { description: d.description } : {}),
        messages: subMessages,
      })
    }

    const normalized = normalizeMessages(main.messages, {
      source: 'workbuddy',
      redact: opts?.redact !== false,
      redactStats: newRedactStats(),
    })

    const title = ref.title || main.aiTitle || ''
    // titleSource：scan 已知（custom_title→custom / title→native）优先；否则按 jsonl ai-title 兜底
    const titleSource: UnifiedSession['titleSource'] = ref.title
      ? (ref.titleSource ?? 'native')
      : main.aiTitle
        ? 'native'
        : 'derived'

    return {
      source: 'workbuddy',
      sourceSessionId: ref.sourceSessionId,
      sourcePath: filePath,
      title,
      titleSource,
      cwd: ref.cwd,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      archived: ref.archived,
      layer: 'full',
      lossy: false,
      messages: normalized,
      subagents,
      model: main.realModel ?? undefined,
      unknownRecords: main.unknownRecords,
    }
  },
}

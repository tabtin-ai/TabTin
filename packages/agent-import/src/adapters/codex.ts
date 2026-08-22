/**
 * Codex 数据源 adapter（~/.codex）。
 *
 * 权威事实见 docs/prd/external-agent-import-research/codex-data.md。
 * 三层数据：
 * - state_5.sqlite 的 threads 表 = 会话主索引（detect/scan 都读它；被运行中
 *   Desktop 持锁，必须 copySnapshot）。
 * - sessions/…/rollout-*.jsonl = 对话正文（parseSession 流式逐行，单文件可达
 *   102MB，绝不整读）。
 *
 * 翻译要点（底稿 §2.2 / §3 / §4）：
 * - 对话主体在 response_item（message / reasoning / function_call(+output) /
 *   custom_tool_call(+output) / web_search_call）；event_msg 的
 *   agent_message/agent_reasoning/user_message 与 response_item 双重表达，
 *   response_item 为准，故 event_msg 侧不再产出正文（只取 patch_apply_end /
 *   token_count）。
 * - reasoning 只有 summary 非空才落 thinking（encrypted_content 不可解密，丢弃）。
 * - fork/resume 会把祖先链消息重复写进同一文件：response_item 消息按文本 hash
 *   去重、工具按 call_id 去重。
 * - tool_result 合并进持有 tool_use 的 assistant 消息（TabTin 协议，见
 *   normalize.ts 注释）。
 */

import * as path from 'node:path'
import type { ImportIO } from '../io.js'
import type {
  DetectResult,
  ParseOptions,
  ScanOptions,
  ScanResult,
  ScanWorkspace,
  SessionRef,
  SourceAdapter,
  UnifiedMessage,
  UnifiedUsage,
} from '../types.js'
import type { SqliteQueryOptions } from '../io.js'
import { resolveSourcePaths } from '../paths.js'
import { contentHashId, decodeBase64Image, normalizeMessages, textDedupKey } from '../normalize.js'
import { newRedactStats } from '../redact.js'

/** 内部草稿：比 UnifiedMessage 多带一个源生 id 暂存位，flush 时消解 */
type Draft = UnifiedMessage & { _sourceId?: string | null }

/**
 * state_5.sqlite 读取选项。
 * - copySnapshot：库被运行中 Desktop 持锁，先拷贝三件套到临时目录取稳定快照。
 * - immutable：该库是 WAL 模式，只读打开需创建 -shm 共享内存文件；而 io.ts 的
 *   sqlite3 CLI 恒带 -readonly，禁止任何写入 → `unable to open database file(14)`。
 *   immutable=1 让 SQLite 把文件当不可变只读快照、不建 -shm、不加锁，才打得开。
 */
const CODEX_DB_OPTS: SqliteQueryOptions = { copySnapshot: true, immutable: true }

/** detect 用聚合计数：排除子代理（thread_source=subagent 或 source 是 JSON blob） */
const MAIN_COUNT_SQL = `
SELECT COUNT(*) AS n,
       COUNT(DISTINCT cwd) AS ws,
       MIN(updated_at) AS oldest,
       MAX(updated_at) AS newest
FROM threads
WHERE COALESCE(thread_source, '') != 'subagent'
  AND substr(TRIM(COALESCE(source, '')), 1, 1) NOT IN ('{', '[')
`.trim()

/** scan 取全量列（含子代理，子代理另行标记） */
const SCAN_SQL = `
SELECT id, rollout_path, title, first_user_message, cwd,
       created_at, updated_at, archived, thread_source, source
FROM threads
ORDER BY updated_at DESC
`.trim()

function isoFromSeconds(sec: unknown): string {
  const n = Number(sec)
  if (!Number.isFinite(n)) return new Date(0).toISOString()
  return new Date(n * 1000).toISOString()
}

/** rollout 顶层 timestamp 已是 ISO8601；这里做一次规整兜底非法值 */
function isoFromTop(ts: unknown): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString()
  const parsed = ts != null ? new Date(String(ts)) : new Date(NaN)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
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

/** response_item.message.content / reasoning.summary → 纯文本 */
function extractContentText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b == null) return ''
        if (typeof b === 'string') return b
        if (typeof (b as Record<string, unknown>).text === 'string') {
          return (b as Record<string, unknown>).text as string
        }
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

/**
 * 工具输出可能是字符串或 [{type:input_text|input_image(base64 data URI)}]。
 * 抽出可读文本 + 内嵌图片 data URI 列表。
 */
function extractToolOutput(output: unknown): { text: string; images: string[] } {
  const texts: string[] = []
  const images: string[] = []
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
      const bt = String(o.type ?? '').toLowerCase()
      if (bt.includes('image')) {
        const uri =
          typeof o.image_url === 'string'
            ? o.image_url
            : typeof o.data === 'string'
              ? o.data
              : typeof o.text === 'string' && o.text.startsWith('data:')
                ? o.text
                : null
        if (uri) images.push(uri)
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
      texts.push(safeJson(o))
    }
  }
  visit(output)
  return { text: texts.filter(Boolean).join('\n'), images }
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  }
  return map[mime] ?? 'png'
}

/** Codex last_token_usage → UnifiedUsage */
function mapUsage(u: Record<string, unknown>): UnifiedUsage {
  const usage: UnifiedUsage = {}
  const set = (key: keyof UnifiedUsage, raw: unknown) => {
    const n = Number(raw)
    if (Number.isFinite(n)) usage[key] = n
  }
  set('input_tokens', u.input_tokens)
  set('output_tokens', u.output_tokens)
  set('cache_read_input_tokens', u.cached_input_tokens)
  set('cache_creation_input_tokens', u.cache_write_input_tokens)
  return usage
}

/** 老版本无 last_token_usage 时，用相邻 total 差值兜底 */

function diffUsage(
  total: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!prev) return total
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(total)) {
    out[k] = typeof v === 'number' ? Math.max(0, v - (Number(prev[k]) || 0)) : v
  }
  return out
}

function summarizeChanges(changes: unknown, success: unknown): string {
  const files = changes && typeof changes === 'object' ? Object.keys(changes as object) : []
  const head = success === false ? 'apply_patch 失败' : 'apply_patch 成功'
  return files.length ? `${head}：${files.join('、')}` : head
}

export const codexAdapter: SourceAdapter = {
  source: 'codex',

  async detect(io: ImportIO): Promise<DetectResult> {
    const paths = resolveSourcePaths(io, 'codex')
    const base: DetectResult = {
      source: 'codex',
      installed: false,
      sessionCount: 0,
      workspaceCount: 0,
      newestActivityAt: null,
      oldestActivityAt: null,
    }
    // 三级判定：目录 → 索引 → 计数
    const dirStat = await io.stat(paths.roots[0])
    if (!dirStat || !dirStat.isDirectory) return { ...base, note: '~/.codex 目录不存在' }
    const dbStat = await io.stat(paths.extras.stateDb)
    if (!dbStat) return { ...base, note: 'state_5.sqlite 不存在（可能是极早期版本）' }
    let rows: Record<string, unknown>[]
    try {
      rows = await io.querySqlite(paths.extras.stateDb, MAIN_COUNT_SQL, CODEX_DB_OPTS)
    } catch (e) {
      return { ...base, note: `state_5.sqlite 读取失败：${(e as Error).message}` }
    }
    const r = rows[0] ?? {}
    const n = Number(r.n) || 0
    return {
      source: 'codex',
      installed: n > 0,
      sessionCount: n,
      workspaceCount: Number(r.ws) || 0,
      newestActivityAt: r.newest != null ? isoFromSeconds(r.newest) : null,
      oldestActivityAt: r.oldest != null ? isoFromSeconds(r.oldest) : null,
    }
  },

  async scan(io: ImportIO, opts?: ScanOptions): Promise<ScanResult> {
    const paths = resolveSourcePaths(io, 'codex')
    let rows: Record<string, unknown>[] = []
    try {
      rows = await io.querySqlite(paths.extras.stateDb, SCAN_SQL, CODEX_DB_OPTS)
    } catch {
      rows = []
    }
    const since = opts?.since ? opts.since.getTime() : null
    const includeArchived = opts?.includeArchived !== false
    const byCwd = new Map<string, SessionRef[]>()
    const orphans: SessionRef[] = []

    for (const row of rows) {
      const archived = Number(row.archived) ? true : false
      if (archived && !includeArchived) continue
      const updatedMs = Number(row.updated_at) * 1000
      if (since != null && !(updatedMs > since)) continue

      const source = String(row.source ?? '')
      const threadSource = String(row.thread_source ?? '')
      const subagent = threadSource === 'subagent' || /^\s*[[{]/.test(source)
      const nativeTitle = String(row.title ?? '').trim()
      const title = nativeTitle || String(row.first_user_message ?? '').trim() || ''
      const rolloutPath = String(row.rollout_path ?? '').trim()
      // 无标题且无 rollout：空壳线程，导入只会产出 0 消息档案
      if (!title && !rolloutPath) continue
      const cwdRaw = row.cwd != null ? String(row.cwd) : ''
      const cwd = cwdRaw.trim() ? cwdRaw : null

      const ref: SessionRef = {
        source: 'codex',
        sourceSessionId: String(row.id),
        sourcePath: rolloutPath,
        title,
        // threads.title 是 AI 生成标题（native）；回退到 first_user_message 则 derived
        titleSource: nativeTitle ? 'native' : title ? 'derived' : undefined,
        cwd,
        createdAt: isoFromSeconds(row.created_at),
        updatedAt: isoFromSeconds(row.updated_at),
        archived,
        subagent,
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
    return { source: 'codex', workspaces, orphanSessions: orphans }
  },

  async parseSession(
    io: ImportIO,
    ref: SessionRef,
    opts?: ParseOptions,
  ): Promise<import('../types.js').UnifiedSession> {
    const messages: Draft[] = []
    const unknownRecords: Record<string, number> = {}
    const bump = (k: string) => {
      unknownRecords[k] = (unknownRecords[k] ?? 0) + 1
    }

    let currentModel: string | null = null
    let gitBranch: string | undefined
    let totalTokens: number | undefined
    let previousTotal: Record<string, unknown> | null = null

    let current: Draft | null = null
    let lastAssistant: Draft | null = null
    let seq = 0
    let synthCounter = 0
    const emittedText = new Set<string>() // fork 去重：role:hash
    const seenCallIds = new Set<string>() // 工具调用 fork 去重
    const emittedOutputCallIds = new Set<string>()

    const finalize = (m: Draft) => {
      if (!m.id) {
        const text = m.blocks
          .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
          .join('\n')
        m.id = m._sourceId || contentHashId(ref.sourceSessionId, m.role, seq++, text)
      }
      delete m._sourceId
    }
    const flush = () => {
      if (!current) return
      finalize(current)
      messages.push(current)
      current = null
    }
    const ensureAssistant = (ts: unknown, sourceId?: unknown): Draft => {
      if (!current) {
        current = { id: '', role: 'assistant', blocks: [], createdAt: isoFromTop(ts) }
        if (currentModel) current.model = currentModel
        if (sourceId) current._sourceId = String(sourceId)
        lastAssistant = current
      } else if (sourceId && !current._sourceId) {
        current._sourceId = String(sourceId)
      }
      return current
    }
    const pushUser = (text: string, ts: unknown, sourceId?: unknown) => {
      flush()
      const um: Draft = {
        id: '',
        role: 'user',
        blocks: [{ type: 'text', text }],
        createdAt: isoFromTop(ts),
        _sourceId: sourceId ? String(sourceId) : null,
      }
      finalize(um)
      messages.push(um)
    }

    const pushImages = async (holder: Draft, images: string[]) => {
      for (const uri of images) {
        if (opts?.attachmentDir) {
          const decoded = decodeBase64Image(uri)
          if (decoded) {
            const p = await io.writeAttachment(
              `codex-tool-image.${extFromMime(decoded.mimeType)}`,
              decoded.buffer,
            )
            holder.blocks.push({
              type: 'image_ref',
              path: p,
              mimeType: decoded.mimeType,
              byteSize: decoded.buffer.length,
            })
            continue
          }
        }
        holder.blocks.push({ type: 'text', text: '[图片内容已省略]' })
      }
    }

    const handleResponseItem = async (p: any, ts: unknown) => {
      const t = p.type
      if (t === 'message') {
        if (p.role === 'developer') return // developer 指令丢弃
        const text = extractContentText(p.content)
        if (!text.trim()) return
        const key = `${p.role}:${textDedupKey(text)}`
        if (emittedText.has(key)) return // fork 祖先重复
        emittedText.add(key)
        if (p.role === 'user') {
          pushUser(text, ts, p.id)
        } else {
          ensureAssistant(ts, p.id).blocks.push({ type: 'text', text })
        }
        return
      }
      if (t === 'reasoning') {
        const summary = extractContentText(p.summary)
        if (!summary.trim()) return // encrypted_content 不可恢复；空摘要跳过
        const key = `reasoning:${textDedupKey(summary)}`
        if (emittedText.has(key)) return
        emittedText.add(key)
        ensureAssistant(ts, p.id).blocks.push({ type: 'thinking', thinking: `[摘要] ${summary}` })
        return
      }
      if (t === 'function_call' || t === 'custom_tool_call') {
        const callId = p.call_id ?? p.id
        const idStr = callId != null ? String(callId) : ''
        if (idStr && seenCallIds.has(idStr)) return
        if (idStr) seenCallIds.add(idStr)
        const name = String(p.name ?? (t === 'custom_tool_call' ? 'custom_tool' : 'tool'))
        const input =
          t === 'custom_tool_call'
            ? (p.input ?? '')
            : (parseMaybe(p.arguments) ?? p.arguments ?? {})
        const id = idStr || `${name}-${synthCounter++}`
        ensureAssistant(ts, p.id).blocks.push({ type: 'tool_use', id, name, input })
        return
      }
      if (t === 'function_call_output' || t === 'custom_tool_call_output') {
        const callId = String(p.call_id ?? p.id ?? '')
        if (callId && emittedOutputCallIds.has(callId)) return
        if (callId) emittedOutputCallIds.add(callId)
        const { text, images } = extractToolOutput(p.output)
        const holder = ensureAssistant(ts)
        holder.blocks.push({ type: 'tool_result', tool_use_id: callId, content: text })
        if (images.length) await pushImages(holder, images)
        return
      }
      if (t === 'web_search_call') {
        const action = p.action ?? {}
        const id = String(p.id ?? `web_search-${synthCounter++}`)
        ensureAssistant(ts, p.id).blocks.push({
          type: 'tool_use',
          id,
          name: 'web_search',
          input: action,
        })
        return
      }
      bump(`response_item:${t ?? 'unknown'}`)
    }

    const handleEventMsg = (p: any, ts: unknown) => {
      const t = p.type
      if (t === 'patch_apply_end') {
        const holder = ensureAssistant(ts)
        const id = `apply_patch-${synthCounter++}`
        const changes = p.changes ?? {}
        holder.blocks.push({ type: 'tool_use', id, name: 'apply_patch', input: { changes } })
        holder.blocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: summarizeChanges(changes, p.success),
          ...(p.success === false ? { is_error: true } : {}),
        })
        return
      }
      if (t === 'token_count') {
        const info = p.info ?? {}
        const total: Record<string, unknown> | null = info.total_token_usage ?? null
        let last: Record<string, unknown> | null = info.last_token_usage ?? null
        if (!last && total) last = diffUsage(total, previousTotal)
        if (last && lastAssistant) lastAssistant.usage = mapUsage(last)
        if (total && Number.isFinite(Number(total.total_tokens))) {
          totalTokens = Number(total.total_tokens)
        }
        previousTotal = total ?? previousTotal
        return
      }
      // 与 response_item 双重表达，response_item 为准，正文不重复产出（也不计未知）
      if (t === 'user_message' || t === 'agent_message' || t === 'agent_reasoning') return
      // 其余 event_msg（task_started/complete、web_search_end、image_generation_end…）
      // 当前不导入正文，如实计入未知记录
      bump(`event_msg:${t ?? 'unknown'}`)
    }

    // 流式逐行；单条记录失败不中断整会话
    for await (const line of io.readJsonlLines(ref.sourcePath)) {
      if (!line.trim()) continue
      let rec: any
      try {
        rec = JSON.parse(line)
      } catch {
        bump('_parse_error')
        continue
      }
      try {
        const type = rec.type
        const p = rec.payload ?? {}
        const ts = rec.timestamp
        if (type === 'turn_context') {
          if (p.model) currentModel = String(p.model)
          continue
        }
        if (type === 'session_meta') {
          const branch = p.git?.branch ?? p.git?.branch_name
          if (branch && !gitBranch) gitBranch = String(branch)
          continue // 多条 session_meta（fork 祖先链）不产出正文，去重交给消息层
        }
        if (type === 'response_item') {
          await handleResponseItem(p, ts)
          continue
        }
        if (type === 'event_msg') {
          handleEventMsg(p, ts)
          continue
        }
        if (type === 'compacted' || type === 'world_state') continue // 已知运行时/压缩快照，跳过
        bump(`type:${type ?? 'unknown'}`)
      } catch {
        bump('_handler_error')
      }
    }
    flush()

    const normalized = normalizeMessages(messages, {
      source: 'codex',
      redact: opts?.redact !== false,
      redactStats: newRedactStats(),
    })

    return {
      source: 'codex',
      sourceSessionId: ref.sourceSessionId,
      sourcePath: ref.sourcePath,
      title: ref.title,
      titleSource: ref.titleSource ?? (ref.title ? 'native' : 'derived'),
      cwd: ref.cwd,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      archived: ref.archived,
      layer: 'full',
      lossy: false,
      messages: normalized,
      subagents: [], // Codex 子代理是 threads 表里的独立会话，scan 时标 subagent，不在此内联
      totalTokens,
      model: currentModel ?? undefined,
      gitBranch,
      unknownRecords,
    }
  },
}

/**
 * Cursor adapter——四家中数据最厚、层次最多的源。
 *
 * 数据事实以调研底稿为准：docs/prd/external-agent-import-research/cursor-data.md
 * - 主索引：state.vscdb `composerHeaders` 专用表（现行权威；ItemTable
 *   `composer.composerHeaders` 2026-07-09 止更，作兜底合并）
 * - 正文三级：气泡层 bubbleId KV（全保真，2026-05 起）> jsonl 转写
 *   （text+tool_use，6% assistant 文本被 [REDACTED]）> 仅头
 * - state.vscdb.backup：一次性救援源（无 wal，immutable=1 打开）
 * - 15.78GB 主库：readonly 直开原库，绝不 copySnapshot
 * - 子 Agent 头占 89%（task-*），按 subagentInfo 折叠，绝不平铺
 * - P0 不碰 agentKv 报文层与 CLI chats/ 库
 */

import type { ImportIO } from '../io.js'
import { resolveSourcePaths } from '../paths.js'
import {
  contentHashId,
  decodeBase64Image,
  interpolateTimestamps,
  normalizeMessages,
} from '../normalize.js'
import { newRedactStats } from '../redact.js'
import type {
  ContentLayer,
  DetectResult,
  ParseOptions,
  ScanOptions,
  ScanResult,
  ScanWorkspace,
  SessionRef,
  SourceAdapter,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../types.js'

// ── header 载入（专用表为主 + ItemTable 兜底）────────────────────────────

interface CursorHeader {
  composerId: string
  name: string | null
  createdAt: number
  lastUpdatedAt: number
  workspaceFolder: string | null
  isArchived: boolean
  isSubagent: boolean
  isDraft: boolean
  unifiedMode: string | null
  parentComposerId: string | null
}

function headerFromValue(value: Record<string, unknown>, tableRow?: Record<string, unknown>): CursorHeader | null {
  const composerId = typeof value.composerId === 'string' ? value.composerId : null
  if (!composerId) return null
  const wsIdent = value.workspaceIdentifier as Record<string, unknown> | undefined
  const uri = wsIdent?.uri as Record<string, unknown> | undefined
  const fsPath = typeof uri?.fsPath === 'string' ? uri.fsPath : null
  const subInfo = value.subagentInfo as Record<string, unknown> | undefined
  const createdAt =
    typeof value.createdAt === 'number' ? value.createdAt : Number(tableRow?.createdAt ?? 0)
  const lastUpdatedAt = Number(
    tableRow?.lastUpdatedAt ??
      value.lastUpdatedAt ??
      value.conversationCheckpointLastUpdatedAt ??
      createdAt,
  )
  return {
    composerId,
    name: typeof value.name === 'string' && value.name ? value.name : null,
    createdAt,
    lastUpdatedAt,
    workspaceFolder: fsPath,
    isArchived: value.isArchived === true || Number(tableRow?.isArchived ?? 0) === 1,
    isSubagent:
      composerId.startsWith('task-') || Number(tableRow?.isSubagent ?? 0) === 1 || !!subInfo,
    isDraft: value.isDraft === true,
    unifiedMode: typeof value.unifiedMode === 'string' ? value.unifiedMode : null,
    parentComposerId:
      typeof subInfo?.parentComposerId === 'string' ? subInfo.parentComposerId : null,
  }
}

async function loadHeaders(
  io: ImportIO,
  dbPath: string,
  opts: { mainOnly?: boolean } = {},
): Promise<Map<string, CursorHeader>> {
  const map = new Map<string, CursorHeader>()
  if (!(await io.exists(dbPath))) return map
  // 专用表（现行权威）。mainOnly 时 SQL 层就滤掉 89% 的子 Agent 行——15.78GB 库上
  // 只传 2,797 行而非 25,248 行，scan 从分钟级降到秒级（value blob 是传输大头）。
  const where = opts.mainOnly ? ' WHERE isSubagent=0' : ''
  try {
    const rows = await io.querySqlite(
      dbPath,
      `SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders${where};`,
    )
    for (const row of rows) {
      try {
        const value = JSON.parse(String(row.value ?? '{}')) as Record<string, unknown>
        const h = headerFromValue(value, row)
        if (h) map.set(h.composerId, h)
      } catch {
        /* 单行坏 JSON 跳过 */
      }
    }
  } catch {
    /* 老版本无专用表：完全走 ItemTable */
  }
  // ItemTable 兜底合并（只补专用表缺的 composerId；mainOnly 时跳过——它是全量 blob）
  if (opts.mainOnly) return map
  try {
    const rows = await io.querySqlite(
      dbPath,
      `SELECT value FROM ItemTable WHERE key='composer.composerHeaders';`,
    )
    const blob = rows[0]?.value
    if (typeof blob === 'string' && blob) {
      const parsed = JSON.parse(blob) as { allComposers?: Array<Record<string, unknown>> }
      for (const value of parsed.allComposers ?? []) {
        const h = headerFromValue(value)
        if (h && !map.has(h.composerId)) map.set(h.composerId, h)
      }
    }
  } catch {
    /* ItemTable 缺失可容忍 */
  }
  return map
}

/** parse 阶段单会话 header 查询（不整读 25k 行） */
async function loadSingleHeader(
  io: ImportIO,
  dbPath: string,
  composerId: string,
): Promise<CursorHeader | null> {
  if (!(await io.exists(dbPath))) return null
  const safe = composerId.replace(/'/g, "''")
  try {
    const rows = await io.querySqlite(
      dbPath,
      `SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders WHERE composerId='${safe}' LIMIT 1;`,
    )
    if (rows[0]) {
      const value = JSON.parse(String(rows[0].value ?? '{}')) as Record<string, unknown>
      return headerFromValue(value, rows[0])
    }
  } catch {
    /* 降级：调用方用 ref 兜底 */
  }
  return null
}

// ── 气泡层 ───────────────────────────────────────────────────────────────

interface BubbleRow {
  bubbleId: string
  type: number // 1=user 2=assistant
  text: string | null
  createdAt: string | null
  thinking: { text: string; signature?: string } | null
  toolFormerData: {
    name?: string
    tool?: number
    params?: string
    result?: string
    toolCallId?: string
    status?: string
  } | null
  modelName: string | null
  imageUuids: string[]
}

function parseBubble(key: string, raw: string): BubbleRow | null {
  let v: Record<string, unknown>
  try {
    v = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const bubbleId = key.split(':')[2] ?? ''
  const thinkingRaw = v.thinking as Record<string, unknown> | undefined
  const tfd = v.toolFormerData as Record<string, unknown> | undefined
  const modelInfo = v.modelInfo as Record<string, unknown> | undefined
  const images = Array.isArray(v.images)
    ? (v.images as Array<Record<string, unknown>>)
        .map((i) => (typeof i?.uuid === 'string' ? i.uuid : null))
        .filter((u): u is string => !!u)
    : []
  return {
    bubbleId,
    type: Number(v.type ?? 0),
    text: typeof v.text === 'string' && v.text ? v.text : null,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : null,
    thinking:
      thinkingRaw && typeof thinkingRaw.text === 'string' && thinkingRaw.text
        ? {
            text: thinkingRaw.text,
            ...(typeof thinkingRaw.signature === 'string' ? { signature: thinkingRaw.signature } : {}),
          }
        : null,
    toolFormerData: tfd
      ? {
          name: typeof tfd.name === 'string' ? tfd.name : undefined,
          tool: typeof tfd.tool === 'number' ? tfd.tool : undefined,
          params: typeof tfd.params === 'string' ? tfd.params : undefined,
          result: typeof tfd.result === 'string' ? tfd.result : undefined,
          toolCallId: typeof tfd.toolCallId === 'string' ? tfd.toolCallId : undefined,
          status: typeof tfd.status === 'string' ? tfd.status : undefined,
        }
      : null,
    modelName: typeof modelInfo?.modelName === 'string' ? modelInfo.modelName : null,
    imageUuids: images,
  }
}

/** 一次性 LIKE 拉全会话气泡（避免 N+1 次 sqlite CLI 进程）；返回 bubbleId → row */
async function loadBubbles(
  io: ImportIO,
  dbPath: string,
  composerId: string,
  immutable: boolean,
): Promise<Map<string, BubbleRow>> {
  const map = new Map<string, BubbleRow>()
  if (!(await io.exists(dbPath))) return map
  try {
    // 范围查询走主键索引：LIKE 默认大小写不敏感、不走索引，在 130 万行 KV 表
    // 上退化成全表扫描（实测 40s+/会话）；`>= prefix AND < prefix+'￿'` 是
    // 前缀区间扫描，把单会话 parse 从 40s 降到亚秒级。':' 的下一字符是 ';'。
    const prefix = `bubbleId:${composerId}:`
    const rows = await io.querySqlite(
      dbPath,
      `SELECT key, value FROM cursorDiskKV WHERE key >= '${prefix}' AND key < 'bubbleId:${composerId};';`,
      immutable ? { immutable: true } : {},
    )
    for (const row of rows) {
      const b = parseBubble(String(row.key), String(row.value ?? ''))
      if (b) map.set(b.bubbleId, b)
    }
  } catch {
    /* 库打不开/表缺失 → 上层降级 */
  }
  return map
}

/** composerData 里的气泡有序清单（fullConversationHeadersOnly） */
async function loadBubbleOrder(
  io: ImportIO,
  dbPath: string,
  composerId: string,
  immutable: boolean,
): Promise<string[] | null> {
  try {
    const rows = await io.querySqlite(
      dbPath,
      `SELECT value FROM cursorDiskKV WHERE key='composerData:${composerId}';`,
      immutable ? { immutable: true } : {},
    )
    const raw = rows[0]?.value
    if (typeof raw !== 'string' || !raw) return null
    const parsed = JSON.parse(raw) as {
      fullConversationHeadersOnly?: Array<{ bubbleId?: string }>
    }
    const order = (parsed.fullConversationHeadersOnly ?? [])
      .map((h) => h?.bubbleId)
      .filter((b): b is string => typeof b === 'string')
    return order.length ? order : null
  } catch {
    return null
  }
}

// ── 图片二段寻址（workspaceStorage <hash>/images/<uuid>-*.png）──────────

async function buildImageLocator(
  io: ImportIO,
  workspaceStorageDir: string,
): Promise<(uuid: string) => Promise<string | null>> {
  let hashDirs: string[] | null = null
  return async (uuid: string) => {
    if (hashDirs === null) {
      hashDirs = (await io.exists(workspaceStorageDir)) ? await io.readdir(workspaceStorageDir) : []
    }
    for (const hash of hashDirs) {
      const imagesDir = `${workspaceStorageDir}/${hash}/images`
      if (!(await io.exists(imagesDir))) continue
      for (const f of await io.readdir(imagesDir)) {
        if (f.startsWith(uuid)) return `${imagesDir}/${f}`
      }
    }
    return null
  }
}

// ── jsonl 转写层 ─────────────────────────────────────────────────────────

const REDACTED_MARK = '[REDACTED]'

interface JsonlParseResult {
  messages: UnifiedMessage[]
  hadUnfilledRedaction: boolean
}

function extractUserQuery(text: string): string {
  const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text)
  return m ? m[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').trim()
}

function extractInlineTimestamp(text: string): string | null {
  // 人类可读：`Thursday, May 21, 2026, 11:23 PM (UTC+8)`（底稿 §2.5，21% 覆盖）
  const m = /<timestamp>\s*([\s\S]*?)\s*<\/timestamp>/i.exec(text)
  if (!m) return null
  const cleaned = m[1].replace(/\((UTC[+-]\d+)\)/, (_all, tz: string) => tz)
  const parsed = Date.parse(cleaned)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

async function parseJsonlLayer(
  io: ImportIO,
  jsonlPath: string,
  header: CursorHeader,
  bubbles: Map<string, BubbleRow>,
  unknownRecords: Record<string, number>,
): Promise<JsonlParseResult> {
  interface RawMsg {
    role: 'user' | 'assistant'
    blocks: UnifiedBlock[]
    inlineTs: string | null
  }
  const raw: RawMsg[] = []
  let hadUnfilledRedaction = false

  // REDACTED 回填索引：气泡 assistant 文本按前缀匹配（底稿 §2.6 实证同会话气泡原文干净）
  const bubbleTexts = [...bubbles.values()]
    .filter((b) => b.type === 2 && b.text)
    .map((b) => b.text as string)

  let toolSeq = 0
  for await (const line of io.readJsonlLines(jsonlPath)) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      unknownRecords['parse_error'] = (unknownRecords['parse_error'] ?? 0) + 1
      continue
    }
    if (row.type === 'turn_ended') continue
    const role = row.role === 'user' || row.role === 'assistant' ? row.role : null
    if (!role) {
      const t = String(row.type ?? 'unknown')
      unknownRecords[`skipped:${t}`] = (unknownRecords[`skipped:${t}`] ?? 0) + 1
      continue
    }
    const message = row.message as { content?: unknown } | undefined
    const content = Array.isArray(message?.content) ? (message?.content as Array<Record<string, unknown>>) : []
    const blocks: UnifiedBlock[] = []
    let inlineTs: string | null = null
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        if (role === 'user') {
          inlineTs = inlineTs ?? extractInlineTimestamp(part.text)
          const q = extractUserQuery(part.text)
          if (q) blocks.push({ type: 'text', text: q })
        } else {
          let text = part.text
          if (text.includes(REDACTED_MARK)) {
            // 尝试气泡回填：找以本文本去掉 [REDACTED] 后前缀开头的气泡原文
            const prefix = text.split(REDACTED_MARK)[0].trim()
            const candidate =
              prefix.length >= 8 ? bubbleTexts.find((t) => t.startsWith(prefix)) : undefined
            if (candidate) text = candidate
            else if (text.trim() === REDACTED_MARK) {
              text = '（此段回复正文未被 Cursor 转写保存）'
              hadUnfilledRedaction = true
            } else hadUnfilledRedaction = true
          }
          if (text) blocks.push({ type: 'text', text })
        }
      } else if (part?.type === 'tool_use') {
        toolSeq += 1
        blocks.push({
          type: 'tool_use',
          id: `cursor-jsonl-${header.composerId.slice(0, 8)}-${toolSeq}`,
          name: String(part.name ?? 'unknown_tool'),
          input: part.input ?? {},
        })
      }
    }
    if (blocks.length) raw.push({ role, blocks, inlineTs })
  }

  // 时间戳：内嵌 <timestamp> 优先，否则会话头时间窗内插 + clamp（PRD §3.3）
  const interpolated = interpolateTimestamps(
    raw.length,
    new Date(header.createdAt).toISOString(),
    new Date(header.lastUpdatedAt).toISOString(),
  )
  const messages: UnifiedMessage[] = raw.map((m, i) => ({
    id: contentHashId(
      header.composerId,
      m.role,
      i,
      m.blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? b.name : '')).join('\n'),
    ),
    role: m.role,
    blocks: m.blocks,
    createdAt: m.inlineTs ?? interpolated[i],
    timeEstimated: !m.inlineTs,
  }))
  return { messages, hadUnfilledRedaction }
}

// ── 气泡层 → UnifiedMessage ──────────────────────────────────────────────

async function bubblesToMessages(
  order: string[],
  bubbles: Map<string, BubbleRow>,
  io: ImportIO,
  locateImage: (uuid: string) => Promise<string | null>,
  opts: ParseOptions | undefined,
): Promise<UnifiedMessage[]> {
  const messages: UnifiedMessage[] = []
  let current: UnifiedMessage | null = null

  const flush = () => {
    if (current && current.blocks.length) messages.push(current)
    current = null
  }

  for (const bubbleId of order) {
    const b = bubbles.get(bubbleId)
    if (!b) continue
    const role: 'user' | 'assistant' = b.type === 1 ? 'user' : 'assistant'

    if (role === 'user') {
      flush()
      const blocks: UnifiedBlock[] = []
      if (b.text) blocks.push({ type: 'text', text: extractUserQuery(b.text) })
      for (const uuid of b.imageUuids) {
        const p = await locateImage(uuid)
        if (p) blocks.push({ type: 'image_ref', path: p, mimeType: 'image/png' })
      }
      if (blocks.length) {
        messages.push({
          id: bubbleId,
          role: 'user',
          blocks,
          createdAt: b.createdAt ?? new Date(0).toISOString(),
        })
      }
      continue
    }

    // assistant：连续的 assistant 气泡（文本/思考/工具）归并为一条消息
    if (!current) {
      current = {
        id: bubbleId,
        role: 'assistant',
        blocks: [],
        createdAt: b.createdAt ?? new Date(0).toISOString(),
        ...(b.modelName ? { model: b.modelName } : {}),
      }
    }
    if (b.thinking) {
      current.blocks.push({
        type: 'thinking',
        thinking: b.thinking.text,
        ...(b.thinking.signature ? { signature: b.thinking.signature } : {}),
      })
    }
    if (b.text) current.blocks.push({ type: 'text', text: b.text })
    if (b.toolFormerData?.toolCallId) {
      const tfd = b.toolFormerData
      let input: unknown = {}
      try {
        input = tfd.params ? JSON.parse(tfd.params) : {}
      } catch {
        input = { raw: tfd.params }
      }
      current.blocks.push({
        type: 'tool_use',
        id: tfd.toolCallId!,
        name: tfd.name ?? `tool_${tfd.tool ?? 'unknown'}`,
        input,
      })
      if (tfd.result != null) {
        let resultText = tfd.result
        try {
          const parsed = JSON.parse(tfd.result) as Record<string, unknown>
          if (typeof parsed.output === 'string') resultText = parsed.output
        } catch {
          /* 原样 */
        }
        current.blocks.push({
          type: 'tool_result',
          tool_use_id: tfd.toolCallId!,
          content: resultText,
          is_error: tfd.status === 'error' || undefined,
        })
      }
    }
  }
  flush()
  return messages
}

// ── adapter ─────────────────────────────────────────────────────────────

async function detectCursorCounts(
  io: ImportIO,
  dbPath: string,
  opts: { immutable?: boolean } = {},
): Promise<{ n: number; ws: number; oldest: unknown; newest: unknown } | null> {
  if (!(await io.exists(dbPath))) return null
  try {
    const rows = await io.querySqlite(
      dbPath,
      `SELECT COUNT(*) AS n, MIN(createdAt) AS oldest, MAX(lastUpdatedAt) AS newest FROM composerHeaders WHERE isSubagent=0;`,
      opts.immutable ? { immutable: true } : undefined,
    )
    const n = Number(rows[0]?.n ?? 0)
    const wsRows = await io.querySqlite(
      dbPath,
      `SELECT COUNT(DISTINCT json_extract(value,'$.workspaceIdentifier.uri.fsPath')) AS w FROM composerHeaders WHERE isSubagent=0;`,
      opts.immutable ? { immutable: true } : undefined,
    )
    return { n, ws: Number(wsRows[0]?.w ?? 0), oldest: rows[0]?.oldest, newest: rows[0]?.newest }
  } catch {
    return null
  }
}

export const cursorAdapter: SourceAdapter = {
  source: 'cursor',

  async detect(io: ImportIO): Promise<DetectResult> {
    const paths = resolveSourcePaths(io, 'cursor')
    const db = paths.extras.stateDb
    const backup = paths.extras.stateDbBackup
    if (!(await io.exists(db)) && !(await io.exists(backup))) {
      return { source: 'cursor', installed: false, sessionCount: 0, workspaceCount: 0, newestActivityAt: null, oldestActivityAt: null }
    }
    let counts = await detectCursorCounts(io, db)
    // 活库被 Cursor 边写边读时 COUNT 可能超时返回空；backup 作 detect 兜底（只计数，不拷贝 15GB）。
    if ((!counts || counts.n === 0) && backup !== db) {
      counts = (await detectCursorCounts(io, backup, { immutable: true })) ?? counts
    }
    if (!counts || counts.n === 0) {
      return {
        source: 'cursor',
        installed: false,
        sessionCount: 0,
        workspaceCount: 0,
        newestActivityAt: null,
        oldestActivityAt: null,
        ...(await io.exists(db)
          ? { note: 'state.vscdb 存在但 composerHeaders 计数为 0（库被占用/超时或版本不兼容）' }
          : {}),
      }
    }
    return {
      source: 'cursor',
      installed: true,
      sessionCount: counts.n,
      workspaceCount: counts.ws,
      newestActivityAt: counts.newest ? new Date(Number(counts.newest)).toISOString() : null,
      oldestActivityAt: counts.oldest ? new Date(Number(counts.oldest)).toISOString() : null,
    }
  },

  async scan(io: ImportIO, opts?: ScanOptions): Promise<ScanResult> {
    const paths = resolveSourcePaths(io, 'cursor')
    const headers = await loadHeaders(io, paths.extras.stateDb, { mainOnly: true })
    const projectsDir = paths.extras.projectsDir

    // jsonl 转写存在性（layer 判定第二级）：projects/<slug>/agent-transcripts/<id>/
    const jsonlIndex = new Map<string, string>()
    if (await io.exists(projectsDir)) {
      for (const slug of await io.readdir(projectsDir)) {
        const tDir = `${projectsDir}/${slug}/agent-transcripts`
        if (!(await io.exists(tDir))) continue
        for (const id of await io.readdir(tDir)) {
          const p = `${tDir}/${id}/${id}.jsonl`
          if (await io.exists(p)) jsonlIndex.set(id, p)
        }
      }
    }

    const refs: SessionRef[] = []
    for (const h of headers.values()) {
      if (h.isSubagent) continue // 子 Agent 折叠：不平铺进列表（PRD §2.5/§3.3）
      if (h.isDraft) continue
      if (opts?.includeArchived === false && h.isArchived) continue
      if (opts?.since && h.lastUpdatedAt < opts.since.getTime()) continue

      // layer 判定推迟到 parseSession（气泡层要查 15.78GB 库，scan 阶段只看 jsonl）
      const jsonlPath = jsonlIndex.get(h.composerId)
      // 无 transcript 的空壳会话：不进导入预览（避免侧栏堆「无标题 / 0 消息」）
      if (!jsonlPath) continue
      const layer: ContentLayer = 'jsonl'
      refs.push({
        source: 'cursor',
        sourceSessionId: h.composerId,
        sourcePath: jsonlPath,
        title: h.name ?? '',
        cwd: h.workspaceFolder && h.workspaceFolder !== 'empty-window' ? h.workspaceFolder : null,
        createdAt: new Date(h.createdAt).toISOString(),
        updatedAt: new Date(h.lastUpdatedAt).toISOString(),
        archived: h.isArchived,
        subagent: false,
        layer,
      })
    }

    const byCwd = new Map<string, SessionRef[]>()
    const orphans: SessionRef[] = []
    for (const r of refs) {
      if (!r.cwd || r.cwd === '/') orphans.push(r)
      else {
        if (!byCwd.has(r.cwd)) byCwd.set(r.cwd, [])
        byCwd.get(r.cwd)!.push(r)
      }
    }
    const workspaces: ScanWorkspace[] = []
    for (const [cwd, sessions] of byCwd) {
      workspaces.push({ cwd, cwdExists: await io.exists(cwd), sessions })
    }
    return { source: 'cursor', workspaces, orphanSessions: orphans }
  },

  async parseSession(io: ImportIO, ref: SessionRef, opts?: ParseOptions): Promise<UnifiedSession> {
    const paths = resolveSourcePaths(io, 'cursor')
    // 单会话查询：不整读 25k 行 header（parse 阶段只要这一条）
    const header = (await loadSingleHeader(io, paths.extras.stateDb, ref.sourceSessionId)) ?? {
      composerId: ref.sourceSessionId,
      name: ref.title || null,
      createdAt: Date.parse(ref.createdAt),
      lastUpdatedAt: Date.parse(ref.updatedAt),
      workspaceFolder: ref.cwd,
      isArchived: ref.archived,
      isSubagent: false,
      isDraft: false,
      unifiedMode: null,
      parentComposerId: null,
    }
    const unknownRecords: Record<string, number> = {}
    const redactStats = newRedactStats()
    const locateImage = await buildImageLocator(io, paths.extras.workspaceStorageDir)

    // 第一层：气泡（主库 → backup 救援；LIKE 一次拉全，勿 N+1）
    let order = await loadBubbleOrder(io, paths.extras.stateDb, ref.sourceSessionId, false)
    let bubbles = order
      ? await loadBubbles(io, paths.extras.stateDb, ref.sourceSessionId, false)
      : new Map<string, BubbleRow>()
    if ((!order || bubbles.size === 0) && (await io.exists(paths.extras.stateDbBackup))) {
      const backupOrder = await loadBubbleOrder(io, paths.extras.stateDbBackup, ref.sourceSessionId, true)
      if (backupOrder) {
        const backupBubbles = await loadBubbles(io, paths.extras.stateDbBackup, ref.sourceSessionId, true)
        if (backupBubbles.size > 0) {
          // backup 与主库并集（bubbleId 键天然去重，PRD §3.3 Cursor）
          order = order && order.length >= backupOrder.length ? order : backupOrder
          for (const [k, v] of backupBubbles) if (!bubbles.has(k)) bubbles.set(k, v)
        }
      }
    }

    let layer: ContentLayer
    let messages: UnifiedMessage[] = []
    let lossy = false

    if (order && bubbles.size > 0) {
      layer = 'bubble'
      messages = await bubblesToMessages(order, bubbles, io, locateImage, opts)
    } else if (ref.layer === 'jsonl' && (await io.exists(ref.sourcePath))) {
      layer = 'jsonl'
      const result = await parseJsonlLayer(io, ref.sourcePath, header, bubbles, unknownRecords)
      messages = result.messages
      lossy = result.hadUnfilledRedaction
    } else {
      layer = 'header_only'
    }

    const redact = opts?.redact !== false
    return {
      source: 'cursor',
      sourceSessionId: ref.sourceSessionId,
      sourcePath: ref.sourcePath,
      title: header.name ?? (ref.title || '（无标题会话）'),
      titleSource: header.name ? 'native' : (ref.titleSource ?? 'derived'),
      cwd: ref.cwd,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      archived: ref.archived,
      layer,
      lossy,
      messages: normalizeMessages(messages, { source: 'cursor', redact, redactStats }),
      subagents: [], // Cursor 子 Agent 是独立 composer，由上层按 scan ref 单独编排
      ...(messages.find((m) => m.model)?.model ? { model: messages.find((m) => m.model)!.model } : {}),
      unknownRecords,
    }
  },
}

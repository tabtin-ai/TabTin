/**
 * Claude Code adapter（含 Claude Desktop 的 Code tab——同一份数据）。
 *
 * 数据事实以调研底稿为准：docs/prd/external-agent-import-research/claude-data.md
 * - 正文：{configDir}/projects/<slug>/<sessionId>.jsonl（envelope 行式）
 * - 标题/归档/fork 正典：Desktop 索引 claude-code-sessions 下各账号/组织目录的
 *   local_<uuid>.json（join 键 cliSessionId；280 条索引 vs 139 个正文——差集以
 *   header_only 导入）
 * - 一次 API 回复拆多行（同 message.id），需归组；uuid = 源生 client_event_id
 * - 超大 tool 结果外置 tool-results/<id>.txt，解引用回填
 * - fork 会话复制父历史：按 forkedFromSessionId + uuid 交集去重，仅导增量
 * - sidechain 双格式：新版 subagents/ 目录；旧版内联 isSidechain 行
 */

import type { ImportIO } from '../io.js'
import { resolveSourcePaths } from '../paths.js'
import { decodeBase64Image, normalizeMessages } from '../normalize.js'
import { newRedactStats } from '../redact.js'
import type {
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
  UnifiedSubagent,
} from '../types.js'

// ── Desktop 索引 ─────────────────────────────────────────────────────────

interface DesktopIndexEntry {
  cliSessionId: string
  title: string | null
  titleSource: string | null
  cwd: string | null
  createdAt: number | null
  lastActivityAt: number | null
  isArchived: boolean
  forkedFromSessionId: string | null
}

async function loadDesktopIndex(io: ImportIO, dir: string): Promise<Map<string, DesktopIndexEntry>> {
  const map = new Map<string, DesktopIndexEntry>()
  if (!(await io.exists(dir))) return map
  for (const account of await io.readdir(dir)) {
    const accountDir = `${dir}/${account}`
    const accountStat = await io.stat(accountDir)
    if (!accountStat?.isDirectory) continue
    for (const org of await io.readdir(accountDir)) {
      const orgDir = `${accountDir}/${org}`
      const orgStat = await io.stat(orgDir)
      if (!orgStat?.isDirectory) continue
      for (const file of await io.readdir(orgDir)) {
        if (!file.startsWith('local_') || !file.endsWith('.json')) continue
        try {
          const raw = JSON.parse(await io.readTextFile(`${orgDir}/${file}`)) as Record<string, unknown>
          const cli = typeof raw.cliSessionId === 'string' ? raw.cliSessionId : null
          if (!cli) continue
          const forked = typeof raw.forkedFromSessionId === 'string' ? raw.forkedFromSessionId : null
          map.set(cli, {
            cliSessionId: cli,
            title: typeof raw.title === 'string' ? raw.title : null,
            titleSource: typeof raw.titleSource === 'string' ? raw.titleSource : null,
            cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
            lastActivityAt: typeof raw.lastActivityAt === 'number' ? raw.lastActivityAt : null,
            isArchived: raw.isArchived === true,
            // `local_` 前缀去掉即 cliSessionId 形态（底稿 §2.4）
            forkedFromSessionId: forked ? forked.replace(/^local_/, '') : null,
          })
        } catch {
          /* 单个索引文件坏不影响整体 */
        }
      }
    }
  }
  return map
}

// ── 正文 jsonl 扫描 ──────────────────────────────────────────────────────

interface JsonlSessionFile {
  sessionId: string
  path: string
  slugDir: string
  mtimeMs: number
}

async function listJsonlSessions(io: ImportIO, projectsDir: string): Promise<JsonlSessionFile[]> {
  const out: JsonlSessionFile[] = []
  if (!(await io.exists(projectsDir))) return out
  for (const slug of await io.readdir(projectsDir)) {
    const slugDir = `${projectsDir}/${slug}`
    const slugStat = await io.stat(slugDir)
    if (!slugStat?.isDirectory) continue
    for (const file of await io.readdir(slugDir)) {
      if (!file.endsWith('.jsonl')) continue
      const p = `${slugDir}/${file}`
      const st = await io.stat(p)
      if (!st || st.isDirectory) continue
      out.push({ sessionId: file.slice(0, -6), path: p, slugDir, mtimeMs: st.mtimeMs })
    }
  }
  return out
}

/** 读 jsonl 头部若干行提取 cwd / 首条时间戳（scan 用，不整读） */
async function peekJsonlMeta(
  io: ImportIO,
  p: string,
): Promise<{ cwd: string | null; firstTs: string | null }> {
  let cwd: string | null = null
  let firstTs: string | null = null
  let lines = 0
  for await (const line of io.readJsonlLines(p)) {
    lines += 1
    if (lines > 25) break
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
      if (!firstTs && typeof row.timestamp === 'string') firstTs = row.timestamp
      if (cwd && firstTs) break
    } catch {
      /* 跳过坏行 */
    }
  }
  return { cwd, firstTs }
}

// ── 标题清洗 ─────────────────────────────────────────────────────────────

function deriveTitleFromFirstHuman(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 50 ? `${clean.slice(0, 50)}…` : clean
}

function isInjectedText(text: string): boolean {
  return text.trimStart().startsWith('<')
}

// ── parse ───────────────────────────────────────────────────────────────

interface EnvelopeRow {
  type?: string
  uuid?: string
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  agentId?: string
  gitBranch?: string
  message?: {
    id?: string
    role?: string
    model?: string
    content?: unknown
    stop_reason?: string
    usage?: Record<string, number>
  }
  aiTitle?: string
  customTitle?: string
  isApiErrorMessage?: boolean
}

interface ParseAccumulator {
  messages: UnifiedMessage[]
  /** message.id → 归组中的 assistant（一次回复拆多行） */
  byApiMessageId: Map<string, UnifiedMessage>
  /** tool_use id → 持有它的 assistant（tool_result 回填目标） */
  toolUseHolder: Map<string, UnifiedMessage>
  aiTitle: string | null
  customTitle: string | null
  gitBranch: string | null
  unknownRecords: Record<string, number>
}

async function resolveExternalToolResult(
  io: ImportIO,
  slugSessionDir: string,
  content: unknown,
): Promise<unknown> {
  // 新版超大结果外置 tool-results/<id>.txt；content 为字符串引用时解引用回填
  if (typeof content !== 'string') return content
  const m = /^\[tool result stored at:? (tool-results\/[A-Za-z0-9._-]+\.txt)\]$/.exec(content.trim())
  if (!m) return content
  const p = `${slugSessionDir}/${m[1]}`
  if (!(await io.exists(p))) return content
  try {
    return await io.readTextFile(p, 4 * 1024 * 1024)
  } catch {
    return content
  }
}

async function blocksFromContent(
  io: ImportIO,
  content: unknown,
  opts: ParseOptions | undefined,
  acc: ParseAccumulator,
  slugSessionDir: string,
): Promise<{ blocks: UnifiedBlock[]; toolResults: Array<{ id: string; content: string; isError: boolean }> }> {
  const blocks: UnifiedBlock[] = []
  const toolResults: Array<{ id: string; content: string; isError: boolean }> = []
  if (typeof content === 'string') {
    if (content) blocks.push({ type: 'text', text: content })
    return { blocks, toolResults }
  }
  if (!Array.isArray(content)) return { blocks, toolResults }
  for (const part of content as Array<Record<string, unknown>>) {
    switch (part?.type) {
      case 'text':
        if (typeof part.text === 'string' && part.text) blocks.push({ type: 'text', text: part.text })
        break
      case 'thinking':
        blocks.push({
          type: 'thinking',
          thinking: typeof part.thinking === 'string' ? part.thinking : '',
          ...(typeof part.signature === 'string' ? { signature: part.signature } : {}),
        })
        break
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          id: String(part.id ?? ''),
          name: String(part.name ?? ''),
          input: part.input,
        })
        break
      case 'tool_result': {
        const raw = await resolveExternalToolResult(io, slugSessionDir, part.content)
        const text =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? (raw as Array<Record<string, unknown>>)
                  .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                  .filter(Boolean)
                  .join('\n')
              : JSON.stringify(raw ?? '')
        toolResults.push({
          id: String(part.tool_use_id ?? ''),
          content: text,
          isError: part.is_error === true,
        })
        break
      }
      case 'image': {
        const source = part.source as Record<string, unknown> | undefined
        const data = typeof source?.data === 'string' ? source.data : null
        const decoded = data ? decodeBase64Image(data) : null
        if (decoded && opts?.attachmentDir !== undefined) {
          const path = await io.writeAttachment('claude-image.png', decoded.buffer)
          blocks.push({ type: 'image_ref', path, mimeType: decoded.mimeType, byteSize: decoded.buffer.length })
        } else {
          blocks.push({ type: 'text', text: '（图片附件，导入时未抽取）' })
        }
        break
      }
      default:
        if (part?.type) acc.unknownRecords[`content:${String(part.type)}`] = (acc.unknownRecords[`content:${String(part.type)}`] ?? 0) + 1
    }
  }
  return { blocks, toolResults }
}

function attachToolResults(
  acc: ParseAccumulator,
  results: Array<{ id: string; content: string; isError: boolean }>,
): void {
  for (const r of results) {
    const holder = acc.toolUseHolder.get(r.id)
    if (!holder) continue // 无主 tool_result：对应 tool_use 不在导入范围（如被过滤的 meta 轮），丢弃
    holder.blocks.push({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError || undefined })
  }
}

async function parseJsonlInto(
  io: ImportIO,
  path: string,
  slugSessionDir: string,
  opts: ParseOptions | undefined,
  acc: ParseAccumulator,
  options: { skipUuids?: Set<string>; collectUuids?: Set<string>; sidechain: 'exclude' | 'only' | 'include' },
): Promise<void> {
  for await (const line of io.readJsonlLines(path)) {
    if (!line.trim()) continue
    let row: EnvelopeRow
    try {
      row = JSON.parse(line) as EnvelopeRow
    } catch {
      acc.unknownRecords['parse_error'] = (acc.unknownRecords['parse_error'] ?? 0) + 1
      continue
    }
    const type = row.type ?? 'unknown'
    if (type === 'ai-title') {
      if (typeof row.aiTitle === 'string') acc.aiTitle = row.aiTitle
      continue
    }
    if (type === 'custom-title') {
      if (typeof row.customTitle === 'string') acc.customTitle = row.customTitle
      continue
    }
    if (type !== 'user' && type !== 'assistant') {
      // attachment / queue-operation / mode / system / last-prompt / pr-link / frame-link…
      // 非对话主体，计数不导（PRD §3.3 Claude 过滤清单）
      acc.unknownRecords[`skipped:${type}`] = (acc.unknownRecords[`skipped:${type}`] ?? 0) + 1
      continue
    }
    if (row.isMeta || row.isCompactSummary || row.isVisibleInTranscriptOnly) continue
    if (options.sidechain === 'exclude' && row.isSidechain) continue
    if (options.sidechain === 'only' && !row.isSidechain) continue
    if (row.uuid && options.skipUuids?.has(row.uuid)) continue
    if (row.uuid) options.collectUuids?.add(row.uuid)
    if (row.isApiErrorMessage) continue
    if (row.gitBranch) acc.gitBranch = row.gitBranch

    const msg = row.message
    if (!msg) continue
    const { blocks, toolResults } = await blocksFromContent(io, msg.content, opts, acc, slugSessionDir)
    attachToolResults(acc, toolResults)
    if (blocks.length === 0) continue

    if (type === 'assistant' && msg.id && acc.byApiMessageId.has(msg.id)) {
      // 同一次 API 回复的后续行：归并 blocks
      const existing = acc.byApiMessageId.get(msg.id)!
      existing.blocks.push(...blocks)
      for (const b of blocks) if (b.type === 'tool_use') acc.toolUseHolder.set(b.id, existing)
      if (msg.stop_reason) existing.stopReason = msg.stop_reason
      if (msg.usage) existing.usage = msg.usage
      continue
    }

    const unified: UnifiedMessage = {
      id: row.uuid ?? `${path}#${acc.messages.length}`,
      role: type,
      blocks,
      createdAt: row.timestamp ?? new Date(0).toISOString(),
      ...(msg.model && msg.model !== '<synthetic>' ? { model: msg.model } : {}),
      ...(msg.usage ? { usage: msg.usage } : {}),
      ...(msg.stop_reason ? { stopReason: msg.stop_reason } : {}),
    }
    for (const b of blocks) if (b.type === 'tool_use') acc.toolUseHolder.set(b.id, unified)
    if (type === 'assistant' && msg.id) acc.byApiMessageId.set(msg.id, unified)
    acc.messages.push(unified)
  }
}

async function loadSubagents(
  io: ImportIO,
  slugSessionDir: string,
  opts: ParseOptions | undefined,
  parentAcc: ParseAccumulator,
): Promise<UnifiedSubagent[]> {
  const dir = `${slugSessionDir}/subagents`
  if (!(await io.exists(dir))) return []
  const out: UnifiedSubagent[] = []
  for (const file of await io.readdir(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const agentId = file.replace(/\.jsonl$/, '')
    let description: string | undefined
    try {
      const meta = JSON.parse(await io.readTextFile(`${dir}/${agentId}.meta.json`)) as Record<string, unknown>
      if (typeof meta.description === 'string') description = meta.description
    } catch {
      /* meta 缺失可容忍 */
    }
    const acc: ParseAccumulator = {
      messages: [],
      byApiMessageId: new Map(),
      toolUseHolder: new Map(),
      aiTitle: null,
      customTitle: null,
      gitBranch: null,
      unknownRecords: parentAcc.unknownRecords,
    }
    await parseJsonlInto(io, `${dir}/${file}`, slugSessionDir, opts, acc, { sidechain: 'include' })
    if (acc.messages.length > 0) out.push({ sourceId: agentId, description, messages: acc.messages })
  }
  return out
}

// ── adapter ─────────────────────────────────────────────────────────────

export const claudeCodeAdapter: SourceAdapter = {
  source: 'claude_code',

  async detect(io: ImportIO): Promise<DetectResult> {
    const paths = resolveSourcePaths(io, 'claude_code')
    const rootExists = await io.exists(paths.extras.projectsDir)
    const desktopIndex = await loadDesktopIndex(io, paths.extras.desktopSessionsDir)
    const jsonlFiles = rootExists ? await listJsonlSessions(io, paths.extras.projectsDir) : []
    const sessionCount = Math.max(desktopIndex.size, jsonlFiles.length)
    if (!rootExists && desktopIndex.size === 0) {
      return { source: 'claude_code', installed: false, sessionCount: 0, workspaceCount: 0, newestActivityAt: null, oldestActivityAt: null }
    }
    const activity = [...desktopIndex.values()]
      .map((e) => e.lastActivityAt ?? e.createdAt ?? 0)
      .filter((n) => n > 0)
    for (const f of jsonlFiles) activity.push(f.mtimeMs)
    const cwds = new Set([...desktopIndex.values()].map((e) => e.cwd).filter(Boolean))
    return {
      source: 'claude_code',
      installed: sessionCount > 0,
      sessionCount,
      workspaceCount: cwds.size,
      newestActivityAt: activity.length ? new Date(Math.max(...activity)).toISOString() : null,
      oldestActivityAt: activity.length ? new Date(Math.min(...activity)).toISOString() : null,
    }
  },

  async scan(io: ImportIO, opts?: ScanOptions): Promise<ScanResult> {
    const paths = resolveSourcePaths(io, 'claude_code')
    const desktopIndex = await loadDesktopIndex(io, paths.extras.desktopSessionsDir)
    const jsonlFiles = await listJsonlSessions(io, paths.extras.projectsDir)
    const jsonlById = new Map(jsonlFiles.map((f) => [f.sessionId, f]))

    const refs: SessionRef[] = []
    const seen = new Set<string>()

    // 1) Desktop 索引为主（标题正典 + 覆盖已被清理正文的会话）
    for (const entry of desktopIndex.values()) {
      seen.add(entry.cliSessionId)
      const jsonl = jsonlById.get(entry.cliSessionId)
      let cwd = entry.cwd
      if (!cwd && jsonl) cwd = (await peekJsonlMeta(io, jsonl.path)).cwd
      const updatedMs = entry.lastActivityAt ?? entry.createdAt ?? jsonl?.mtimeMs ?? 0
      // 无 jsonl 正文：不进导入预览（header_only 只会落空档案）
      if (!jsonl) continue
      refs.push({
        source: 'claude_code',
        sourceSessionId: entry.cliSessionId,
        sourcePath: jsonl.path,
        title: entry.title ?? '',
        cwd,
        createdAt: new Date(entry.createdAt ?? updatedMs).toISOString(),
        updatedAt: new Date(updatedMs).toISOString(),
        archived: entry.isArchived,
        subagent: false,
        layer: 'full',
      })
    }

    // 2) 有正文但索引缺的（纯 CLI 会话等）
    for (const f of jsonlFiles) {
      if (seen.has(f.sessionId)) continue
      const meta = await peekJsonlMeta(io, f.path)
      refs.push({
        source: 'claude_code',
        sourceSessionId: f.sessionId,
        sourcePath: f.path,
        title: '',
        cwd: meta.cwd,
        createdAt: meta.firstTs ?? new Date(f.mtimeMs).toISOString(),
        updatedAt: new Date(f.mtimeMs).toISOString(),
        archived: false,
        subagent: false,
        layer: 'full',
      })
    }

    const filtered = refs.filter((r) => {
      if (opts?.since && Date.parse(r.updatedAt) < opts.since.getTime()) return false
      if (opts?.includeArchived === false && r.archived) return false
      return true
    })

    const byCwd = new Map<string, SessionRef[]>()
    const orphans: SessionRef[] = []
    for (const r of filtered) {
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
    return { source: 'claude_code', workspaces, orphanSessions: orphans }
  },

  async parseSession(io: ImportIO, ref: SessionRef, opts?: ParseOptions): Promise<UnifiedSession> {
    const paths = resolveSourcePaths(io, 'claude_code')
    const desktopIndex = await loadDesktopIndex(io, paths.extras.desktopSessionsDir)
    const entry = desktopIndex.get(ref.sourceSessionId) ?? null

    const acc: ParseAccumulator = {
      messages: [],
      byApiMessageId: new Map(),
      toolUseHolder: new Map(),
      aiTitle: null,
      customTitle: null,
      gitBranch: null,
      unknownRecords: {},
    }
    let subagents: UnifiedSubagent[] = []
    const redactStats = newRedactStats()

    if (ref.layer !== 'header_only' && (await io.exists(ref.sourcePath))) {
      // fork 去重：父会话（同 slug 目录）uuid 交集跳过，仅导增量（PRD §3.3 Claude）
      let skipUuids: Set<string> | undefined
      const forkedFrom = entry?.forkedFromSessionId
      if (forkedFrom) {
        const slugDir = ref.sourcePath.slice(0, ref.sourcePath.lastIndexOf('/'))
        const parentPath = `${slugDir}/${forkedFrom}.jsonl`
        if (await io.exists(parentPath)) {
          skipUuids = new Set()
          const parentAcc: ParseAccumulator = {
            messages: [],
            byApiMessageId: new Map(),
            toolUseHolder: new Map(),
            aiTitle: null,
            customTitle: null,
            gitBranch: null,
            unknownRecords: {},
          }
          await parseJsonlInto(io, parentPath, slugDir, { ...opts, redact: false }, parentAcc, {
            collectUuids: skipUuids,
            sidechain: 'include',
          })
        }
      }
      const slugSessionDir = `${ref.sourcePath.slice(0, ref.sourcePath.lastIndexOf('/'))}/${ref.sourceSessionId}`
      // 主线（旧版内联 sidechain 单独归组，新版走 subagents/ 目录）
      await parseJsonlInto(io, ref.sourcePath, slugSessionDir, opts, acc, { skipUuids, sidechain: 'exclude' })
      const inlineSidechain: ParseAccumulator = {
        messages: [],
        byApiMessageId: new Map(),
        toolUseHolder: new Map(),
        aiTitle: null,
        customTitle: null,
        gitBranch: null,
        unknownRecords: acc.unknownRecords,
      }
      await parseJsonlInto(io, ref.sourcePath, slugSessionDir, opts, inlineSidechain, { skipUuids, sidechain: 'only' })
      subagents = await loadSubagents(io, slugSessionDir, opts, acc)
      if (inlineSidechain.messages.length > 0) {
        subagents.push({ sourceId: `${ref.sourceSessionId}-inline-sidechain`, messages: inlineSidechain.messages })
      }
    }

    // 标题：custom-title > ai-title > Desktop title > 首条人类消息清洗（底稿 §2.2）
    let title = acc.customTitle ?? acc.aiTitle ?? entry?.title ?? ref.title
    let titleSource: UnifiedSession['titleSource'] = acc.customTitle
      ? 'custom'
      : acc.aiTitle || entry?.title
        ? 'native'
        : 'derived'
    if (!title) {
      const firstHuman = acc.messages.find(
        (m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && !isInjectedText(b.text)),
      )
      const text = firstHuman?.blocks.find((b): b is Extract<UnifiedBlock, { type: 'text' }> => b.type === 'text')
      title = text ? deriveTitleFromFirstHuman(text.text) : '（无标题会话）'
      titleSource = 'derived'
    }

    const redact = opts?.redact !== false
    const normalize = (msgs: UnifiedMessage[]) =>
      normalizeMessages(msgs, { source: 'claude_code', redact, redactStats })

    const totalTokens = acc.messages.reduce(
      (sum, m) => sum + (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0),
      0,
    )

    return {
      source: 'claude_code',
      sourceSessionId: ref.sourceSessionId,
      sourcePath: ref.sourcePath,
      title,
      titleSource,
      cwd: ref.cwd,
      createdAt: ref.createdAt,
      updatedAt: ref.updatedAt,
      archived: ref.archived,
      layer: ref.layer,
      lossy: false,
      messages: normalize(acc.messages),
      subagents: subagents.map((s) => ({ ...s, messages: normalize(s.messages) })),
      ...(totalTokens > 0 ? { totalTokens } : {}),
      ...(acc.messages.find((m) => m.model)?.model ? { model: acc.messages.find((m) => m.model)!.model } : {}),
      ...(acc.gitBranch ? { gitBranch: acc.gitBranch } : {}),
      unknownRecords: acc.unknownRecords,
    }
  },
}

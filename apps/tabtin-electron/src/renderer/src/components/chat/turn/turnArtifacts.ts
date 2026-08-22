/**
 * 轮次产物聚合 —— 从一轮对话消息窗口提取 TurnArtifact[]（纯函数，可单测）。
 *
 * 数据源（ 通用交付物协议）：
 *   1. tool_artifact 的可交付 rich：local_file / oss_file / platform_resource / widget
 *   2. assistant 正文 tabtin://resource 链接
 *   3. write_file / edit_file / delete_file + shell file_history + 可交付 local_file：
 *      统一 canonicalize 后进 path ops，轮末净算后仍存在的文件才入卡
 *   4. ：父 `agent` tool_result 内嵌的子代理交付物（派发轮归属）；
 *      后台晚完成还可经 SubagentDeliverablesResolver 按 parent_tool_call_id 补入
 *
 * 排除：
 *   - 非 allowlist 的展示块（裸 resource_ref / table_preview / present file·image）
 *   - assistant `diff_summary.files`：Shadow Git 工作区 diff ≠ Agent 交付物
 *   - 不再从 run_terminal_command stdout scrape doc/table（只靠 host platform_resource）
 *   - 临时/隐藏段过程路径（：write/local_file 与 shell 同套 isDeliverableRelativePath）
 *
 *  对账：各通道路径先 canonicalize（去 `./`、POSIX），shell 即使 ok=false
 * 仍消费 deleted_paths，避免已删采集 JSON 残留在产物卡。
 */
import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'
import { parseResourcePointer } from '@tabtin/resource-router'
import {
  collectAssistantText,
  extractResourceLinkArtifacts,
} from '../context/resourceLinkArtifacts'
import {
  pairToolResultsByBlock,
  stripApprovalNotePrefix,
  type PairedToolResult,
  type SemanticBlock,
} from '../../../stores/chat/messages/utils/contentBlockSemantics'
import { readMessageBlocks } from '../blocks/messageContentBlocks'
import {
  LOCAL_FILE_ARTIFACT_KIND,
  isDeliverableRichBlock,
  localFileRelativePath,
  mapResourceTypeToKind,
  normalizeRichBlock,
  readArtifactKind,
  richBlockToArtifact,
} from './turnArtifactFromRich'
import {
  agentToolDeliverableToArtifact,
  parseDeliverablesFromAgentToolContent,
  resolveSubagentSourceDisplayName,
  type AgentToolDeliverable,
} from './turnArtifactFromAgentTool'
import {
  basename,
  canonicalizeArtifactRelativePath,
  diffFileHref,
  isDeliverableRelativePath,
  survivingFileHistoryOps,
  type FileHistoryOp,
} from './turnArtifactPathOps'
import type {
  TurnArtifact,
  TurnArtifactKind,
  TurnArtifactSubtitleKey,
  TurnBlocksResolver,
} from './turnArtifactTypes'
import {
  getTurnEndIndex,
  getTurnMessageWindow,
  isTurnEndSlot,
  findLastTurnEndIndex,
  isOpenStreamingTurnEnd,
  shouldShowTurnArtifactsCard,
} from './turnBoundary'

export type {
  TurnArtifact,
  TurnArtifactKind,
  TurnArtifactSubtitleKey,
  TurnBlocksResolver,
} from './turnArtifactTypes'

export {
  DELIVERABLE_ARTIFACT_KINDS,
  LOCAL_FILE_ARTIFACT_KIND,
  OSS_FILE_ARTIFACT_KIND,
  PLATFORM_RESOURCE_ARTIFACT_KIND,
  isDeliverableRichBlock,
  richBlockToArtifact,
} from './turnArtifactFromRich'

export {
  getTurnEndIndex,
  getTurnMessageWindow,
  isTurnEndSlot,
  findLastTurnEndIndex,
  isOpenStreamingTurnEnd,
  shouldShowTurnArtifactsCard,
}

const defaultTurnBlocksResolver: TurnBlocksResolver = (m) =>
  readMessageBlocks(m) as MessageBlock[]

function subtitleKeyForKind(kind: TurnArtifactKind): TurnArtifactSubtitleKey {
  switch (kind) {
    case 'doc': return 'previewDoc'
    case 'table': return 'previewTable'
    case 'resource': return 'previewResource'
    case 'widget': return 'previewWidget'
    default: return 'previewFile'
  }
}

function dedupeKey(href: string): string {
  try {
    const ptr = parseResourcePointer(href)
    if (ptr.type === 'file' && ptr.id) {
      return `file:${decodeURIComponent(ptr.id)}`.toLowerCase()
    }
    if (ptr.type && ptr.id) {
      return `${ptr.type}:${decodeURIComponent(ptr.id)}`.toLowerCase()
    }
  } catch {
    // fall through to raw href
  }
  return href.trim().toLowerCase()
}

/** 产物去重键（href → file:/doc:…），供卡片「历史产物」折叠区与本轮列表去重。 */
export function turnArtifactDedupeKey(href: string): string {
  return dedupeKey(href)
}

/**
 * 从候选列表去掉本轮已展示项（同 href）。
 * 候选应已是「当前轮之前的历史轮」产物，勿传入整会话或后续轮。
 */
export function filterHistoryArtifactsNotInTurn(
  historyArtifacts: TurnArtifact[],
  turnArtifacts: TurnArtifact[],
): TurnArtifact[] {
  if (historyArtifacts.length === 0) return []
  const turnKeys = new Set(turnArtifacts.map((a) => dedupeKey(a.href)))
  return historyArtifacts.filter((a) => !turnKeys.has(dedupeKey(a.href)))
}

/** @deprecated 使用 filterHistoryArtifactsNotInTurn */
export const filterOtherSessionArtifacts = filterHistoryArtifactsNotInTurn

function pushArtifact(
  bucket: TurnArtifact[],
  seen: Set<string>,
  artifact: Omit<TurnArtifact, 'subtitleKey'> & { subtitleKey?: TurnArtifactSubtitleKey },
): void {
  const key = dedupeKey(artifact.href)
  if (seen.has(key)) {
    // 正文链接可能先于结构化 resource_ref 出现；后者才带真实工作空间。
    // 去重不能把这条归属信息吞掉，否则 Project 会话会错误回退到 Project scope。
    const existing = bucket.find(item => dedupeKey(item.href) === key)
    if (existing) {
      if (artifact.resourceSpaceId && !existing.resourceSpaceId) {
        existing.resourceSpaceId = artifact.resourceSpaceId
      }
      if (typeof artifact.fileSize === 'number' && existing.fileSize == null) {
        existing.fileSize = artifact.fileSize
      }
      if (artifact.sourceSubagentName && !existing.sourceSubagentName) {
        existing.sourceSubagentName = artifact.sourceSubagentName
      }
    }
    return
  }
  seen.add(key)
  bucket.push({
    ...artifact,
    subtitleKey: artifact.subtitleKey ?? subtitleKeyForKind(artifact.kind),
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 终端结果统一表示 —— 会话级、与「结果落在哪条消息 / 哪个 store」无关。
 * 由两条来源归一：配对 tool_result 块（历史 co-locate）、会话级 toolEvents
 * （实时 canonical，含 file_history）。
 */
export interface ResolvedToolResult {
  ok: boolean
  /** 本命令新建 / 修改的 workspace 文件（相对路径）。 */
  fileHistoryPaths: string[]
  /** 本命令删除的 workspace 文件（相对路径）——轮末净算「建了又删」的中间产物。 */
  fileHistoryDeletedPaths: string[]
}

/**
 * 会话级工具结果 resolver：按 tool_use_id 取结果，跨消息、跨 store。
 * 与 ToolUseBlockView 同款「按 toolCallId 会话级取数」思路，让产物聚合
 * 不再依赖 tool_result 落在哪条 message.blocks 里（实时期它根本不在）。
 */
export type SessionToolResultResolver = (toolCallId: string) => ResolvedToolResult | undefined

/**
 * ：按 tool_use_id 取 agent 工具原始文本结果（含交付物标签）。
 * 实时路径 tool_result 尚未 co-locate 时，从 toolEvents.output 补齐。
 */
export type AgentToolContentResolver = (toolCallId: string) => string | undefined

/**
 * ：按派发父 tool_use_id 取后台子代理已完成的交付物
 * （SUBAGENT_COMPLETED → SubagentRun.deliverables）。
 */
export type SubagentDeliverablesResolver = (parentToolCallId: string) => AgentToolDeliverable[]

/** 按派发父 tool_use_id 解析子代理来源显示名（本轮产物 badge）。 */
export type SubagentDisplayNameResolver = (parentToolCallId: string) => string | undefined

export interface TurnArtifactCollectOptions {
  sessionToolResult?: SessionToolResultResolver
  agentToolContent?: AgentToolContentResolver
  subagentDeliverables?: SubagentDeliverablesResolver
  resolveSubagentDisplayName?: SubagentDisplayNameResolver
}

/** 从已解析的终端结果对象抽出 ok / file_history 路径（唯一口径）。 */
function extractTerminalResultFields(
  outer: Record<string, unknown>,
): { okByEnvelope: boolean; fileHistoryPaths: string[]; fileHistoryDeletedPaths: string[] } {
  // 终端结果三种成功形态：exit_code===0 / exitCode===0 / success===true
  // （对齐终端卡片的兼容口径，bugbot ）
  const exitCode = typeof outer.exit_code === 'number'
    ? outer.exit_code
    : (typeof outer.exitCode === 'number' ? outer.exitCode : null)
  const okByEnvelope = exitCode !== null ? exitCode === 0 : outer.success === true
  const fileHistory = asRecord(outer.file_history)
  const fileHistoryPaths = [
    ...toStringArray(fileHistory?.created_paths),
    ...toStringArray(fileHistory?.modified_paths),
  ]
  const fileHistoryDeletedPaths = toStringArray(fileHistory?.deleted_paths)
  return { okByEnvelope, fileHistoryPaths, fileHistoryDeletedPaths }
}

function parseTerminalToolResultContent(content: string): ResolvedToolResult | null {
  try {
    const outer = JSON.parse(stripApprovalNotePrefix(content).trim()) as Record<string, unknown>
    const { okByEnvelope, fileHistoryPaths, fileHistoryDeletedPaths } = extractTerminalResultFields(outer)
    return { ok: okByEnvelope, fileHistoryPaths, fileHistoryDeletedPaths }
  } catch {
    return null
  }
}

/**
 * 把会话级 toolEvents 的 output 归一成 ResolvedToolResult（供 MessageList 构造
 * resolver）。output 已被 unwrapToolOutputFence 处理：run_terminal_command 为
 * 已解析对象；老数据 / 其它形态可能是 JSON string，这里兜底再解析一次。
 * phase='error' 视为失败（ok=false），与终端卡 isError 口径一致。
 */
export function resolveToolEventResult(
  output: unknown,
  isError: boolean,
): ResolvedToolResult | null {
  let parsed: unknown = output
  if (typeof parsed === 'string') {
    const trimmed = stripApprovalNotePrefix(parsed).trim()
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  const outer = asRecord(parsed)
  if (!outer) return null
  const { okByEnvelope, fileHistoryPaths, fileHistoryDeletedPaths } = extractTerminalResultFields(outer)
  return { ok: !isError && okByEnvelope, fileHistoryPaths, fileHistoryDeletedPaths }
}

/**
 *  / ：write_file / edit_file / delete_file 仅在配对成功时参与净算。
 * 无配对 / isError / content.success===false → 拒；content 非 JSON 不误杀。
 */
function isSuccessfulFileMutationResult(result: PairedToolResult | undefined): boolean {
  if (!result) return false
  if (result.isError) return false
  if (typeof result.content === 'string' && result.content.trim()) {
    try {
      const parsed = asRecord(JSON.parse(result.content))
      if (parsed?.success === false) return false
    } catch {
      // 解析失败放行：别挡历史非 JSON 成功结果
    }
  }
  return true
}

function isSuccessfulFileMutation(
  blockResult: PairedToolResult | undefined,
  toolUseId: string,
  sessionToolResult?: SessionToolResultResolver,
): boolean {
  if (blockResult) return isSuccessfulFileMutationResult(blockResult)
  return toolUseId ? sessionToolResult?.(toolUseId)?.ok === true : false
}

const FILE_MUTATION_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file'])
const RUN_TERMINAL_TOOL_NAME = 'run_terminal_command'
const AGENT_TOOL_NAME = 'agent'
const TOOL_USE_BLOCK_TYPE = 'tool_use'

function resolveAgentToolContentString(
  toolUseId: string,
  blockResult: PairedToolResult | undefined,
  agentToolContent?: AgentToolContentResolver,
): string | undefined {
  if (typeof blockResult?.content === 'string' && blockResult.content.trim()) {
    return blockResult.content
  }
  return toolUseId ? agentToolContent?.(toolUseId) : undefined
}

function appendAgentToolDeliverables(
  toolUseId: string,
  blockResult: PairedToolResult | undefined,
  artifacts: TurnArtifact[],
  seen: Set<string>,
  options?: TurnArtifactCollectOptions,
  toolUseInput?: Record<string, unknown> | null,
): void {
  if (!toolUseId) return
  const content = resolveAgentToolContentString(
    toolUseId,
    blockResult,
    options?.agentToolContent,
  )
  const fromContent = content ? parseDeliverablesFromAgentToolContent(content) : []
  const fromSubagent = options?.subagentDeliverables?.(toolUseId) ?? []
  const merged = [...fromContent, ...fromSubagent]
  if (merged.length === 0) return
  const sourceSubagentName = options?.resolveSubagentDisplayName?.(toolUseId)
    || resolveSubagentSourceDisplayName({
      role: typeof toolUseInput?.role === 'string' ? toolUseInput.role : null,
      label: typeof toolUseInput?.label === 'string' ? toolUseInput.label : null,
      description: typeof toolUseInput?.description === 'string' ? toolUseInput.description : null,
    })
  merged.forEach((deliverable, index) => {
    const mapped = agentToolDeliverableToArtifact(
      deliverable,
      toolUseId,
      index,
      sourceSubagentName,
    )
    if (mapped) pushArtifact(artifacts, seen, mapped)
  })
}

function resolveToolUseResult(
  toolUseId: string,
  blockResult: PairedToolResult | undefined,
  sessionToolResult?: SessionToolResultResolver,
): ResolvedToolResult | null {
  const rawContent = blockResult?.content
  if (typeof rawContent === 'string' && rawContent.trim()) {
    return parseTerminalToolResultContent(rawContent)
  }
  return toolUseId ? sessionToolResult?.(toolUseId) ?? null : null
}

function appendFileMutationPathOp(
  msg: ChatMessage,
  blockIndex: number,
  name: string,
  input: Record<string, unknown> | null,
  toolUseId: string,
  blockResult: PairedToolResult | undefined,
  fileHistoryOps: FileHistoryOp[],
  sessionToolResult?: SessionToolResultResolver,
): void {
  const rawPath = typeof input?.path === 'string' ? input.path : ''
  const filePath = rawPath ? canonicalizeArtifactRelativePath(rawPath) : null
  if (!filePath) return
  if (!isSuccessfulFileMutation(blockResult, toolUseId, sessionToolResult)) return
  // delete 必须能抵消过程草稿；create/modify 与 shell 同套交付物闸门
  if (name !== 'delete_file' && !isDeliverableRelativePath(filePath)) return
  fileHistoryOps.push(
    name === 'delete_file'
      ? { path: filePath, deleted: true, artifactId: '' }
      : {
          path: filePath,
          deleted: false,
          artifactId: `${msg.id}::tool::${name}::${blockIndex}::${filePath}`,
        },
  )
}

function appendShellDeletedPathOps(
  parsed: ResolvedToolResult,
  fileHistoryOps: FileHistoryOp[],
): void {
  for (const rawPath of parsed.fileHistoryDeletedPaths) {
    const filePath = canonicalizeArtifactRelativePath(rawPath)
    if (!filePath) continue
    fileHistoryOps.push({ path: filePath, deleted: true, artifactId: '' })
  }
}

function appendShellFileHistoryOps(
  msg: ChatMessage,
  blockIndex: number,
  parsed: ResolvedToolResult,
  fileHistoryOps: FileHistoryOp[],
): void {
  for (const rawPath of parsed.fileHistoryPaths) {
    const filePath = canonicalizeArtifactRelativePath(rawPath)
    if (!filePath || !isDeliverableRelativePath(filePath)) continue
    fileHistoryOps.push({
      path: filePath,
      deleted: false,
      artifactId: `${msg.id}::tool::shell-file::${blockIndex}::${filePath}`,
    })
  }
  appendShellDeletedPathOps(parsed, fileHistoryOps)
}

/** 单条 tool_use → path ops（mutation / shell file_history）或 agent 交付物。 */
function appendToolUsePathOps(
  msg: ChatMessage,
  blockIndex: number,
  block: MessageBlock,
  resultByBlock: Map<string, PairedToolResult>,
  fileHistoryOps: FileHistoryOp[],
  artifacts: TurnArtifact[],
  seen: Set<string>,
  options?: TurnArtifactCollectOptions,
): void {
  if ((block.type as string) !== TOOL_USE_BLOCK_TYPE) return
  const rawBlock = block as MessageBlock & { name?: string; input?: unknown; id?: string }
  const name = typeof rawBlock.name === 'string' ? rawBlock.name : ''
  const toolUseId = typeof rawBlock.id === 'string' ? rawBlock.id : ''
  const blockResult = toolUseId ? resultByBlock.get(toolUseId) : undefined

  if (FILE_MUTATION_TOOL_NAMES.has(name)) {
    appendFileMutationPathOp(
      msg,
      blockIndex,
      name,
      asRecord(rawBlock.input),
      toolUseId,
      blockResult,
      fileHistoryOps,
      options?.sessionToolResult,
    )
    return
  }

  if (name === AGENT_TOOL_NAME) {
    appendAgentToolDeliverables(
      toolUseId,
      blockResult,
      artifacts,
      seen,
      options,
      asRecord(rawBlock.input),
    )
    return
  }

  if (name !== RUN_TERMINAL_TOOL_NAME) return
  const parsed = resolveToolUseResult(toolUseId, blockResult, options?.sessionToolResult)
  if (!parsed) return
  // ：ok=false 仍消费 deleted_paths（pipeline 非零也可能已 rm 成功）
  if (parsed.ok) {
    appendShellFileHistoryOps(msg, blockIndex, parsed, fileHistoryOps)
  } else {
    appendShellDeletedPathOps(parsed, fileHistoryOps)
  }
}

/** 单条可交付 rich → path ops（local_file）或即时入卡。 */
function appendDeliverableRich(
  msg: ChatMessage,
  blockIndex: number,
  raw: MessageBlock,
  artifacts: TurnArtifact[],
  seen: Set<string>,
  fileHistoryOps: FileHistoryOp[],
): void {
  const rich = normalizeRichBlock(raw)
  if (!rich || !isDeliverableRichBlock(raw, rich)) return

  if (readArtifactKind(raw, rich) === LOCAL_FILE_ARTIFACT_KIND) {
    const flat = rich as Record<string, unknown>
    const rawPath = localFileRelativePath(flat)
    const filePath = rawPath ? canonicalizeArtifactRelativePath(rawPath) : null
    if (filePath && isDeliverableRelativePath(filePath)) {
      const fileSize = typeof flat.file_size === 'number' && Number.isFinite(flat.file_size)
        ? flat.file_size
        : undefined
      fileHistoryOps.push({
        path: filePath,
        deleted: false,
        artifactId: `${msg.id}::rich::local_file::${blockIndex}::${filePath}`,
        ...(fileSize != null ? { fileSize } : {}),
      })
    }
    return
  }

  const mapped = richBlockToArtifact(rich, msg.id, blockIndex)
  if (mapped) pushArtifact(artifacts, seen, mapped)
}

function appendResourceLinkArtifacts(
  msg: ChatMessage,
  blocks: MessageBlock[],
  artifacts: TurnArtifact[],
  seen: Set<string>,
): void {
  if (msg.role !== 'assistant') return
  const text = collectAssistantText(msg.content, blocks)
  for (const link of extractResourceLinkArtifacts(text)) {
    pushArtifact(artifacts, seen, {
      id: `${msg.id}::reslink::${link.resourceKey}`,
      kind: mapResourceTypeToKind(link.resourceType),
      title: link.title,
      href: link.href,
    })
  }
}

/**
 * 单条消息：getBlocks 一次、blocks 单遍扫描。
 * 顺序保留：正文链接 → 块序（tool_use / rich）→ 由调用方做轮末 path 净算。
 */
function normalizeCollectOptions(
  input?: SessionToolResultResolver | TurnArtifactCollectOptions,
): TurnArtifactCollectOptions | undefined {
  if (!input) return undefined
  if (typeof input === 'function') return { sessionToolResult: input }
  return input
}

function collectFromMessage(
  msg: ChatMessage,
  blocks: MessageBlock[],
  artifacts: TurnArtifact[],
  seen: Set<string>,
  fileHistoryOps: FileHistoryOp[],
  options?: TurnArtifactCollectOptions,
): void {
  appendResourceLinkArtifacts(msg, blocks, artifacts, seen)
  if (blocks.length === 0) return

  const resultByBlock = pairToolResultsByBlock(blocks as SemanticBlock[])
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue
    if ((block.type as string) === TOOL_USE_BLOCK_TYPE) {
      appendToolUsePathOps(
        msg,
        i,
        block,
        resultByBlock,
        fileHistoryOps,
        artifacts,
        seen,
        options,
      )
      continue
    }
    appendDeliverableRich(msg, i, block, artifacts, seen, fileHistoryOps)
  }
}

function materializeSurvivingPathArtifacts(
  fileHistoryOps: FileHistoryOp[],
  artifacts: TurnArtifact[],
  seen: Set<string>,
): void {
  for (const op of survivingFileHistoryOps(fileHistoryOps)) {
    pushArtifact(artifacts, seen, {
      id: op.artifactId,
      kind: 'file',
      title: basename(op.path) ?? op.path,
      href: diffFileHref(op.path),
      ...(typeof op.fileSize === 'number' ? { fileSize: op.fileSize } : {}),
    })
  }
}

/** 聚合一轮消息窗口内的产物；无产物返回空数组。 */
export function collectTurnArtifacts(
  turnMessages: ChatMessage[],
  getBlocks: TurnBlocksResolver = defaultTurnBlocksResolver,
  sessionToolResultOrOptions?: SessionToolResultResolver | TurnArtifactCollectOptions,
): TurnArtifact[] {
  const options = normalizeCollectOptions(sessionToolResultOrOptions)
  const artifacts: TurnArtifact[] = []
  const seen = new Set<string>()
  const fileHistoryOps: FileHistoryOp[] = []

  for (const msg of turnMessages) {
    const rawBlocks = getBlocks(msg)
    const blocks = Array.isArray(rawBlocks) ? rawBlocks : []
    collectFromMessage(msg, blocks, artifacts, seen, fileHistoryOps, options)
  }

  materializeSurvivingPathArtifacts(fileHistoryOps, artifacts, seen)
  return artifacts
}

/** 聚合整个会话所有消息的产物（跨轮去重）。 */
export function collectSessionArtifacts(
  messages: ChatMessage[],
  getBlocks: TurnBlocksResolver = defaultTurnBlocksResolver,
  sessionToolResultOrOptions?: SessionToolResultResolver | TurnArtifactCollectOptions,
): TurnArtifact[] {
  return collectTurnArtifacts(messages, getBlocks, sessionToolResultOrOptions)
}

/**
 * 每个 turn 末尾 index → 该轮**之前**各轮产物并集（跨轮去重，不含本轮与后续轮）。
 * 供产物卡「历史产物」手风琴使用。
 */
export function buildPriorTurnArtifactsByEndIndex(
  messages: ChatMessage[],
  getBlocks: TurnBlocksResolver = defaultTurnBlocksResolver,
  sessionToolResultOrOptions?: SessionToolResultResolver | TurnArtifactCollectOptions,
): Map<number, TurnArtifact[]> {
  const map = new Map<number, TurnArtifact[]>()
  const accumulated: TurnArtifact[] = []
  const seen = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    if (!isTurnEndSlot(messages, i)) continue
    map.set(i, accumulated.length === 0 ? [] : accumulated.slice())
    const window = getTurnMessageWindow(messages, i)
    const current = collectTurnArtifacts(window, getBlocks, sessionToolResultOrOptions)
    for (const artifact of current) {
      pushArtifact(accumulated, seen, artifact)
    }
  }
  return map
}

/** 预计算每个 turn 末尾 index → 产物列表（MessageList useMemo 用）。 */
export function buildTurnArtifactsByEndIndex(
  messages: ChatMessage[],
  getBlocks: TurnBlocksResolver = defaultTurnBlocksResolver,
  sessionToolResultOrOptions?: SessionToolResultResolver | TurnArtifactCollectOptions,
): Map<number, TurnArtifact[]> {
  const map = new Map<number, TurnArtifact[]>()
  for (let i = 0; i < messages.length; i++) {
    if (!isTurnEndSlot(messages, i)) continue
    const window = getTurnMessageWindow(messages, i)
    const artifacts = collectTurnArtifacts(window, getBlocks, sessionToolResultOrOptions)
    if (artifacts.length > 0) map.set(i, artifacts)
  }
  return map
}

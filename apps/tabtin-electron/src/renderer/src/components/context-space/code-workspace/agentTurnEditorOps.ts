/**
 * 从本轮成功的 edit_file / write_file / delete_file 组装 Agent Turn 操作序列。
 *
 * 正文优先用写盘当下冻结的本机补丁；edit_file 可回退 tool_result 的 old_lines/new_lines。
 * 不读 diff_summary / Shadow Git / 当前磁盘；终端改动不入账。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import {
  pairToolResultsByBlock,
  stripApprovalNotePrefix,
  toolResultText,
  type PairedToolResult,
  type SemanticBlock,
} from '../../../stores/chat/messages/utils/contentBlockSemantics'
import { readMessageBlocks } from '../../chat/blocks/messageContentBlocks'
import {
  findLastClosedTurnEndIndex,
  getTurnMessageWindow,
  isTurnEndSlot,
} from '../../chat/turn/turnBoundary'
import { normalizePathForCompare } from '@components/tabcode/utils/worktreePaths'
import { buildStaticUnifiedDiffViewModel } from './staticUnifiedDiffModel'

export const EDITOR_TURN_TOOL_NAMES = new Set(['edit_file', 'write_file', 'delete_file'])

export type EditorTurnToolName = 'edit_file' | 'write_file' | 'delete_file'
export type EditorTurnOpStatus = 'modified' | 'added' | 'deleted' | 'unreadable'

export interface EditorTurnPatch {
  toolName: EditorTurnToolName
  relativePath: string
  status: EditorTurnOpStatus
  before?: string
  after?: string
  beforeFull?: string
  afterFull?: string
  binary?: boolean
  truncated?: boolean
}

export interface EditorTurnJournalRecord {
  toolUseId: string
  recordedAt?: string
  codeRootPath?: string
  patch: EditorTurnPatch
}

export interface EditorTurnOp extends EditorTurnPatch {
  toolUseId: string
  displayable: boolean
  insertions: number
  deletions: number
}

export interface EditorTurnFile {
  relativePath: string
  ops: EditorTurnOp[]
  insertions: number
  deletions: number
  hasDisplayable: boolean
}

export interface EditorTurnSummary {
  files: EditorTurnFile[]
  changed: number
  insertions: number
  deletions: number
  hasDisplayable: boolean
}

type ToolUseBlock = SemanticBlock & {
  name?: string
  id?: string
  input?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isEditorToolName(name: string): name is EditorTurnToolName {
  return EDITOR_TURN_TOOL_NAMES.has(name)
}

function parseResultPayload(result: PairedToolResult | undefined): Record<string, unknown> | null {
  if (!result) return null
  const text = stripApprovalNotePrefix(toolResultText(result.content)).trim()
  if (!text) return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

function isSuccessfulEditorResult(result: PairedToolResult | undefined): boolean {
  if (!result) return false
  if (result.isError) return false
  const payload = parseResultPayload(result)
  if (payload?.success === false) return false
  return true
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((item) => typeof item === 'string')) return null
  return value
}

function normalizeRelativePath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim()
}

function countPatchLines(before: string | undefined, after: string | undefined): {
  insertions: number
  deletions: number
} {
  const model = buildStaticUnifiedDiffViewModel(before ?? '', after ?? '')
  return { insertions: model.insertions, deletions: model.deletions }
}

function isDisplayablePatch(patch: EditorTurnPatch): boolean {
  if (patch.status === 'unreadable') return false
  if (patch.binary || patch.truncated) return false
  if (patch.status === 'deleted') return typeof patch.before === 'string'
  if (patch.status === 'added') return typeof patch.after === 'string'
  return typeof patch.before === 'string' && typeof patch.after === 'string'
}

function toOp(toolUseId: string, patch: EditorTurnPatch): EditorTurnOp {
  const displayable = isDisplayablePatch(patch)
  const counts = displayable
    ? countPatchLines(patch.before, patch.after)
    : { insertions: 0, deletions: 0 }
  return {
    ...patch,
    toolUseId,
    displayable,
    insertions: counts.insertions,
    deletions: counts.deletions,
  }
}

function fallbackPatchFromTool(
  toolName: EditorTurnToolName,
  relativePath: string,
  result: PairedToolResult | undefined,
): EditorTurnPatch {
  if (toolName === 'edit_file') {
    const payload = parseResultPayload(result)
    const oldLines = stringArray(payload?.old_lines)
    const newLines = stringArray(payload?.new_lines)
    if (oldLines && newLines && relativePath) {
      return {
        toolName,
        relativePath,
        status: 'modified',
        before: oldLines.join('\n'),
        after: newLines.join('\n'),
      }
    }
  }
  return {
    toolName,
    relativePath: relativePath || '(unknown)',
    status: 'unreadable',
  }
}

export function indexEditorTurnJournal(
  records: EditorTurnJournalRecord[] | undefined,
): Map<string, EditorTurnJournalRecord> {
  const map = new Map<string, EditorTurnJournalRecord>()
  if (!records) return map
  for (const record of records) {
    if (!record.toolUseId || !record.patch) continue
    map.set(record.toolUseId, record)
  }
  return map
}

export function getLatestTurnMessages(messages: ChatMessage[] | undefined): ChatMessage[] {
  if (!messages || messages.length === 0) return []
  const end = findLastClosedTurnEndIndex(messages)
  if (end < 0) return []
  return getTurnMessageWindow(messages, end)
}

export function getLatestClosedTurnEndMessageId(
  messages: ChatMessage[] | undefined,
): string | null {
  if (!messages || messages.length === 0) return null
  const end = findLastClosedTurnEndIndex(messages)
  return end >= 0 ? messages[end]?.id ?? null : null
}

/**
 * 当前代码根最近一次完成的 Agent 编辑轮。
 *
 * 会话可以先在 A 根编辑，再切到 B 根编辑；不能先选会话最新轮、再过滤根路径，
 * 否则切回 A 时会错误地得到空结果。
 */
export function getLatestClosedTurnEndMessageIdForCodeRoot(
  messages: ChatMessage[] | undefined,
  journalRecords: EditorTurnJournalRecord[] | undefined,
  codeRootPath: string | null | undefined,
): string | null {
  if (!messages || messages.length === 0 || !codeRootPath?.trim()) return null
  const lastClosedTurnEnd = findLastClosedTurnEndIndex(messages)
  if (lastClosedTurnEnd < 0) return null

  const journalByToolUseId = indexEditorTurnJournal(journalRecords)
  for (let index = lastClosedTurnEnd; index >= 0; index -= 1) {
    if (!isTurnEndSlot(messages, index)) continue
    const turnMessages = getTurnMessageWindow(messages, index)
    if (collectTurnEditorOps(turnMessages, journalByToolUseId, codeRootPath).length > 0) {
      return messages[index]?.id ?? null
    }
  }
  return null
}

function getTurnMessagesByEndMessageId(
  messages: ChatMessage[] | undefined,
  turnEndMessageId: string | null | undefined,
): ChatMessage[] {
  if (!messages || !turnEndMessageId) return getLatestTurnMessages(messages)
  const end = messages.findIndex((message) => message.id === turnEndMessageId)
  return end >= 0 ? getTurnMessageWindow(messages, end) : []
}

export function collectTurnEditorOps(
  turnMessages: ChatMessage[],
  journalByToolUseId?: Map<string, EditorTurnJournalRecord>,
  codeRootPath?: string | null,
): EditorTurnOp[] {
  const ops: EditorTurnOp[] = []
  const rootKey = codeRootPath ? normalizePathForCompare(codeRootPath) : ''
  for (const message of turnMessages) {
    const blocks = readMessageBlocks(message) as SemanticBlock[]
    if (blocks.length === 0) continue
    const resultByBlock = pairToolResultsByBlock(blocks)
    for (const block of blocks) {
      if ((block.type as string) !== 'tool_use') continue
      const toolUse = block as ToolUseBlock
      const toolName = typeof toolUse.name === 'string' ? toolUse.name : ''
      if (!isEditorToolName(toolName)) continue
      const toolUseId = typeof toolUse.id === 'string' ? toolUse.id : ''
      if (!toolUseId) continue
      const paired = resultByBlock.get(toolUseId)
        ?? (toolUse.tool_use_id ? resultByBlock.get(toolUse.tool_use_id) : undefined)
      if (!isSuccessfulEditorResult(paired)) continue
      const input = asRecord(toolUse.input)
      const journalRecord = journalByToolUseId?.get(toolUseId)
      if (rootKey) {
        const journalRoot = journalRecord?.codeRootPath
        if (!journalRoot || normalizePathForCompare(journalRoot) !== rootKey) continue
      }
      const journalPatch = journalRecord?.patch
      const relativePath = journalPatch?.relativePath
        || normalizeRelativePath(input?.path)
      const patch = journalPatch ?? fallbackPatchFromTool(toolName, relativePath, paired)
      ops.push(toOp(toolUseId, patch.relativePath ? patch : { ...patch, relativePath }))
    }
  }
  return ops
}

export function collectLatestTurnEditorOps(
  messages: ChatMessage[] | undefined,
  journalByToolUseId?: Map<string, EditorTurnJournalRecord>,
  codeRootPath?: string | null,
  turnEndMessageId?: string | null,
): EditorTurnOp[] {
  return collectTurnEditorOps(
    getTurnMessagesByEndMessageId(messages, turnEndMessageId),
    journalByToolUseId,
    codeRootPath,
  )
}

export function groupEditorOpsByFile(ops: EditorTurnOp[]): EditorTurnFile[] {
  const files: EditorTurnFile[] = []
  const indexByPath = new Map<string, number>()
  for (const op of ops) {
    const key = op.relativePath || op.toolUseId
    let file = files[indexByPath.get(key) ?? -1]
    if (!file) {
      file = {
        relativePath: op.relativePath || key,
        ops: [],
        insertions: 0,
        deletions: 0,
        hasDisplayable: false,
      }
      indexByPath.set(key, files.length)
      files.push(file)
    }
    file.ops.push(op)
    file.insertions += op.insertions
    file.deletions += op.deletions
    if (op.displayable) file.hasDisplayable = true
  }
  return files
}

export function summarizeEditorTurn(ops: EditorTurnOp[]): EditorTurnSummary {
  const files = groupEditorOpsByFile(ops)
  return {
    files,
    changed: files.length,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    hasDisplayable: files.some((file) => file.hasDisplayable),
  }
}

export function latestTurnHasEditorOps(
  messages: ChatMessage[] | undefined,
  journalByToolUseId?: Map<string, EditorTurnJournalRecord>,
): boolean {
  return collectLatestTurnEditorOps(messages, journalByToolUseId).length > 0
}

export interface EditorTurnFinalFile {
  relativePath: string
  status: EditorTurnOpStatus
  before?: string
  after?: string
  displayable: boolean
  insertions: number
  deletions: number
  opCount: number
  binary?: boolean
  truncated?: boolean
}

function opHasBeforeFull(op: EditorTurnOp): boolean {
  return typeof op.beforeFull === 'string' || op.status === 'added'
}

function opHasAfterFull(op: EditorTurnOp): boolean {
  return typeof op.afterFull === 'string' || op.status === 'deleted'
}

function opBeforeFullText(op: EditorTurnOp): string {
  if (op.status === 'added') return typeof op.beforeFull === 'string' ? op.beforeFull : ''
  return op.beforeFull ?? ''
}

function opAfterFullText(op: EditorTurnOp): string {
  if (op.status === 'deleted') return ''
  return op.afterFull ?? ''
}

function canComposeFullChain(ops: EditorTurnOp[]): boolean {
  if (ops.length === 0) return false
  for (const op of ops) {
    if (op.status === 'unreadable' || op.binary || op.truncated) return false
    if (!opHasBeforeFull(op) || !opHasAfterFull(op)) return false
  }
  for (let i = 1; i < ops.length; i += 1) {
    if (opAfterFullText(ops[i - 1]!) !== opBeforeFullText(ops[i]!)) return false
  }
  return true
}

function netTurnStatus(
  first: EditorTurnOp,
  last: EditorTurnOp,
  before: string,
  after: string,
): EditorTurnOpStatus {
  if (last.status === 'deleted') return 'deleted'
  if (first.status === 'added') return 'added'
  if (!before && after) return 'added'
  if (before && !after) return 'deleted'
  return 'modified'
}

function unreadableFinalFile(file: EditorTurnFile): EditorTurnFinalFile {
  return {
    relativePath: file.relativePath,
    status: 'unreadable',
    displayable: false,
    insertions: 0,
    deletions: 0,
    opCount: file.ops.length,
    ...(file.ops.some((op) => op.binary) ? { binary: true } : {}),
    ...(file.ops.some((op) => op.truncated) ? { truncated: true } : {}),
  }
}

export function foldEditorTurnFile(file: EditorTurnFile): EditorTurnFinalFile {
  const { ops } = file
  if (canComposeFullChain(ops)) {
    const first = ops[0]!
    const last = ops[ops.length - 1]!
    const before = opBeforeFullText(first)
    const after = opAfterFullText(last)
    const status = netTurnStatus(first, last, before, after)
    const counts = countPatchLines(before, after)
    return {
      relativePath: file.relativePath,
      status,
      before,
      after,
      displayable: true,
      insertions: counts.insertions,
      deletions: counts.deletions,
      opCount: ops.length,
    }
  }

  if (ops.length === 1 && isDisplayablePatch(ops[0]!)) {
    const op = ops[0]!
    return {
      relativePath: file.relativePath,
      status: op.status,
      before: op.before,
      after: op.after,
      displayable: true,
      insertions: op.insertions,
      deletions: op.deletions,
      opCount: 1,
    }
  }

  return unreadableFinalFile(file)
}

export function foldEditorTurnFiles(files: EditorTurnFile[]): EditorTurnFinalFile[] {
  return files.map((file) => foldEditorTurnFile(file))
}

export function collectLatestTurnEditorFinals(
  messages: ChatMessage[] | undefined,
  journalRecords?: EditorTurnJournalRecord[],
  codeRootPath?: string | null,
  turnEndMessageId?: string | null,
): EditorTurnFinalFile[] {
  return foldEditorTurnFiles(
    groupEditorOpsByFile(
      collectLatestTurnEditorOps(
        messages,
        indexEditorTurnJournal(journalRecords),
        codeRootPath,
        turnEndMessageId,
      ),
    ),
  )
}

export function aggregateEditorTurnFinals(files: EditorTurnFinalFile[]): {
  insertions: number
  deletions: number
} {
  let insertions = 0
  let deletions = 0
  for (const file of files) {
    insertions += file.insertions
    deletions += file.deletions
  }
  return { insertions, deletions }
}

export interface ClosedAgentTurnReview {
  turnEndMessageId: string
  files: EditorTurnFinalFile[]
  changed: number
  insertions: number
  deletions: number
}

/**
 * 当前闭合 Agent 轮的可复核编辑结果。
 *
 * Review Card 只能挂在当前最后一轮，不能沿用 Changes 为历史浏览准备的
 * “向前寻找最近有编辑轮”语义；否则上一轮无代码改动时会误显示更早的卡片。
 */
export function collectClosedAgentTurnReview(
  messages: ChatMessage[] | undefined,
  journalRecords: EditorTurnJournalRecord[] | undefined,
  codeRootPath?: string | null,
): ClosedAgentTurnReview | null {
  const turnEndMessageId = getLatestClosedTurnEndMessageId(messages)
  if (!turnEndMessageId) return null

  const files = collectLatestTurnEditorFinals(
    messages,
    journalRecords,
    codeRootPath,
    turnEndMessageId,
  )
  if (!files.some((file) => file.displayable)) return null

  const { insertions, deletions } = aggregateEditorTurnFinals(files)
  return {
    turnEndMessageId,
    files,
    changed: files.length,
    insertions,
    deletions,
  }
}

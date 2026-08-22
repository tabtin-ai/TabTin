import { stripApprovalNotePrefix } from '@stores/chat/messages/utils/contentBlockSemantics'
import type { ToolPresentation } from '@stores/chat/shared/types'
import { shouldSuppressPresentToUserForMediaImage } from '../cards/shouldSuppressPresentToUserForMediaImage'
import { getToolDescriptor } from '../registry/toolCardRegistry'
import { isCompactInlineTool, isPanelOnlyTool } from './compactInlineTools'
import { isPresentationFoldTool } from './PresentationToolFoldRow'
import {
  SUBAGENT_TOOL_NAMES,
  classifySubagentToolInput,
  getSubagentCheckId,
  getSubagentWaitIds,
} from './subagentToolNames'
import type { ContentBlockEntry, SiblingToolResult } from './types'

export function isErrorLikeToolOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const rec = output as Record<string, unknown>
  if (rec.success === false) return true
  if (rec.exited_by === 'exec_failure' || rec.exited_by === 'signal') return true
  if (rec.status === 'failed') return true
  if (typeof rec.error_kind === 'string' && rec.error_kind.length > 0) return true
  if (typeof rec.error === 'string' && rec.error.length > 0) return true
  return false
}

export function decodeToolOutputContent(rawOutput: unknown): unknown {
  if (typeof rawOutput !== 'string') return rawOutput
  const stripped = stripApprovalNotePrefix(rawOutput)
  const trimmed = stripped.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return stripped
  try {
    return JSON.parse(stripped) as unknown
  } catch {
    return stripped
  }
}

export function buildLifecycleProgressSnapshot(
  lifecycleFinalOutput: unknown,
  progress: {
    stdout?: string
    outputBytes?: number
    truncated?: boolean
    sessionId?: string
    pid?: number | null
    outputFile?: string
    command?: string
  } | undefined,
): Record<string, unknown> | undefined {
  if (lifecycleFinalOutput !== undefined) return undefined
  if (!progress) return undefined
  return {
    stdout: progress.stdout,
    stderr: '',
    output_bytes: progress.outputBytes,
    truncated: progress.truncated,
    ...(progress.sessionId ? { session_id: progress.sessionId } : {}),
    ...(progress.pid != null ? { pid: progress.pid } : {}),
    ...(progress.outputFile ? { output_file: progress.outputFile } : {}),
    ...(progress.command ? { command: progress.command } : {}),
    _tool_progress: true,
  }
}

export function resolveToolOutput(params: {
  siblingToolResult?: SiblingToolResult
  storedToolResultContent?: unknown
  lifecycleToolOutput: unknown
}): unknown {
  const rawOutput =
    params.siblingToolResult?.content
    ?? params.storedToolResultContent
    ?? params.lifecycleToolOutput
  return decodeToolOutputContent(rawOutput)
}

export function deriveToolUsePhase(params: {
  lifecycleEventPhase?: 'start' | 'running' | 'end' | 'error'
  isErrorResult: boolean
  hasTerminalResult: boolean
  entryFinalized: boolean
  liveExecutingWindow: boolean
}): 'start' | 'running' | 'end' | 'error' {
  if (params.lifecycleEventPhase === 'error' || params.isErrorResult) return 'error'
  if (params.lifecycleEventPhase === 'end' || params.hasTerminalResult) return 'end'
  if (!params.entryFinalized) return 'start'
  if (params.liveExecutingWindow) return 'running'
  return 'end'
}

export type CompactToolActivity = 'calling' | 'executing' | 'done'

export type SubagentCheckStatus =
  | 'checking'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'
  | 'not_found'
  | 'already_checked'

export type SubagentWaitStatus = 'waiting' | 'completed' | 'error'

const SUBAGENT_CHECK_STATUSES: ReadonlySet<string> = new Set<SubagentCheckStatus>([
  'checking',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'orphaned',
  'not_found',
  'already_checked',
])

export type ToolUseViewRoute =
  | { kind: 'parse_error' }
  | { kind: 'todo_compact'; activity: 'calling' | 'executing' }
  | { kind: 'todo_completed'; todos: unknown[] }
  | { kind: 'todo_hidden' }
  | { kind: 'subagent'; task?: string; background?: boolean }
  | { kind: 'subagent_pending' }
  | {
      kind: 'subagent_check'
      childId: string | null
      label?: string
      phase: 'start' | 'running' | 'end' | 'error'
      status?: SubagentCheckStatus
    }
  | {
      kind: 'subagent_wait'
      childIds: string[]
      phase: 'start' | 'running' | 'end' | 'error'
      status?: SubagentWaitStatus
      completedChildIds: string[]
      failedChildIds: string[]
      cancelledChildIds: string[]
    }
  | { kind: 'media_image'; command?: string; promptPreview?: string }
  | { kind: 'presentation_fold' }
  | { kind: 'presentation_hidden' }
  | { kind: 'compact_inline'; activity: CompactToolActivity }
  | { kind: 'tool_step_card' }

function compactActivityForPhase(phase: 'start' | 'running' | 'end' | 'error'): CompactToolActivity {
  if (phase === 'start') return 'calling'
  if (phase === 'running') return 'executing'
  return 'done'
}

function routeTodoToolView(
  toolName: string,
  phase: 'start' | 'running' | 'end' | 'error',
  todoSnapshot: unknown[] | undefined,
): ToolUseViewRoute | null {
  if (isPanelOnlyTool(toolName) && (phase === 'start' || phase === 'running')) {
    return { kind: 'todo_compact', activity: phase === 'start' ? 'calling' : 'executing' }
  }
  if (isPanelOnlyTool(toolName) && phase !== 'error') {
    if (todoSnapshot && todoSnapshot.length > 0) {
      return { kind: 'todo_completed', todos: todoSnapshot }
    }
    return { kind: 'todo_hidden' }
  }
  return null
}

export function parseSubagentCheckPresentation(
  presentation: ToolPresentation | undefined,
): { childId: string | null; label?: string; status?: SubagentCheckStatus } {
  const data = presentation?.kind === 'subagent_status_check'
    ? presentation.data
    : undefined
  const presentedStatus = typeof data?.status === 'string' ? data.status : undefined
  const status = presentedStatus && SUBAGENT_CHECK_STATUSES.has(presentedStatus)
    ? presentedStatus as SubagentCheckStatus
    : undefined
  const childId = typeof data?.childId === 'string' && data.childId.trim()
    ? data.childId.trim()
    : null
  const label = typeof data?.label === 'string' && data.label.trim()
    ? data.label.trim()
    : undefined
  return { childId, ...(label ? { label } : {}), ...(status ? { status } : {}) }
}

function routeSubagentCheckView(
  effectiveInput: unknown,
  phase: 'start' | 'running' | 'end' | 'error',
  presentation: ToolPresentation | undefined,
): ToolUseViewRoute {
  const presented = parseSubagentCheckPresentation(presentation)
  return {
    kind: 'subagent_check',
    childId: presented.childId ?? getSubagentCheckId(effectiveInput),
    phase,
    ...(presented.label ? { label: presented.label } : {}),
    ...(presented.status ? { status: presented.status } : {}),
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )]
}

function parseSubagentWaitPresentation(
  presentation: ToolPresentation | undefined,
): {
  status?: SubagentWaitStatus
  completedChildIds: string[]
  failedChildIds: string[]
  cancelledChildIds: string[]
} {
  const data = presentation?.kind === 'subagent_wait' ? presentation.data : undefined
  const rawStatus = data?.status
  const status = rawStatus === 'waiting' || rawStatus === 'completed' || rawStatus === 'error'
    ? rawStatus
    : undefined
  return {
    ...(status ? { status } : {}),
    completedChildIds: stringArray(data?.completedChildIds),
    failedChildIds: stringArray(data?.failedChildIds),
    cancelledChildIds: stringArray(data?.cancelledChildIds),
  }
}

function routeSubagentToolView(
  toolName: string,
  effectiveInput: unknown,
  inputFinalized: boolean,
  phase: 'start' | 'running' | 'end' | 'error',
  presentation: ToolPresentation | undefined,
): ToolUseViewRoute | null {
  if (!SUBAGENT_TOOL_NAMES.has(toolName)) return null
  const intent = classifySubagentToolInput(effectiveInput)
  if (intent === 'wait') {
    const presented = parseSubagentWaitPresentation(presentation)
    return {
      kind: 'subagent_wait',
      childIds: getSubagentWaitIds(effectiveInput) ?? [],
      phase,
      ...presented,
    }
  }
  if (intent === 'check') return routeSubagentCheckView(effectiveInput, phase, presentation)
  // tool_use block_start 早于 input_json_delta：此时还无法知道是派发、查询还是等待。
  // 暂不渲染通用 “子任务 · 正在调用”，等首个语义字段到达后再进入准确视图。
  if (intent === 'unknown' && !inputFinalized) return { kind: 'subagent_pending' }
  if (intent !== 'spawn' && intent !== 'resume') return null
  const input = effectiveInput as Record<string, unknown> | undefined
  const task = input?.prompt
  const taskString = typeof task === 'string' ? task : undefined
  const background = input?.background === true || input?.run_in_background === true
  return { kind: 'subagent', ...(taskString ? { task: taskString } : {}), ...(background ? { background } : {}) }
}

function routeMediaImageToolView(
  toolName: string,
  presentation: ToolPresentation | undefined,
): ToolUseViewRoute | null {
  if (
    getToolDescriptor(toolName)?.renderer !== 'TerminalCard'
    || presentation?.kind !== 'media_image_generation'
  ) return null

  const command = presentation.data?.command
  const prompt = presentation.data?.prompt
  return {
    kind: 'media_image',
    ...(typeof command === 'string' ? { command } : {}),
    ...(typeof prompt === 'string' ? { promptPreview: prompt } : {}),
  }
}

function routePresentationToolView(
  entry: ContentBlockEntry,
  toolName: string,
  effectiveInput: unknown,
  phase: 'start' | 'running' | 'end' | 'error',
  sessionId: string | null,
  presentation: ToolPresentation | undefined,
): ToolUseViewRoute | null {
  if (presentation?.kind === 'rich_content_only' && phase !== 'error') {
    return { kind: 'presentation_hidden' }
  }
  if (!isPresentationFoldTool(toolName) || entry.partial || phase === 'error') return null
  if (toolName === 'present_to_user' && shouldSuppressPresentToUserForMediaImage(effectiveInput, sessionId)) {
    return { kind: 'presentation_hidden' }
  }
  return { kind: 'presentation_fold' }
}

function routeCompactToolView(
  entry: ContentBlockEntry,
  toolName: string,
  phase: 'start' | 'running' | 'end' | 'error',
): ToolUseViewRoute | null {
  if (!isCompactInlineTool(toolName) || entry.partial || phase === 'error') return null
  return { kind: 'compact_inline', activity: compactActivityForPhase(phase) }
}

export function routeToolUseView(params: {
  entry: ContentBlockEntry
  toolName: string
  effectiveInput: unknown
  phase: 'start' | 'running' | 'end' | 'error'
  inputFinalized: boolean
  todoSnapshot: unknown[] | undefined
  sessionId: string | null
  presentation?: ToolPresentation
}): ToolUseViewRoute {
  const {
    entry,
    toolName,
    effectiveInput,
    phase,
    inputFinalized,
    todoSnapshot,
    sessionId,
    presentation,
  } = params
  if (entry.parseError) return { kind: 'parse_error' }

  return routeTodoToolView(toolName, phase, todoSnapshot)
    ?? routeSubagentToolView(toolName, effectiveInput, inputFinalized, phase, presentation)
    ?? routeMediaImageToolView(toolName, presentation)
    ?? routePresentationToolView(entry, toolName, effectiveInput, phase, sessionId, presentation)
    ?? routeCompactToolView(entry, toolName, phase)
    ?? { kind: 'tool_step_card' }
}

/**
 * Tool lifecycle SYSTEM_NOTICE 桥（W4a 二轮 R2-P0-1 修复产物）。
 *
 * 背景：W2 二代修复（见 §0.6 W2-L2/L3）把工具执行 lifecycle 从老协议
 * `agent.stream.tool` 物理迁移到 `agent.stream.system_notice` +
 * notice_type='tool_started/_completed/_failed/_pre_started_exec_*'。daemon 侧
 * 双路径都按 `tool-orchestration.ts.makeToolLifecycleNotice` 与 `query.ts`
 * pre-started 段写同一组字段（见 `packages/agent-runtime/src/engine/tool-lifecycle-notice.ts`）。
 *
 * W4a 删除老 `toolHandler.ts` 时漏接这条桥——renderer 不再有 handler 把
 * SYSTEM_NOTICE(tool_*) 翻译回 `toolEvent` / `agentStep` / `runState` 状态，
 * 工具卡片在流式期间完全不渲染（W4a 二轮 R2-P0-1）。本模块补全这条桥：
 *
 *   notice_type='tool_started' / 'tool_pre_started_exec_started' (phase='start')
 *     → upsertToolEventForSession(phase='start') + pushAgentStep(tool_start)
 *       + runState planning→tool_calls 切换 + 关闭上一条 running thinking
 *
 *   notice_type='tool_completed' / 'tool_pre_started_exec_completed' (phase='end')
 *     → upsertToolEventForSession(phase='end' + output + durationMs)
 *       + updateAgentStep(status='done')
 *       + completedToolCalls 递增
 *       + todo 时 setTodos
 *
 *   notice_type='tool_failed' / 'tool_pre_started_exec_failed' (phase='error')
 *     → upsertToolEventForSession(phase='error' + error + errorKind)
 *       + updateAgentStep(status='error')
 *       + completedToolCalls 递增
 *
 * 与老 `toolHandler.handleTool` 的字段语义 1:1 对齐——
 *   - id == tool_call_id；input/output 透传；durationMs 由
 *     `getEffectiveToolEventForSession` 补齐（pre_started 路径 payload 不带
 *     duration_ms，但带相同的 startedAt 链路）
 *   - input_summary / output_summary 缺失时走 `summarizeToolInput` /
 *     `summarizeToolOutput` 兜底
 *   - error 文案优先级：translateToolErrorKind → envelope error → raw text
 *   - error_kind 优先级：payload.error_kind > budget_skipped > parsedKind
 *
 * 不重新加 STEP 分发——W4a 走新协议铁律，thinking step 通过
 * contentBlockHandler 镜像（独立 R2-P1-4 修复）。
 *
 * Wave 7 决策点：本模块的存在依赖 W2 用 SYSTEM_NOTICE 当 workaround。若 W7
 * 决策新增 `agent.stream.tool_execution` 专用元事件类型（见 §0.6 W2-L3），
 * 本模块可平滑迁移——只换 dispatch 入口字段名，内部 reuse 即可。
 */

import i18n from '@/i18n'
import type {
  AgentStep,
  AgentStepStatus,
  AgentStepType,
  ToolPhase,
  ToolPresentation,
} from '../../shared/types'
import {
  shouldHideTodoInitEvent,
  summarizeToolInput,
  summarizeToolOutput,
  humanizeToolName,
  unwrapToolOutputFence,
  extractToolOutputFenceSuspicious,
  payloadStrOpt as strOpt,
  payloadStrNull as strNull,
  payloadNum as num,
} from '../../shared/helpers'
import {
  isTranslatableToolError,
  normalizeToolErrorI18nKey,
  resolveModeRestrictedI18nKey,
} from '@components/chat/tool/toolErrorClassification'
import { createLogger } from '@/utils/logger'
import type { HandlerContext } from './streamHandlerTypes'

const log = createLogger('E2E:ToolLifecycle')

// ─── Notice type → phase 映射（与 daemon 字面对齐）────────────────────
//
// daemon 侧的 enum 见 `packages/agent-runtime/src/engine/tool-lifecycle-notice.ts`。
// 这里保留本地 const 不直接 import 那个常量——renderer / runtime 两端通过
// "字面字符串契约"耦合（不引入 cross-package import 链），便于 dev-build
// 隔离。若字面不一致 → 本桥静默 skip 而不是抛错（前端容错原则）。
const TOOL_LIFECYCLE_NOTICE_PHASE: Record<string, ToolPhase> = {
  tool_started: 'start',
  tool_completed: 'end',
  tool_failed: 'error',
  tool_pre_started_exec_started: 'start',
  tool_pre_started_exec_completed: 'end',
  tool_pre_started_exec_failed: 'error',
}

export function isToolLifecycleNoticeType(noticeType: string | undefined): boolean {
  return typeof noticeType === 'string' && noticeType in TOOL_LIFECYCLE_NOTICE_PHASE
}

export const TOOL_INTENT_AVAILABLE_NOTICE_TYPE = 'tool_intent_available' as const

function extractToolIntent(payload: Record<string, unknown>): string | undefined {
  const metadata = payload.tool_call_metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  return strOpt((metadata as Record<string, unknown>).intent)
}

export function handleToolIntentAvailableNotice(
  payload: Record<string, unknown>,
  ctx: HandlerContext,
): boolean {
  if (payload.notice_type !== TOOL_INTENT_AVAILABLE_NOTICE_TYPE) return false
  const toolName = strOpt(payload.tool_name)
  const toolCallId = strOpt(payload.tool_call_id)
  const intent = extractToolIntent(payload)
  if (!toolName || !toolCallId || !intent) return false

  ctx.get().upsertToolEventForSession(ctx.sessionId, {
    id: toolCallId,
    toolName,
    phase: 'start',
    intent,
    timestamp: Date.now(),
  })
  return true
}

/**
 * **2026-05-17 streaming tool_progress**：SYSTEM_NOTICE notice_type='tool_progress'
 * 单独判定常量——progress 不是 lifecycle phase 切换，而是 phase=start 期间
 * 的进度快照流。
 */
export const TOOL_PROGRESS_NOTICE_TYPE = 'tool_progress' as const

export function isToolProgressNoticeType(noticeType: string | undefined): boolean {
  return noticeType === TOOL_PROGRESS_NOTICE_TYPE
}

function parseToolPresentation(value: unknown): ToolPresentation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const rec = value as Record<string, unknown>
  const kind = strOpt(rec.kind)
  if (!kind) return undefined
  const data = rec.data
  return {
    kind,
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? { data: data as Record<string, unknown> }
      : {}),
  }
}

// ─── Error 文案提取链（W4a R2-P0-1 修复——从老 toolHandler.ts 迁移）──
//
// 这些函数全是纯 helper，与 daemon 协议无关，原本就在老 toolHandler.ts 内
// `parseJsonObject` / `extractEnvelopeErrorMessage` / `stripToolUseErrorTag` /
// `parseToolUseErrorKind` / `translateToolErrorKind`。W4a A 节删 toolHandler.ts
// 时随之消失——这里整体搬过来不动语义（让 GenericToolCard / ErrorBanner 的
// 用户可读文案不退化）。

const TOOL_USE_ERROR_RE = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/
const TOOL_USE_ERROR_KIND_RE = /^kind:\s*(\w+)/m

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  return undefined
}

function extractEnvelopeErrorMessage(value: unknown): string | undefined {
  const parsed = parseJsonObject(value)
  if (!parsed) return undefined
  if (parsed.success !== false) return undefined
  return strOpt(parsed.error)
}

function stripToolUseErrorTag(text: string): string {
  const match = TOOL_USE_ERROR_RE.exec(text)
  return match ? match[1].trim() : text
}

function parseToolUseErrorKind(text: string): string | undefined {
  const inner = TOOL_USE_ERROR_RE.exec(text)?.[1]
  if (!inner) return undefined
  const kindMatch = TOOL_USE_ERROR_KIND_RE.exec(inner)
  return kindMatch?.[1]
}

/**
 * `mode_restricted` 错误的 deny_code 提取。
 *
 * 双源策略（v2 — Phase 1 修复 P0-1，2026-05-27）：
 *   1. **优先**从 SystemNotice payload metadata 读 `deny_code`——runtime
 *      端 `tool-orchestration.ts::runJudgeFilter` 现在显式透传这条字段
 *      （主路径：D6 双通道）
 *   2. 回退从 ToolResult.content (JSON) 读 `error_kind: 'mode_restricted'`
 *      + `deny_code`——runtime 端 `planGuardDenyToToolResult` 序列化的情况
 *      （legacy / orchestration pre-check 路径，hasJudge=false 测试场景）
 *
 * 上一轮实施只走路径 (2)；runJudgeFilter 主路径走的是
 * `buildToolErrorResult('permission_denied'...)`，不含 mode_restricted JSON
 * → 6 条 `mode_restricted_<deny_code>` i18n 子键在生产路径完全死光（验收报告
 * P0-1 根因）。本 helper 接受可选的 `denyCodeHint` 参数（来自 payload
 * metadata），优先级高于 output JSON 解析。
 */
function extractModeRestrictedDenyCode(output: unknown): string | undefined {
  const parsed = parseJsonObject(output)
  if (!parsed) return undefined
  if (parsed.error_kind !== 'mode_restricted') return undefined
  const denyCode = parsed.deny_code
  return typeof denyCode === 'string' ? denyCode : undefined
}

function translateToolErrorKind(
  kind: string | undefined,
  output?: unknown,
  denyCodeHint?: string,
): string | undefined {
  if (!isTranslatableToolError(kind)) return undefined
  let key = normalizeToolErrorI18nKey(kind as string)
  if (key === 'mode_restricted') {
    // 双源：metadata 优先 → output JSON fallback
    const denyCode = denyCodeHint ?? extractModeRestrictedDenyCode(output)
    key = resolveModeRestrictedI18nKey(denyCode)
  }
  const translated = i18n.t(`chat:toolError.${key}`, { defaultValue: '' })
  if (translated) return translated
  // 子键缺失时回退到通用 mode_restricted 文案（防止 humanize 静默丢失）
  if (key.startsWith('mode_restricted_')) {
    const fallback = i18n.t('chat:toolError.mode_restricted', { defaultValue: '' })
    return fallback || undefined
  }
  return undefined
}

// ─── 主桥：从 SYSTEM_NOTICE(tool_*) payload 重建 toolEvent + agentStep ──

/**
 * 处理一条 tool lifecycle SYSTEM_NOTICE。
 *
 * 入参不做 isToolLifecycleNoticeType 守门——由 caller (`systemHandler.ts`)
 * 在 dispatch 前做过判断。
 *
 * 返回值 true 表示已处理；false 表示 payload 不完整（缺 tool_name / tool_call_id），
 * caller 应该让 SYSTEM_NOTICE 继续走 fallback 文案显示路径。
 */
export function handleToolLifecycleNotice(
  payload: Record<string, unknown>,
  ctx: HandlerContext,
): boolean {
  const noticeType = strOpt(payload.notice_type)
  const phase = TOOL_LIFECYCLE_NOTICE_PHASE[noticeType ?? '']
  if (!phase) return false

  const toolName = strOpt(payload.tool_name)
  const toolCallId = strOpt(payload.tool_call_id)
  if (!toolName || !toolCallId) {
    log.warn('[toolLifecycle] missing tool_name / tool_call_id', { noticeType, toolName, toolCallId })
    return false
  }

  const { sessionId, get } = ctx
  const hideTodoInit = shouldHideTodoInitEvent(toolName, phase, payload)

  log.debug(`▶ ${noticeType} tool=${toolName} call_id=${toolCallId.slice(0, 12)}`)

  const now = Date.now()
  // 字段级 merge（W14 race）：start 时拿当前数组里有没有同 id 的 existing
  // 决定 startedAt——少数极端时序下 pre_started_completed 早于 pre_started_started
  // 到达 renderer，existing 已就位 → 沿用其 startedAt 让 durationMs 准。
  // 走 getEffectiveToolEventForSession 是因为 _pendingTools 单帧内可能还
  // 没 flush，单读 toolEventsBySessionId 会拿不到。
  const existingTool = get().getEffectiveToolEventForSession(sessionId, toolCallId)
  // ：重复 tool_started / pre_started_exec_started / WS replay 都不得刷新
  // startedAt——否则 ImageGeneratingCard 假进度锚点被前移，进度条到 ~30% 归零再播。
  const startedAt = existingTool?.startedAt ?? now
  const durationMs = phase !== 'start' && existingTool?.startedAt
    ? now - existingTool.startedAt
    : num(payload.duration_ms)

  // input / output / error 抽取链与老 toolHandler.handleTool 1:1。
  // W4a 三轮 A-P1-4 修复：phase=end/error 时 daemon payload 不带 input/input_summary
  // （tool-orchestration.ts:1696-1700），summarizeToolInput(toolName, undefined)
  // 返回空串覆盖 phase=start 写的真 inputSummary。fallback 沿用 existingTool.inputSummary
  // 与老 toolHandler L132-134 行为 1:1 对齐。outputSummary 同理 fallback。
  const inputSummary =
    strOpt(payload.input_summary)
    || summarizeToolInput(toolName, payload.input)
    || existingTool?.inputSummary
  //  fence 后移：注入扫描命中改由 runtime lifecycle payload 的结构化
  // `suspicious` 字段承载（canonical output 不再带 fence 头，属性提取对新
  // 数据恒 miss）；fence 头提取保留作为老数据（已落库 fenced output）兜底。
  const suspicious = payload.suspicious === true || extractToolOutputFenceSuspicious(payload.output)
  const unwrappedOutput = unwrapToolOutputFence(payload.output)
  const outputSummary = phase === 'end'
    ? (
      strOpt(payload.output_summary)
      || summarizeToolOutput(toolName, unwrappedOutput)
      || existingTool?.outputSummary
    )
    : undefined
  const envelopeError = phase === 'error'
    ? extractEnvelopeErrorMessage(unwrappedOutput) || extractEnvelopeErrorMessage(payload.error)
    : undefined
  const rawToolError = phase === 'error'
    ? strOpt(payload.error_message)
      || envelopeError
      || strOpt(payload.error)
      || (typeof unwrappedOutput === 'string' ? unwrappedOutput : undefined)
      || strOpt(payload.output_summary)
    : undefined
  const budgetSkipped = payload.budget_skipped === true
  const payloadErrorKind = strOpt(payload.error_kind)
  const parsedKind = phase === 'error' && rawToolError ? parseToolUseErrorKind(rawToolError) : undefined
  const errorKind = payloadErrorKind
    || (budgetSkipped ? 'budget_skipped' : undefined)
    || parsedKind
  // P0-1 修复（2026-05-27）：mode_restricted 子键解析双源
  //   - 优先用 payload.deny_code（runtime tool-orchestration 主路径透传）
  //   - 回退到 unwrappedOutput JSON 解析（legacy planGuardDenyToToolResult 路径）
  // 见 `translateToolErrorKind` doc-comment 详细解释。
  const payloadDenyCode = strOpt(payload.deny_code)
  const translatedToolError = translateToolErrorKind(
    errorKind,
    unwrappedOutput ?? payload.output ?? rawToolError,
    payloadDenyCode,
  )
  const toolError = translatedToolError ?? (rawToolError ? stripToolUseErrorTag(rawToolError) : undefined)

  const runId = strNull(payload.run_id)
  const intent = extractToolIntent(payload) ?? existingTool?.intent
  const presentation = parseToolPresentation(payload.presentation) ?? existingTool?.presentation

  // IPC / WS 双通道可能把同一次调用重放成「completed 先到，started 后到」。后到
  // 的 start 只能补齐 input / presentation，绝不能把终态降回 running，更不能用
  // `output: undefined` 擦掉永久图片产物结果。这里单独收敛后直接返回，避免重复
  // 创建 running step 或推进 runState。
  const isStartedReplayAfterTerminal = phase === 'start'
    && (existingTool?.phase === 'end' || existingTool?.phase === 'error')
  if (!hideTodoInit && isStartedReplayAfterTerminal && existingTool) {
    get().upsertToolEventForSession(sessionId, {
      id: toolCallId,
      runId: runId || undefined,
      toolName,
      phase: existingTool.phase,
      input: payload.input,
      inputSummary,
      intent,
      timestamp: existingTool.timestamp,
      startedAt: existingTool.startedAt,
      presentation,
    })
    return true
  }

  if (!hideTodoInit) {
    // **2026-05-17 dogfood Review P0-3**：phase=end/error 时显式清 progress 字段。
    // tool_progress notice 的 partial stdout 是命令运行中的中间帧，命令结束后
    // 这帧已无意义。upsert merge 在"未传字段沿用旧值"策略下，如果不显式
    // `progress: undefined`，旧的 progress.stdout 会跟 final output 同时存在；
    // 当某 race 让 ToolUseBlockView 的 `entry.finalized` 还在 false 但 lifecycle
    // 已 phase=end 时，`lifecycleProgressSnapshot` 仍然返回旧 progress（被
    // `lifecycleFinalOutput` 的 finalized 守门挡住，反而走旧 progress 分支），
    // 用户看到的是过期的中间帧而不是已完成结果。
    const clearProgressOnTerminal = phase === 'end' || phase === 'error'
    get().upsertToolEventForSession(sessionId, {
      id: toolCallId,
      runId: runId || undefined,
      toolName,
      phase,
      input: payload.input,
      output: unwrappedOutput,
      error: toolError,
      timestamp: now,
      durationMs,
      inputSummary,
      intent,
      outputSummary,
      startedAt,
      presentation,
      budgetSkipped,
      errorKind,
      suspicious: suspicious || undefined,
      // 注意：spread 一个 `progress: undefined` 进 `event` —— 与 P0-2 retryTool
      // 同款语义，让 upsertToolEventForSession 的 merge 把旧 progress 擦掉。
      ...(clearProgressOnTerminal ? { progress: undefined } : {}),
    })

    const steps = get().agentStepsBySessionId[sessionId] ?? []
    const lastThinking = [...steps].reverse().find(s => s.type === 'thinking' && s.status === 'running')
    if (lastThinking && phase === 'start') {
      get().updateAgentStepForSession(sessionId, lastThinking.id, {
        status: 'done',
        durationMs: now - lastThinking.timestamp,
      })
    }

    if (phase === 'start') {
      const toolStepId = `tool-${toolCallId}`
      const existingToolStep = steps.find(s => s.id === toolStepId)
      if (!existingToolStep) {
        const displayName = humanizeToolName(toolName)
        const step: AgentStep = {
          id: toolStepId,
          type: 'tool_start' as AgentStepType,
          title: i18n.t('chat:agentSteps.toolCall', { name: displayName }),
          detail: inputSummary || undefined,
          status: 'running' as AgentStepStatus,
          timestamp: now,
          toolName,
          toolCallId,
        }
        get().pushAgentStepForSession(sessionId, step)
      }
    } else if (phase === 'end' || phase === 'error') {
      get().updateAgentStepForSession(sessionId, `tool-${toolCallId}`, {
        status: phase === 'error' ? ('error' as AgentStepStatus) : ('done' as AgentStepStatus),
        durationMs,
        detail: phase === 'error' ? toolError : (outputSummary || undefined),
      })
    }
  }

  // ：todo 完成不再写任何 todo 状态——清单纯从 message.blocks 的
  // todo block 派生（deriveTodoTimeline）。lifecycle 只负责 runState /
  // agentStep 更新，不再接管待办列表。

  // runState 切换：第一条 tool_started 触发 planning→tool_calls；end/error 时
  // 递增 completedToolCalls（hideTodoInit 路径不计——todo 不算用户感
  // 知的"工具调用"，UX 上是隐藏的初始化）。
  const currentRunState = get().runStateBySessionId[sessionId]
    ?? { phase: 'idle' as const, completedToolCalls: 0, totalToolCalls: 0 }
  if (phase === 'start' && currentRunState.phase === 'planning') {
    get().updateRunStateForSession(sessionId, { phase: 'tool_calls' })
  }
  if ((phase === 'end' || phase === 'error') && !hideTodoInit) {
    get().updateRunStateForSession(sessionId, {
      completedToolCalls: currentRunState.completedToolCalls + 1,
    })
  }

  return true
}

/**
 * **2026-05-17 streaming tool_progress** —— 长跑命令期间 ShellCap 通过
 * `onProgress` 回调每 5s 或 1KB 触发的 partial stdout snapshot 处理器。
 *
 * 业务定位：foreground 长命令（npm install / pytest / build）跑 30 秒里，前端
 * TerminalCard 不能 spinner 黑屏——本 handler 把 SYSTEM_NOTICE
 * `notice_type='tool_progress'` payload 累积到对应 ToolEvent.progress，让
 * `ToolUseBlockView` 在 phase=start 期间也能拿到 partial stdout 喂给
 * TerminalCard 实时刷 body。
 *
 * **不动 phase / agentStep / runState**：progress 是"已开始未结束"期间的中间
 * 帧，不是状态切换；agentStep 维度仍在跑（tool_start 状态），不需要补 step；
 * runState `completedToolCalls` 也不递增。
 *
 * **不进 LLM context**：本 handler 只写 lifecycle event store（前端 UI 用），
 * 不进 contentBlocksBySessionId（LLM context 源）。LLM 仍按 Anthropic 协议
 * 看 atomic tool_result，零协议侵入。
 *
 * 返回值：true=已处理，false=payload 不完整跳过。
 */
export function handleToolProgressNotice(
  payload: Record<string, unknown>,
  ctx: HandlerContext,
): boolean {
  const toolName = strOpt(payload.tool_name)
  const toolCallId = strOpt(payload.tool_call_id)
  if (!toolName || !toolCallId) {
    log.warn('[toolProgress] missing tool_name / tool_call_id', { toolName, toolCallId })
    return false
  }

  const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
  const outputBytes = num(payload.output_bytes) ?? 0
  const truncated = payload.truncated === true
  const capturedAt = num(payload.captured_at) ?? Date.now()
  const progressSessionId = strOpt(payload.session_id)
  const progressPid = num(payload.pid)
  const progressOutputFile = strOpt(payload.output_file)
  const progressCommand = strOpt(payload.command)

  const { sessionId, get } = ctx
  // 维持现有 ToolEvent 的 phase / startedAt / inputSummary 等字段不变（upsert
  // 的字段级 merge 由 upsertToolEventForSession 保证：未传字段保持上次值）。
  // 仅追加/覆盖 progress 这一个新字段。
  const existing = get().getEffectiveToolEventForSession(sessionId, toolCallId)
  // 终态后到达的迟到 progress 帧直接丢弃（bugbot ）：lifecycle end/error
  // 已清 progress，复活过期的 partial stdout 会在 final output 缺失时闪现假运行。
  if (existing?.phase === 'end' || existing?.phase === 'error') {
    log.debug(`▶ tool_progress dropped (already terminal) tool=${toolName} call_id=${toolCallId.slice(0, 12)}`)
    return true
  }
  get().upsertToolEventForSession(sessionId, {
    id: toolCallId,
    toolName,
    // phase 仍维持 existing 的状态（通常是 'start'）。新建 ToolEvent 的极端
    // 时序——progress 在 tool_started 之前到达——按 'start' 兜底；后续 lifecycle
    // notice 到达时会按真实 phase 覆盖。
    phase: existing?.phase ?? 'start',
    timestamp: capturedAt,
    startedAt: existing?.startedAt,
    progress: {
      stdout,
      outputBytes,
      truncated,
      capturedAt,
      ...(progressSessionId ? { sessionId: progressSessionId } : {}),
      ...(progressPid != null ? { pid: progressPid } : {}),
      ...(progressOutputFile ? { outputFile: progressOutputFile } : {}),
      ...(progressCommand ? { command: progressCommand } : {}),
    },
  })

  log.debug(`▶ tool_progress tool=${toolName} call_id=${toolCallId.slice(0, 12)} bytes=${outputBytes} truncated=${truncated}`)

  return true
}

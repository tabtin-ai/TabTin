/**
 * Miscellaneous event handler — processes TODO, SSH_OUTPUT, COMPACTION,
 * and DONE events.
 */

import i18n from '@/i18n'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
//  批次 14：`engine/types` 子路径随 types.ts 拆分为 contracts/ 已下线，
// 改走 `engine` barrel 的 type-only import（esbuild 阶段 elide，不进 vite 模块图）。
import type { CompactionMode } from '@tabtin/agent-runtime/engine'
import type { AgentStepType, AgentStepStatus } from '../../shared/types'
import type { Payload } from '../../shared/helpers'
import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'
import { getChatClient } from '@/services/chatApi'
import { useChatStore } from '@/stores/chat/useChatStore'
import { applyDoneUsage } from './streamTokenUsage'
import { finalizeDoneEvent } from './doneEventFinalizer'
import { refreshPromotionCreditAfterDone } from './promotionCreditRefresh'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function handleMiscEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId, get } = ctx
  const eventType = message.type

  //  / ：Electron 已不消费 TODO 事件——待办清单纯从 message.blocks
  // 的 todo block 派生（deriveTodoTimeline）。保留 swallow：iOS/Android
  // 仍依赖该事件（见 ），不可在 relay 侧直接丢弃。
  if (eventType === AgentStreamEvents.TODO) {
    return
  }

  if (eventType === AgentStreamEvents.SSH_OUTPUT) {
    const payload = message.payload || {}
    const sshSessionSteps = get().agentStepsBySessionId[sessionId] ?? []
    const lastSshStep = [...sshSessionSteps].reverse().find(
      s => s.toolName === 'ssh_execute' && s.status === 'running',
    )
    if (lastSshStep && payload.data) {
      const prev = lastSshStep.detail || ''
      const prefix = payload.server_name ? `[${payload.server_name}] ` : ''
      const chunk = payload.data
      get().updateAgentStepForSession(sessionId, lastSshStep.id, {
        detail: prev ? prev + chunk : prefix + chunk,
      })
    }
    return
  }

  if (eventType === AgentStreamEvents.COMPACTION) {
    handleCompaction(message, ctx)
    return
  }

  if (eventType === AgentStreamEvents.DONE) {
    const payload = (message.payload ?? {}) as Record<string, unknown>
    // ：终态错误只走 finalizeDoneEvent（唯一写气泡出口），不再 inject。
    finalizeDoneEvent(sessionId, payload)
    refreshPromotionCreditAfterDone(sessionId)

    // ：session token 的 DONE 差额校正。观察端（跨窗口 / 跨设备旁观）没有
    // sendMessageAction.onDone 回调，此前只能等 lifecycle.end 的 GET session
    // 兜底。这里与 onDone 共用同一个按 trace_id 幂等的入口——发起端两处谁先到
    // 谁生效，不双计。只处理带 trace_id 的本地 runtime DONE；历史云端路径
    // （无 trace_id、无法幂等）保持 onDone 单点消费的原行为。
    const doneUsage = payload.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined
    const doneTraceId = typeof payload.trace_id === 'string' && payload.trace_id ? payload.trace_id : undefined
    if (doneUsage && doneTraceId) {
      applyDoneUsage(sessionId, doneTraceId, doneUsage)
    }

    // PRD 06 §5.5.3：push_report / proactive_report_cold 汇报到达后清除 pending badge
    const turnType = payload.turn_type as string | undefined
    if (turnType === 'push_report' || turnType === 'proactive_report_cold') {
      if (ctx.spaceId) {
        void import('@/stores/usePendingReportStore').then(({ usePendingReportStore }) => {
          usePendingReportStore.getState().clearPendingCount(ctx.spaceId!)
        })
      }
    }
    return
  }
}

/**
 * FR-05: 前端可能收到的 compaction mode 字符串。
 *
 * - 本地 Runtime 的合法取值完全由 `@tabtin/agent-runtime` 的 `CompactionMode`
 *   类型单点定义（SSoT）——TypeScript 通过 import 保证两端同步，新增 mode
 *   编译期即会提示要在 `formatCompactionTitle` 扩展分支。
 * - `LegacyCloudCompactionMode` 是历史云端 orchestration 路径仍在发出的字面量，
 *   需要前端兼容以维持跨端一致体验。
 */
type LegacyCloudCompactionMode = 'auto_condense' | 'emergency'
type CompactionModeName = CompactionMode | LegacyCloudCompactionMode

/**
 * FR-11：把 Runtime 新字段（`messages_before/after` / `tokens_before/after` /
 * `tool_uses_retained`）和云端历史字段（`message_count_before/after` /
 * `total_chars_before/after` / `removed_chars`）拍平为一个统一的展示视图。
 *
 * - 新字段优先（Runtime 走 SSoT），缺失时回落老字段；
 * - 缺失字段一律返回 `undefined`，由调用方按 `?` 展示，避免误把 0 当真实值。
 */
interface NormalizedCompactionStats {
  messagesBefore?: number
  messagesAfter?: number
  tokensBefore?: number
  tokensAfter?: number
  tokensFreed?: number
  toolUsesRetained?: number
  summaryLength?: number
  /** 云端历史字段——chars 维度，本地 Runtime 不发。 */
  charsBefore?: number
  charsAfter?: number
}

function pickNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
  }
  return undefined
}

function normalizeCompactionStats(stats: Payload): NormalizedCompactionStats {
  return {
    messagesBefore: pickNumber(stats.messages_before, stats.message_count_before),
    messagesAfter: pickNumber(stats.messages_after, stats.message_count_after),
    tokensBefore: pickNumber(stats.tokens_before),
    tokensAfter: pickNumber(stats.tokens_after),
    tokensFreed: pickNumber(stats.tokens_freed),
    toolUsesRetained: pickNumber(stats.tool_uses_retained),
    summaryLength: pickNumber(stats.summary_length),
    charsBefore: pickNumber(stats.total_chars_before),
    charsAfter: pickNumber(stats.total_chars_after),
  }
}

function formatCompactionTitle(mode: CompactionModeName | string | undefined, stats: NormalizedCompactionStats): string {
  const before = stats.messagesBefore ?? '?'
  const after = stats.messagesAfter ?? '?'

  switch (mode) {
    case 'auto':
    case 'auto_condense':
    case 'reactive':
      return i18n.t('chat:agentSteps.compactionSmart', { before, after })
    case 'emergency':
    case 'emergency_blocking':
      return i18n.t('chat:agentSteps.compactionEmergency', { kept: after })
    case 'recovery_413':
      return i18n.t('chat:agentSteps.compactionRecovery413', {
        defaultValue: '上下文超长，已自动压缩后重试',
      })
    case 'hard_trim':
      return i18n.t('chat:agentSteps.compactionHardTrim', {
        defaultValue: '上下文已紧急裁剪到约 50% 以恢复对话',
      })
    case 'truncate_head':
      return i18n.t('chat:agentSteps.compactionTruncateHead', {
        defaultValue: '对话压缩（裁剪历史）',
      })
    case 'recovery_413_failed':
      return i18n.t('chat:agentSteps.compactionRecovery413Failed', {
        defaultValue: '上下文压缩后仍然超长，请开始新对话',
      })
    case 'native':
    case 'micro':
    default:
      return i18n.t('chat:agentSteps.compactionComplete')
  }
}

/**
 * FR-11 detail 文案。优先展示 token 维度（Runtime 真实数据），缺失时
 * 回落 chars（云端老字段）。三类信息按可用性叠加：
 *   1. 消息数变化（必有，前端基本不会缺）
 *   2. tokens 变化（Runtime 5 个 mode 均填——reactive / auto / emergency_blocking
 *      由 `compaction-orchestrator.ts` 填；recovery_413 / hard_trim 由
 *      `query.ts` R1 恢复路径填，命名口径完全一致 snake_case）
 *   3. 保留的 tool_use 数（Runtime 独有，云端老路径不填——默认隐藏）
 */
function formatCompactionDetail(stats: NormalizedCompactionStats): string {
  const segments: string[] = []

  if (stats.messagesBefore !== undefined || stats.messagesAfter !== undefined) {
    segments.push(
      i18n.t('chat:agentSteps.compactionDetailMessages', {
        before: stats.messagesBefore ?? '?',
        after: stats.messagesAfter ?? '?',
        defaultValue: '消息: {{before}} → {{after}} 条',
      }),
    )
  }

  if (stats.tokensBefore !== undefined || stats.tokensAfter !== undefined || stats.tokensFreed !== undefined) {
    const before = stats.tokensBefore !== undefined ? Math.round(stats.tokensBefore / 1000) : '?'
    const after = stats.tokensAfter !== undefined ? Math.round(stats.tokensAfter / 1000) : '?'
    const freed = stats.tokensFreed !== undefined ? Math.round(stats.tokensFreed / 1000) : '?'
    segments.push(
      i18n.t('chat:agentSteps.compactionDetailTokens', {
        before,
        after,
        freed,
        defaultValue: 'Token: {{before}}K → {{after}}K（释放 {{freed}}K）',
      }),
    )
  } else if (stats.charsBefore !== undefined || stats.charsAfter !== undefined) {
    // 仅老云端路径会进这里，对应原 compactionDetail 的 chars 维度
    const charsBefore = stats.charsBefore !== undefined ? Math.round(stats.charsBefore / 1000) : '?'
    const charsAfter = stats.charsAfter !== undefined ? Math.round(stats.charsAfter / 1000) : '?'
    segments.push(
      i18n.t('chat:agentSteps.compactionDetailChars', {
        charsBefore,
        charsAfter,
        defaultValue: '体积: {{charsBefore}}K → {{charsAfter}}K 字符',
      }),
    )
  }

  if (stats.toolUsesRetained !== undefined) {
    segments.push(
      i18n.t('chat:agentSteps.compactionDetailToolUses', {
        count: stats.toolUsesRetained,
        defaultValue: '保留 {{count}} 个工具调用',
      }),
    )
  }

  return segments.join(' | ')
}

function handleCompaction(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId, get } = ctx
  const payload = message.payload || {}
  const stats = normalizeCompactionStats((payload.stats || {}) as Payload)
  const phase = payload.phase as string
  const mode = payload.mode as CompactionModeName | string | undefined

  if (phase === 'start') {
    const stepId = `compaction-${sessionId}`
    get().pushAgentStepForSession(sessionId, {
      id: stepId,
      type: 'compaction' as AgentStepType,
      title: i18n.t('chat:agentSteps.compactionInProgress'),
      detail: '',
      status: 'running' as AgentStepStatus,
      timestamp: Date.now(),
    })
    return
  }

  if (phase === 'end') {
    const stepId = `compaction-${sessionId}`

    // W4.2 修复：emergency_blocking + tokens_freed === 0 时静默跳过弹文案。
    //
    // 背景：runtime emergency 路径在压力评估错误（旧 anchor 双算 bug）或本轮
    // 真无可压缩内容（消息全在 protected tail 内）时会 emit `emergency_blocking`
    // 事件但 `tokens_freed === 0`——此时弹"上下文已紧急截断，仅保留最近 X 条
    // 消息"是**虚假信号**（用户看到截断告警但实际啥也没动，跟 LLM 实发数字差
    // 8 倍 → dogfood W4 第二轮用户痛点）。
    //
    // 选静默而非"上下文压力检测但无可压缩内容"toast 的产品决策：
    //   1. emergency 是系统状态自发触发，用户没做任何操作 → 弹 toast 制造噪声
    //   2. 若真有压力，下一轮 LLM 请求会走 413 recovery 路径，那条链路有专属
    //      `recovery_413` 文案告知用户
    //   3. dogfood 场景下 Bug 1+2 修复后此类事件应几近消失，本守卫是 defense-in-depth
    //
    // 仍清理 running step（避免 spinner 卡死），title 改为中性完成态
    // "上下文检查完成（无需压缩）"，避免出现 status='done' 但 title 仍是
    // "正在压缩中..." 的违和（review P1：用户会以为系统假装在做事）。
    const isEmergencyNoOp =
      (mode === 'emergency_blocking' || mode === 'emergency')
      && stats.tokensFreed === 0
    if (isEmergencyNoOp) {
      const steps = get().agentStepsBySessionId[sessionId] ?? []
      const existingStep = steps.find(s => s.id === stepId)
      const neutralTitle = i18n.t('chat:agentSteps.compactionNoOp', {
        defaultValue: '上下文检查完成（无需压缩）',
      })
      if (existingStep) {
        get().updateAgentStepForSession(sessionId, stepId, {
          title: neutralTitle,
          status: 'done' as AgentStepStatus,
        })
      }
      console.debug(
        '[Chat] emergency compaction skipped (freed=0, neutral title):',
        mode,
        stats,
      )
      return
    }

    const endTitle = formatCompactionTitle(mode, stats)
    const endDetail = formatCompactionDetail(stats)

    const steps = get().agentStepsBySessionId[sessionId] ?? []
    const existingStep = steps.find(s => s.id === stepId)
    if (existingStep) {
      get().updateAgentStepForSession(sessionId, stepId, {
        title: endTitle,
        // FR-11：phase=end 路径补 detail，让用户能看到压缩前后量化数据。
        // 旧实现只更新 title/status，detail 的展示信息丢失。
        detail: endDetail,
        status: 'done' as AgentStepStatus,
      })
    } else {
      get().pushAgentStepForSession(sessionId, {
        id: stepId,
        type: 'compaction' as AgentStepType,
        title: endTitle,
        detail: endDetail,
        status: 'done' as AgentStepStatus,
        timestamp: Date.now(),
      })
    }
    persistAutoCompactionCheckpoint(sessionId, payload)
    return
  }

  console.log('[Chat] Context compaction event:', mode, stats)
  const isSmart = mode === 'auto' || mode === 'auto_condense' || mode === 'reactive'
  get().pushAgentStepForSession(sessionId, {
    id: `compaction-${Date.now()}`,
    type: 'compaction' as AgentStepType,
    title: isSmart
      ? i18n.t('chat:agentSteps.compactionSmart', { before: stats.messagesBefore ?? '?', after: stats.messagesAfter ?? '?' })
      : i18n.t('chat:agentSteps.compactionBasic', { chars: (payload.stats as Payload | undefined)?.removed_chars || 0 }),
    detail: formatCompactionDetail(stats),
    status: 'done' as AgentStepStatus,
    timestamp: Date.now(),
  })
}

function persistAutoCompactionCheckpoint(
  sessionId: string,
  payload: Payload,
): void {
  const summary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  const compactedUpToMessageId = typeof payload.compacted_up_to_message_id === 'string'
    ? payload.compacted_up_to_message_id
    : ''
  if (!summary || !compactedUpToMessageId || !UUID_RE.test(compactedUpToMessageId)) return

  const existing = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  if (existing.some(message => (
    message.message_kind === 'compaction_summary'
    && (message.metadata as Record<string, unknown> | null | undefined)?.compacted_up_to_message_id === compactedUpToMessageId
  ))) {
    return
  }

  getChatClient().messages.createCompactionCheckpoint(sessionId, {
    summary,
    compacted_up_to_message_id: compactedUpToMessageId,
    source: 'auto',
    stats: (payload.stats && typeof payload.stats === 'object') ? payload.stats as Record<string, unknown> : null,
    client_event_id: crypto.randomUUID(),
  }).then((response) => {
    useChatStore.getState().upsertMessage(sessionId, response.message)
  }).catch((error) => {
    console.warn('[Chat] failed to persist auto compaction checkpoint:', error)
  })
}

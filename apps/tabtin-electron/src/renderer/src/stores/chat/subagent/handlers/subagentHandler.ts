/**
 * Subagent event handler — processes subagent lifecycle + 协调事件。
 *
 * 历史：早期只识别 4 件套（PROGRESS / STARTED / FAILED / COMPLETED），但
 * streamMessageHandler 用 `eventType.startsWith('agent.stream.subagent_')`
 * 把 _所有_ subagent_* 事件路由进来 —— 等于 PRD 06 §5.1.3-5 的
 * SUBAGENT_HITL_REQUIRED / SUBAGENT_QUEUED / SUBAGENT_MODEL_CALL
 * 三事件**全部 silent drop**（实证 grep 0 处消费 + fallback 把它们当成
 * status='running' 写入 SubagentRun，会把已 completed 的子 Agent 状态
 * 错乱回滚成 running）。SPEAKER_PUSH_MESSAGE 不在 subagent_* 前缀里，
 * 由 streamMessageHandler 显式路由进本 handler，否则**完全不进任何分支**。
 *
 * 当前实证结论（W4.5-A3 实施时）：
 *   - daemon `packages/agent-runtime/src/` 0 处 emit 这 4 个事件——是
 *     **预留事件**（PRD 06 设计、wire 已注册、Django relay 白名单已通），
 *     daemon / Django 当前都未真实调用 publisher。
 *   - 但 wire 层已暴露 + 跨平台通路打通——任意时刻 daemon 端 PRD 06
 *     落地（哪怕灰度）就会真发，前端必须**已经接住**而不是 silent drop。
 *
 * 本 handler 处理策略：
 *   - SUBAGENT_HITL_REQUIRED → **双路**：
 *       (a) push agentStep('system_notice', noticeType='subagent_hitl_required')
 *           作为 banner 兜底；
 *       (b) **接通 ApprovalPanel**——把 payload 映射到
 *           `useChatStore.pendingApprovalBySessionId[sessionId]`，
 *           让 ChatContent 渲染高视觉权重的批准入口（按钮 / 倒计时 /
 *           runtime mode）。仅在 payload 带 `approval_id` 时设置 pending
 *           （batchId 缺失则提交无路由——退化为只 banner，避免悬挂卡片）。
 *           **不动 SubagentRun**（保留已有 status；types.ts 不在本 Wave
 *           only-touch 范围内，未来引入 SpeakerIdentity.status='awaiting_approval'
 *           时再补 upsert）。
 *   - SUBAGENT_QUEUED → upsert SubagentRun status='queued'（与 W4 SubagentStatus
 *     枚举 'queued' 对齐，让卡片显示 Clock 灰 + "排队中"），不 push step
 *     （SUBAGENT_STARTED 到达时会 upsert status='running' 自动切走）。
 *   - SUBAGENT_MODEL_CALL → 仅 logger.debug（PRD 06 §5.3.2 明确 observability，
 *     不进对话流；W4.5 决策 UI 不展示）。
 *   - SPEAKER_PUSH_MESSAGE → push agentStep('system_notice',
 *     noticeType='speaker_push_message')，主 Agent 主动汇报 inline 显示。
 *   - default → logger.debug 防 silent drop（防未来新增 subagent_* 事件没人接）。
 *
 * **W4.5-A3 P0 修复（2026-05-12）**：
 * §0.6.1 跟踪表里 W45-A3 P0「HITL ApprovalPanel 没接通」修复——之前只 push
 * system_notice agentStep（banner 文字提示），缺真正的"高视觉权重审批入口"。
 * 本 handler 现在通过 `useChatStore.setState` 直接写入 pendingApprovalBySessionId，
 * 让 ChatContent.tsx:309 的 selector 立即捕获并渲染 ApprovalPanel——按钮
 * （批准/拒绝）、倒计时（expires_at）、子 Agent 描述 + risk_level 都齐活。
 *
 * 用户点击 ApprovalPanel 提交时走 approvalSlice.submitHitlBatch(batchId, decisions[])
 * IPC，daemon 端 LocalPermissionHandler.requestPermissionsBatch 用 batchId 索引
 * pending resolver。本路径与普通 `APPROVAL_REQUESTED` 公用同一个提交 IPC——
 * daemon 端实施时 batch resolver 注册 + approval_id 作为 batch key 即可。
 */

import i18n from '@/i18n'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import type { SpeakerIdentity } from '@tabtin/agent-wire'
import type {
  AgentStepType,
  AgentStepStatus,
  ApprovalRequestState,
  SubagentStatus,
  SubagentRun,
} from '../../shared/types'
import {
  payloadStr as str,
  payloadStrOpt as strOpt,
  payloadNum as num,
  payloadBool as bool,
} from '../../shared/helpers'
import type { AgentStreamMessage, HandlerContext } from '../../stream/handlers/streamHandlerTypes'
import { computeApprovalCanResolve, normalizeTeamSpaceExecution } from '../../hitl/handlers/hitlStreamHandlers'
import { useSpeakerRegistryStore } from '../../../useSpeakerRegistryStore'
import { useChatStore } from '../../useChatStore'
import { useSubagentLiveStore } from '../../../subagentLive'
import { createLogger } from '@/utils/logger'

const log = createLogger('E2E:Subagent')

const VALID_SOURCES: readonly string[] = ['template', 'inherit', 'blank']
const VALID_INHERIT_MODES: readonly string[] = ['full', 'filtered', 'summary', 'none']

function isTerminalSubagentStatus(status: SubagentStatus | undefined): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function normalizeSubagentIdentity(payload: Record<string, unknown>): {
  runId: string
  toolCallId?: string
} {
  return {
    runId: str(payload.run_id) || str(payload.subagent_run_id),
    toolCallId: strOpt(payload.tool_call_id) ?? strOpt(payload.parent_tool_call_id),
  }
}

function findSubagentRunForEvent(
  runs: readonly SubagentRun[],
  subagentRunId: string,
  toolCallId: string | undefined,
  incomingStatus?: SubagentStatus,
): SubagentRun | undefined {
  if (toolCallId) {
    const exact = runs.find(r =>
      r.subagentRunId === subagentRunId
      && r.parentToolCallId === toolCallId,
    )
    if (exact) return exact

    const parentless = runs.find(r =>
      r.subagentRunId === subagentRunId
      && !r.parentToolCallId
      && (!isTerminalSubagentStatus(r.status) || r.status === incomingStatus)
    )
    if (parentless) return parentless

    return undefined
  }

  for (let i = runs.length - 1; i >= 0; i -= 1) {
    if (runs[i].subagentRunId === subagentRunId) return runs[i]
  }
  return undefined
}

function asValidSource(v: string | undefined): SpeakerIdentity['source'] {
  return v && VALID_SOURCES.includes(v) ? v as SpeakerIdentity['source'] : undefined
}
function asValidInheritMode(v: string | undefined): SpeakerIdentity['inherit_mode'] {
  return v && VALID_INHERIT_MODES.includes(v) ? v as SpeakerIdentity['inherit_mode'] : undefined
}

/**
 * Group/Mission：从事件 payload 提取子 Agent 角色名（主 Agent 经 `agent` 工具
 * `role` 参数指定）。优先读 `payload.speaker.role`（agent-tool 把 role 写进
 * SpeakerIdentity 并 spread 进各 SUBAGENT_* 事件）；回落顶层 `payload.role`。
 */
function extractRole(payload: Record<string, unknown>): string | undefined {
  const speaker = payload.speaker as Partial<SpeakerIdentity> | undefined
  const fromSpeaker = typeof speaker?.role === 'string' ? speaker.role.trim() : ''
  if (fromSpeaker) return fromSpeaker
  const top = strOpt(payload.role)
  return top && top.trim() ? top.trim() : undefined
}

/**
 * 子 Agent 实际跑的模型由 agent-tool 写在 `payload.speaker.model`，这里回填到
 * SubagentRun，让对话内卡片能直接展示，不再只能进详情面板猜。
 */
function extractModel(payload: Record<string, unknown>): string | undefined {
  const speaker = payload.speaker as Record<string, unknown> | undefined
  const fromSpeaker = typeof speaker?.model === 'string' ? speaker.model.trim() : ''
  if (fromSpeaker) return fromSpeaker
  const top = strOpt(payload.model)
  return top && top.trim() ? top.trim() : undefined
}

/**
 * ：从事件 payload 提取「命中模板」的 template_id / 显示名（主 Agent
 * 经 `agent` 工具 `template_id` 派发时，agent-tool 把 template_id/template_name
 * 写进 SpeakerIdentity 并 spread 进各 SUBAGENT_* 事件）。回落顶层字段。
 * ad-hoc 派发时两者均为 undefined，SubagentAggregateView 不展示「源自模板」badge。
 */
function extractTemplate(payload: Record<string, unknown>): { templateId?: string; templateName?: string } {
  const speaker = payload.speaker as Partial<SpeakerIdentity> | undefined
  const idFromSpeaker = typeof speaker?.template_id === 'string' ? speaker.template_id.trim() : ''
  const nameFromSpeaker = typeof speaker?.template_name === 'string' ? speaker.template_name.trim() : ''
  const templateId = idFromSpeaker || strOpt(payload.template_id)?.trim() || undefined
  const templateName = nameFromSpeaker || strOpt(payload.template_name)?.trim() || undefined
  return { templateId, templateName }
}

/**
 * 从 SUBAGENT_STARTED payload 提取 speaker 身份并注册。
 *
 * 兼容两种 payload 形态：
 * 1. payload.speaker: SpeakerIdentity（显式携带完整身份，补齐缺失字段后注册）
 * 2. 回退：用 speaker_id + label 合成最小身份（runtime 未注入 speaker 时）
 */
function registerSpeakerFromPayload(
  sessionId: string,
  subagentRunId: string,
  payload: Record<string, unknown>,
): string | undefined {
  const rawSpeaker = payload.speaker as Partial<SpeakerIdentity> | undefined
  if (rawSpeaker?.speaker_id && rawSpeaker.display_name) {
    const speaker: SpeakerIdentity = {
      kind: 'sub_agent',
      display_short_id: rawSpeaker.speaker_id.slice(0, 4),
      status: 'running',
      started_at: Date.now(),
      ...rawSpeaker,
      speaker_id: rawSpeaker.speaker_id,
      display_name: rawSpeaker.display_name,
    }
    useSpeakerRegistryStore.getState().registerSpeaker(sessionId, speaker)
    return speaker.speaker_id
  }

  const speakerId = strOpt(payload.speaker_id)
  if (speakerId) {
    const label = strOpt(payload.label) || strOpt(payload.task)?.slice(0, 30) || speakerId.slice(0, 8)
    const shortId = speakerId.slice(0, 4)
    const syntheticSpeaker: SpeakerIdentity = {
      speaker_id: speakerId,
      kind: 'sub_agent',
      display_name: label.includes(shortId) ? label : `${label} · ${shortId}`,
      display_short_id: shortId,
      display_color: strOpt(payload.display_color),
      source: asValidSource(strOpt(payload.source)),
      template_id: strOpt(payload.template_id),
      inherit_mode: asValidInheritMode(strOpt(payload.inherit_mode)),
      status: 'running',
      started_at: num(payload.started_at) || Date.now(),
    }
    useSpeakerRegistryStore.getState().registerSpeaker(sessionId, syntheticSpeaker)
    return speakerId
  }

  return undefined
}

export function handleSubagentEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId, get } = ctx
  const eventType = message.type
  const payload = message.payload || {}

  // ── SPEAKER_PUSH_MESSAGE（PRD 06 §5.5）──────────────────────────────
  // 主 Agent 自主 push 汇报消息。**不绑 subagent_run_id**（speaker 即可），
  // payload 形态：{ speaker_id, content, ... }。当前 daemon 未 emit（预留），
  // 真实调度后 inline push 一条 system_notice 让用户看到"主 Agent 主动汇报"。
  if (eventType === AgentStreamEvents.SPEAKER_PUSH_MESSAGE) {
    const speakerId = strOpt(payload.speaker_id)
    const content = typeof payload.content === 'string' ? payload.content : ''
    if (!content) {
      log.debug('SPEAKER_PUSH_MESSAGE 无 content，忽略', {
        session: sessionId.slice(0, 8),
        speakerId,
      })
      return
    }
    // speakerLabel：优先 SpeakerRegistry 注册的 display_name（dogfood 主路径）；
    // fallback 用 "主助手 · {short_id}" 让用户在多 speaker 场景下能区分（裸 ID
    // 太硬，纯"主助手"则在并发时区分不开）；speaker_id 缺失走通用语。
    // i18n key（subagent.speakerFallback*）由 W4.5-A4 接通，先用 defaultValue。
    const registeredName = speakerId
      ? useSpeakerRegistryStore.getState().getSpeaker(sessionId, speakerId)?.display_name
      : undefined
    const speakerLabel = registeredName
      ?? (speakerId
        ? i18n.t('chat:subagent.speakerFallbackWithId', {
            defaultValue: '主助手 · {{shortId}}',
            shortId: speakerId.slice(0, 4),
          })
        : i18n.t('chat:subagent.speakerFallbackPrimary', { defaultValue: '主助手' }))
    const trimmedContent = content.replace(/\n+/g, ' ').trim()
    const title = i18n.t('chat:subagent.speakerPushTitle', {
      defaultValue: '{{speaker}} 阶段性进展',
      speaker: speakerLabel,
    })
    get().pushAgentStepForSession(sessionId, {
      id: `speaker-push-${Date.now()}`,
      type: 'system_notice' as AgentStepType,
      title,
      detail: trimmedContent,
      status: 'done' as AgentStepStatus,
      timestamp: Date.now(),
      noticeType: 'speaker_push_message',
    })
    return
  }

  if (bool(payload.observer_only) || bool(payload.trace_forwarded)) {
    log.debug('subagent observer-only 事件跳过业务状态写入', {
      session: sessionId.slice(0, 8),
      eventType,
      runId: strOpt(payload.run_id) ?? strOpt(payload.subagent_run_id),
    })
    return
  }

  const identity = normalizeSubagentIdentity(payload)
  const subagentRunId = identity.runId
  const dispatchedByRunId =
    strOpt(payload.dispatcher_run_id)
      ?? strOpt(payload.parent_run_id)
      ?? undefined
  if (!subagentRunId) {
    log.debug('subagent 事件缺 run_id/subagent_run_id，忽略', {
      session: sessionId.slice(0, 8),
      eventType,
    })
    return
  }

  // ── SUBAGENT_PROGRESS（高频；保持 fast path）──────────────────────────
  if (eventType === AgentStreamEvents.SUBAGENT_PROGRESS) {
    const prevRuns = get().subagentRunsBySessionId[sessionId] ?? []
    const existing = findSubagentRunForEvent(prevRuns, subagentRunId, identity.toolCallId, 'running')
    if (isTerminalSubagentStatus(existing?.status)) {
      // ：已终态仍可能收到迟到 progress；丢掉即可，不要每条 debug 刷屏。
      return
    }

    // P0-2：latest_tool_status 区分"工具刚启动 vs 已完成"，避免 latestSuccess
    // 残留前一步的值让头部图标视觉错乱。校验 enum 值——daemon 未来 emit 其他
    // 值（譬如 ts/old daemon 缺该字段）走 undefined 不破坏视觉。
    const rawToolStatus = strOpt(payload.latest_tool_status)
    const latestToolStatus = rawToolStatus === 'pending'
      || rawToolStatus === 'completed'
      || rawToolStatus === 'failed'
      ? rawToolStatus
      : undefined

    get().upsertSubagentRunForSession(sessionId, {
      subagentRunId,
      status: 'running',
      parentToolCallId: identity.toolCallId ?? existing?.parentToolCallId,
      dispatchedByRunId: dispatchedByRunId ?? existing?.dispatchedByRunId,
      stepCount: num(payload.step_count),
      latestTool: strOpt(payload.latest_tool),
      latestToolInput: strOpt(payload.latest_tool_input),
      latestSuccess: bool(payload.latest_success),
      latestToolStatus,
      elapsedMs: num(payload.elapsed_ms),
    })
    return
  }

  // ── SUBAGENT_HITL_REQUIRED（PRD 06 §5.1.4）─────────────────────────
  // 子 Agent 触发 HITL 审批。
  //
  // **本 handler 双路接通**（W4.5-A3 P0 修复，2026-05-12）：
  //   1. push agentStep('system_notice', noticeType='subagent_hitl_required')
  //      作为 banner 兜底（SystemNoticeBanner 已能渲染）；
  //   2. 写 useChatStore.pendingApprovalBySessionId[sessionId] = ApprovalRequestState
  //      → ChatContent.tsx selector 立即捕获 → 渲染 ApprovalPanel（高视觉
  //      权重的批准入口：批准/拒绝按钮、倒计时、子 Agent 描述、风险分级）。
  //
  // **不动 SubagentRun.status**——SubagentStatus 不含 'awaiting_approval'
  // （types.ts 在 W4.5-A1 范围）。HITL 是临时 pause，保留 running / pending
  // 已有状态；等后续 wave 引入 SpeakerIdentity.status='awaiting_approval' 时再补。
  //
  // **batchId 路由前提**：approval_id 缺失则**降级为只 banner**——pendingApproval
  // 没有 batchId 时 submitHitlBatch 找不到 resolver，会让 ApprovalPanel 卡住。
  // PRD 06 §5.1.4 设计 approval_id 必填，此分支是防御 daemon 实施 bug。
  //
  // **daemon 端协议契约**：daemon 实施时 `LocalPermissionHandler.requestPermissionsBatch`
  // 注册 pending 用 approval_id 作为 batchId key，本 handler 写入的 batchId 与
  // 之对齐——用户在 ApprovalPanel 点批准时走 `submitHitlBatch(batchId, decisions[])`
  // IPC，daemon 端按 batchId 查 resolver 即完成回环。本路径与普通
  // APPROVAL_REQUESTED 公用同一个提交通道，不引入新 IPC。
  if (eventType === AgentStreamEvents.SUBAGENT_HITL_REQUIRED) {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
    const approvalId = strOpt(payload.approval_id)
    const requiresHostPlatform = strOpt(payload.requires_host_platform)
    const prevRuns = get().subagentRunsBySessionId[sessionId] ?? []
    const existingRun = findSubagentRunForEvent(prevRuns, subagentRunId, identity.toolCallId)
    const parentToolCallId = identity.toolCallId ?? existingRun?.parentToolCallId
    const labelHint = strOpt(payload.label) || strOpt(payload.task) || subagentRunId.slice(0, 8)
    const fallbackSummary = i18n.t('chat:subagent.hitlSummaryFallback', {
      defaultValue: '子 Agent「{{label}}」请求审批',
      label: labelHint,
    })
    const summary = prompt.replace(/\n+/g, ' ').trim() || fallbackSummary
    const title = i18n.t('chat:subagent.hitlTitle', {
      defaultValue: '子 Agent「{{label}}」等待审批',
      label: labelHint,
    })
    const hostHint = requiresHostPlatform === 'electron'
      ? i18n.t('chat:subagent.hitlRequiresDesktop', { defaultValue: '请在桌面端处理' })
      : ''
    const detail = hostHint ? `${summary}（${hostHint}）` : summary

    // 第一路：push agentStep（banner 兜底）
    get().pushAgentStepForSession(sessionId, {
      id: `subagent-hitl-${approvalId ?? subagentRunId}-${Date.now()}`,
      type: 'system_notice' as AgentStepType,
      title,
      detail,
      // status='running' 跟 ApprovalPanel pendingApproval 同语义"等待审批"。
      // ApprovalPanel 决策提交后会清 pendingApproval，但 step 不会自动收尾——
      // 长期看 banner 会一直转圈直到 daemon 后续事件覆盖。已登记 P1 给后续 wave
      // （需要 SpeakerIdentity.status='awaiting_approval' + step 同步收尾）。
      status: 'running' as AgentStepStatus,
      timestamp: Date.now(),
      noticeType: 'subagent_hitl_required',
    })

    // 第二路：写 pendingApprovalBySessionId → ApprovalPanel 渲染
    // 仅在 approval_id 存在时设置——缺 batchId 的 pendingApproval 在 submit 时
    // 必失败（approvalSlice.ts:288 先查 batchId），与其让 panel 卡住不如不渲染。
    if (approvalId) {
      const expiresAt = typeof payload.expires_at === 'number' ? payload.expires_at : undefined
      const approvalTtlSeconds = expiresAt
        ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
        : (typeof payload.approval_ttl_seconds === 'number' ? payload.approval_ttl_seconds : undefined)
      const interruptedAt = expiresAt ? Math.floor(Date.now() / 1000) : undefined
      const runtimeMode = (typeof payload.runtime_mode === 'string'
        ? payload.runtime_mode
        : 'interactive') as ApprovalRequestState['runtimeMode']

      // 子 Agent HITL 是"子 Agent 整体审批"——不是 multi-tool batch；
      // actionRequests 单元素：tool_name 用子 Agent label，description 用 prompt。
      // tool_call_id 用 subagent_run_id 让 ApprovalPanel 内部 dedupe 按子 Agent
      // 标识走，不会跟其他 tool approval 串行。
      const actionRequest = {
        request_id: approvalId,
        tool_call_id: subagentRunId,
        tool_name: labelHint,
        description: prompt || fallbackSummary,
        // PRD 06 没明确风险分级；HITL 默认 medium（视觉中等权重，不抢眼到红色高危）。
        // daemon 后续 emit 真实 risk_level 字段时直接覆盖。
        risk_level: (typeof payload.risk_level === 'string' && ['low', 'medium', 'high'].includes(payload.risk_level)
          ? payload.risk_level
          : 'medium') as 'low' | 'medium' | 'high',
        ask_hint: typeof payload.ask_hint === 'object' && payload.ask_hint !== null
          ? payload.ask_hint as Record<string, unknown>
          : { summary },
        allowed_outcomes: ['allow', 'deny'] as Array<'allow' | 'deny'>,
        ...(parentToolCallId
          ? {
              subagent_context: {
                parent_tool_call_id: parentToolCallId,
                subagent_run_id: subagentRunId,
                label: labelHint,
              },
            }
          : {}),
      }

      const reviewConfig = {
        action_name: labelHint,
        allowed_decisions: ['approve', 'reject'] as Array<'approve' | 'reject'>,
      }

      const localThreadId = `chat-session-${sessionId}`
      // Project 审批遮蔽（决策 Q5）：子 Agent HITL 同样只允许执行 owner
      // 处理；payload 无 team_space_execution（Workspace）时不受限。
      const teamSpaceExecution = normalizeTeamSpaceExecution(payload.team_space_execution)
      const canResolve = computeApprovalCanResolve(teamSpaceExecution)
      const pending: ApprovalRequestState = {
        sessionId,
        threadId: localThreadId,
        batchId: approvalId,
        interactionType: 'review',
        blockingPolicy: 'hard',
        actionRequests: [actionRequest] as ApprovalRequestState['actionRequests'],
        reviewConfigs: [reviewConfig] as ApprovalRequestState['reviewConfigs'],
        message: detail,
        interruptedAt,
        approvalTtlSeconds,
        runtimeMode,
        expiresAt,
        teamSpaceExecution,
        canResolve,
      }

      useChatStore.setState((state) => {
        // 兜底路径不覆盖已有 pending（bugbot ）：主路径 approval_requested
        // 先行写入的 payload 更丰富（真实 tool_name/tool_input/subagent_context），
        // 同 batch 重复写会降级信息；不同 batch 覆盖会顶掉不相关的在途审批。
        // 已有 pending 时跳过——banner 兜底仍在，用户不会丢失感知。
        const existing = state.pendingApprovalBySessionId[sessionId]
        if (existing) {
          log.debug('SUBAGENT_HITL_REQUIRED 跳过 pendingApproval 写入（已有在途审批）', {
            session: sessionId.slice(0, 8),
            existingBatchId: existing.batchId,
            approvalId,
          })
          return {}
        }
        return {
          pendingApprovalBySessionId: {
            ...state.pendingApprovalBySessionId,
            [sessionId]: pending,
          },
          approvalSubmittingBySessionId: {
            ...state.approvalSubmittingBySessionId,
            [sessionId]: false,
          },
        }
      })
    }

    log.debug('SUBAGENT_HITL_REQUIRED', {
      session: sessionId.slice(0, 8),
      subagentRunId,
      approvalId,
      requiresHostPlatform,
      panelConnected: !!approvalId,
    })
    return
  }

  // ── SUBAGENT_QUEUED（PRD 06 §5.1.3 + W4 (2026-05-26) D1）─────────────
  // 子 Agent 提交 BudgetTracker 后 active 槽位满 → 进 queue 等位。W4 起
  // SubagentStatus 加 'queued'（前为 'pending' 占位），让卡片显示专用
  // "排队中"灰色态——用户能感知"派的任务在等"，符合 C3（派任务总是被
  // 接住，error 是罕见兜底）。主 LLM 不感知（D3 await activation）。
  //
  // **不 push agentStep**（与 STARTED 路径行为统一，避免重复展示）。
  // **不覆盖终态**（防 daemon 异常补发）。
  if (eventType === AgentStreamEvents.SUBAGENT_QUEUED) {
    const existingRuns = get().subagentRunsBySessionId[sessionId] ?? []
    const existing = findSubagentRunForEvent(existingRuns, subagentRunId, identity.toolCallId, 'queued')
    if (isTerminalSubagentStatus(existing?.status)) {
      log.debug('SUBAGENT_QUEUED 忽略（已终态）', {
        session: sessionId.slice(0, 8),
        subagentRunId,
        existingStatus: existing?.status,
      })
      return
    }
    const { templateId: queuedTemplateId, templateName: queuedTemplateName } = extractTemplate(payload)
    get().upsertSubagentRunForSession(sessionId, {
      subagentRunId,
      status: 'queued',
      task: strOpt(payload.task) ?? existing?.task,
      label: strOpt(payload.label) ?? existing?.label,
      role: extractRole(payload) ?? existing?.role,
      // ：模板派发的 template_id/name（queued 已带 speaker）。
      templateId: queuedTemplateId ?? existing?.templateId,
      templateName: queuedTemplateName ?? existing?.templateName,
      model: extractModel(payload) ?? existing?.model,
      parentToolCallId: identity.toolCallId ?? existing?.parentToolCallId,
      speakerId: strOpt(payload.speaker_id) ?? existing?.speakerId,
    })
    log.debug('SUBAGENT_QUEUED', {
      session: sessionId.slice(0, 8),
      subagentRunId,
      queuePos: num(payload.queue_position),
      activeCount: num(payload.active_count),
    })
    return
  }

  // ── SUBAGENT_MODEL_CALL（PRD 06 §5.3.2）─────────────────────────────
  // 子 Agent 内 LLM 调用事件。**纯 observability**——PRD 明确「relay 观测用」，
  // 不进对话流，不展示到用户 UI（W4.5 决策；后续若需要可挪到 DevPanel）。
  // 仅 logger.debug 留痕，方便排障时看到子 Agent 模型调用时序。
  if (eventType === AgentStreamEvents.SUBAGENT_MODEL_CALL) {
    log.debug('SUBAGENT_MODEL_CALL', {
      session: sessionId.slice(0, 8),
      subagentRunId,
      model: strOpt(payload.model),
      iteration: num(payload.iteration),
    })
    return
  }

  // ── SUBAGENT_STARTED / SUBAGENT_FAILED / SUBAGENT_COMPLETED ────────
  //
  // W4 (2026-05-26) 起：SUBAGENT_STARTED **总是**表示"已激活、开始跑"
  // （status='running'），与新独立的 SUBAGENT_QUEUED 事件（status='queued'）
  // 协议分离。之前曾有兜底 "SUBAGENT_STARTED + payload.status='queued'
  // → 'pending'"，是 W4 之前用单一事件表达两态的历史遗留——daemon agent-tool.ts
  // 的 active 路径 emit SUBAGENT_STARTED 已不再带 status 字段，该兜底死代码
  // 随 W4 review 一并清理（P1-E）。
  const statusMap: Record<string, SubagentStatus> = {
    [AgentStreamEvents.SUBAGENT_STARTED]: 'running',
    [AgentStreamEvents.SUBAGENT_FAILED]: 'failed',
    [AgentStreamEvents.SUBAGENT_COMPLETED]: 'completed',
  }
  if (!(eventType in statusMap)) {
    // **反 silent drop 兜底**：未来 daemon 引入新的 subagent_* 事件时，
    // 至少 logger.debug 留痕，而不是被旧 fallback 把状态错乱写成 'running'。
    log.debug('未识别的 subagent 事件，已 silent ignore（不污染 SubagentRun 状态）', {
      session: sessionId.slice(0, 8),
      eventType,
      subagentRunId,
    })
    return
  }
  const status = statusMap[eventType]

  const finalStatus: SubagentStatus =
    (payload.cancelled === true || payload.status === 'cancelled') ? 'cancelled' : status
  const existingRuns = get().subagentRunsBySessionId[sessionId] ?? []
  const existing = findSubagentRunForEvent(existingRuns, subagentRunId, identity.toolCallId, finalStatus)
  const isResumeStart =
    eventType === AgentStreamEvents.SUBAGENT_STARTED
    && payload.resumed === true
    && finalStatus === 'running'
  if (isTerminalSubagentStatus(existing?.status) && existing?.status !== finalStatus && !isResumeStart) {
    log.debug('SUBAGENT 事件忽略（已终态）', {
      session: sessionId.slice(0, 8),
      subagentRunId,
      existingStatus: existing?.status,
      incomingStatus: finalStatus,
    })
    return
  }
  if (existing?.status === 'cancelled' && finalStatus === 'failed') {
    return
  }

  let speakerId: string | undefined
  if (eventType === AgentStreamEvents.SUBAGENT_STARTED) {
    speakerId = registerSpeakerFromPayload(sessionId, subagentRunId, payload)
  }

  // P0-2 修复（2026-05-26）：透传 error_kind / timeout_ms 给前端 i18n
  // 渲染。详见 types.ts:SubagentRun.errorKind JSDoc。
  const rawErrorKind = payload.error_kind
  const errorKind: SubagentRun['errorKind'] =
    rawErrorKind === 'cancelled' || rawErrorKind === 'timeout' || rawErrorKind === 'failed'
      ? rawErrorKind
      : undefined

  const { templateId, templateName } = extractTemplate(payload)
  const backgroundFlag = bool(payload.background)
  const isTerminal =
    finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'cancelled'
  const completionSummary = strOpt(payload.summary) ?? strOpt(payload.error) ?? ''
  const completionDuration =
    typeof (payload.stats as { duration_ms?: number } | undefined)?.duration_ms === 'number'
      ? (payload.stats as { duration_ms: number }).duration_ms
      : typeof existing?.stats?.duration_ms === 'number'
        ? existing.stats.duration_ms
        : Math.max(0, (num(payload.ended_at) ?? Date.now()) - (num(payload.started_at) ?? existing?.startedAt ?? Date.now()))

  const nextRun: SubagentRun = {
    subagentRunId,
    status: finalStatus,
    task: strOpt(payload.task),
    label: strOpt(payload.label),
    role: extractRole(payload),
    // ：命中模板派发时回填 template_id/name（SubagentAggregateView 据此
    // 渲染「源自模板」badge）；ad-hoc 派发时为 undefined。
    ...(templateId ? { templateId } : {}),
    ...(templateName ? { templateName } : {}),
    model: extractModel(payload),
    appId: strOpt(payload.app_id),
    childThreadId: strOpt(payload.child_thread_id),
    parentToolCallId: identity.toolCallId,
    dispatchedByRunId: dispatchedByRunId ?? existing?.dispatchedByRunId,
    ...(speakerId ? { speakerId } : {}),
    ...(backgroundFlag === true || existing?.background === true
      ? { background: true }
      : backgroundFlag === false
        ? { background: false }
        : {}),
    startedAt: num(payload.started_at),
    endedAt: num(payload.ended_at),
    summary: strOpt(payload.summary),
    error: strOpt(payload.error),
    ...(Array.isArray(payload.deliverables) ? { deliverables: payload.deliverables } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(typeof payload.timeout_ms === 'number' ? { timeoutMs: payload.timeout_ms } : {}),
    stats: payload.stats as SubagentRun['stats'],
    ...(isTerminal
      ? {
          completion: {
            subagent_run_id: subagentRunId,
            label: strOpt(payload.label) ?? existing?.label ?? '',
            status:
              finalStatus === 'cancelled'
                ? 'cancelled'
                : errorKind === 'timeout'
                  ? 'timeout'
                  : finalStatus === 'failed'
                    ? 'failed'
                    : 'completed',
            summary: completionSummary,
            duration_ms: completionDuration,
            ...(typeof existing?.stepCount === 'number'
              ? { step_count: existing.stepCount }
              : {}),
            ...(errorKind ? { error_kind: errorKind } : {}),
            ...(identity.toolCallId
              ? { parent_tool_call_id: identity.toolCallId }
              : {}),
            ...(Array.isArray(payload.deliverables) && payload.deliverables.length > 0
              ? { deliverables: payload.deliverables }
              : {}),
            ...(payload.stats ? { stats: payload.stats as SubagentRun['stats'] } : {}),
            ...(existing?.background || backgroundFlag === true
              ? { background: true }
              : {}),
          },
        }
      : {}),
  }
  if (isResumeStart) {
    get().upsertSubagentRunForSession(sessionId, nextRun, { allowRevive: true })
  } else {
    get().upsertSubagentRunForSession(sessionId, nextRun)
  }

  // PRD §4.18 v3.3 review 修复（架构 B.3 / 技术 D4）：终态时通知 live store 标 terminal。
  //
  // 必须在这里联动——`subagentStreamHandler` 只在收到 child_event 的 done /
  // lifecycle.end 时 markRunTerminal，但 `fork-query` 失败路径 rethrow **不 yield
  // done event**，`agent-tool` catch 只 emit SUBAGENT_FAILED（metadata 事件，不经
  // child stream）。结果：失败 / 取消且无 child done 的 run 在 live store 里
  // isTerminal 永为 false → 不进 LRU 终态候选 → 内存常驻 running 桶可无限堆积。
  // 这里用 metadata 终态（completed/failed/cancelled）兜底标记，markRunTerminal 幂等。
  if (finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'cancelled') {
    useSubagentLiveStore.getState().markRunTerminal(subagentRunId)
  }
}

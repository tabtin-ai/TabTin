/**
 * System event handler — processes SYSTEM_NOTICE, CONTEXT_PRESSURE,
 * MONITOR_STATUS, LLM_HEARTBEAT events.
 *
 * **W4.5 第三波 C1（2026-05-13）**：原 TOOL_TIMEOUT 兜底分支已删除——wire 层
 * `StreamEvents.TOOL_TIMEOUT` 物理删，daemon / Django publisher 都 0 caller，
 * Django RELAY 白名单也移除该短名，链路从源头封死。未来若 product 真要重新
 * 引入"工具超时"系统通知，应该用 SYSTEM_NOTICE + notice_type='tool_timeout'
 * 走通用通道（统一与 6 类 tool_* notice 同流），不再独立 event 类型。
 */

import i18n from '@/i18n'
import { AgentStreamEvents } from '@tabtin/ws-gateway-client'
import { toast } from '@tabtin/smartsheet-ui/toast'
import type { AgentStepType, AgentStepStatus } from '../../shared/types'
import { payloadStrOpt as strOpt } from '../../shared/helpers'
import type { AgentStreamMessage, HandlerContext } from './streamHandlerTypes'
import {
  handleToolIntentAvailableNotice,
  handleToolLifecycleNotice,
  handleToolProgressNotice,
  isToolLifecycleNoticeType,
  isToolProgressNoticeType,
  TOOL_INTENT_AVAILABLE_NOTICE_TYPE,
} from './toolLifecycleNotice'
import { useChatModelStore } from '@stores/useChatModelStore'

function friendlyModelName(modelId: string): string {
  const models = useChatModelStore.getState().availableModels
  const match = models.find(m => m.id === modelId || m.name === modelId)
  if (match?.name) {
    const display = match.name
    if (display !== modelId) return display
  }
  const core = modelId
    .replace(/-\d{8}$/, '')
    .replace(/^claude-/, '')
  return core.charAt(0).toUpperCase() + core.slice(1)
}

export function handleSystemEvent(message: AgentStreamMessage, ctx: HandlerContext): void {
  const { sessionId, get } = ctx
  const eventType = message.type

  if (eventType === AgentStreamEvents.SYSTEM_NOTICE) {
    const payload = message.payload || {}
    const noticeType = strOpt(payload.notice_type)
    const rawContent = typeof payload.content === 'string' ? payload.content : ''

    // Skill 绑定凭据缺失/映射 warning 是执行层诊断：命令会继续跑，且用户通常
    // 无需在聊天主线里处理。避免每次调用 Skill 都在对话页弹系统通知。
    if (noticeType === 'skill_credential_unavailable' || noticeType === 'skill_credential_warning') {
      return
    }

    // ── W4a R2-P0-1：tool lifecycle SYSTEM_NOTICE 优先桥接 ────────────
    // W2 把工具执行 lifecycle emit 迁到了 SYSTEM_NOTICE + notice_type='tool_*'
    // （6 种：tool_started / tool_completed / tool_failed + tool_pre_started_exec_*）。
    // W4a 删 toolHandler.ts 时漏接这条桥，工具卡片流式期间完全不渲染。
    // 本桥优先于"通用 SYSTEM_NOTICE 文案显示路径"——tool_* notice **不**
    // 走 pushAgentStep('system_notice') / toast，而是重建 toolEvent +
    // agentStep('tool_start') + runState 切换。如果 payload 不完整（缺
    // tool_name / tool_call_id），桥返 false → 继续走下面 fallback 文案显示
    // （避免 daemon 字段不规范时用户看不到任何东西）。
    if (isToolLifecycleNoticeType(noticeType)) {
      const handled = handleToolLifecycleNotice(payload, ctx)
      if (handled) return
    }

    if (noticeType === TOOL_INTENT_AVAILABLE_NOTICE_TYPE) {
      const handled = handleToolIntentAvailableNotice(payload, ctx)
      if (handled) return
    }

    // 2026-05-17 streaming tool_progress：partial stdout snapshot 走独立桥，
    // 不进 LLM context，只更新 lifecycle event store 的 progress 字段供
    // TerminalCard 实时渲染。handled=true 直接 return，不走通用 fallback
    // 文案显示（避免每条 progress notice 都弹一条系统通知 step）。
    if (isToolProgressNoticeType(noticeType)) {
      const handled = handleToolProgressNotice(payload, ctx)
      if (handled) return
    }

    // W4 review P1-I 修复（2026-05-26）：subagent_spawn_blocked 直接用
    // runtime 已经准备好的 payload.content。
    //
    // **C2 透明性**：让 LLM 和用户看到**同一条信息**。runtime agent-tool.ts
    // 在 emit SYSTEM_NOTICE 时把同一段 blockedMessage（按 reason 分支生成的
    // 中文文案 + 行动建议）同时作为 payload.content 和 tool_result content
    // 返回——前端必须直接复用 payload.content，不要再用 i18n 模板生成"另一
    // 个版本"。否则用户看到的（i18n 模板 truncated 版）与 LLM 看到的（runtime
    // 完整版）字面就漂移，违背 C2「每一步都看得见」。
    //
    // i18n 模板按 reason 分支只作为 payload.content 缺失时的兜底——理论上
    // W4 起 runtime 永远会准备 payload.content，本兜底仅为 backward compat
    // （老 daemon 没塞 content 字段 / 测试 mock 仅塞 reason 等结构字段）。
    //
    // 历史 P0-3：之前 i18n 模板只用 current/max/label 三个老字段渲染，runtime
    // W4 后 emit 的 reason / queued_count / max_queue 全丢；不区分 queue_full
    // vs budget_exhausted 给出截然不同的行动建议——P1-I 升级为"直接用
    // runtime content"后这条担忧自动消解。
    let i18nContent: string | undefined
    if (noticeType === 'subagent_spawn_blocked') {
      const runtimeContent = typeof payload.content === 'string' ? payload.content : undefined
      if (runtimeContent) {
        i18nContent = runtimeContent
      } else {
        const reason = typeof payload.reason === 'string' ? payload.reason : undefined
        const active = typeof payload.current_children === 'number' ? payload.current_children : 0
        const queued = typeof payload.queued_count === 'number' ? payload.queued_count : 0
        const rawMaxActive = payload.max_concurrent_children
        const maxActiveLabel: string = typeof rawMaxActive === 'number'
          ? String(rawMaxActive)
          : i18n.t('chat:subagent.unlimited', { defaultValue: '不限' })
        const rawMaxQueue = payload.max_queue
        const maxQueueLabel: string = typeof rawMaxQueue === 'number'
          ? String(rawMaxQueue)
          : i18n.t('chat:subagent.unlimited', { defaultValue: '不限' })
        const label = typeof payload.label === 'string' ? payload.label : ''

        if (reason === 'queue_full') {
          i18nContent = i18n.t('chat:subagent.spawnBlocked.queueFull', {
            defaultValue:
              '任务队列已满（当前 {{active}}/{{maxActive}} 进行中、{{queued}}/{{maxQueue}} 排队）。' +
              '请等部分任务完成后继续派发，或把这批拆成多轮发送（例如先派 20 个，等几个完成后再派下一批）。',
            active,
            maxActive: maxActiveLabel,
            queued,
            maxQueue: maxQueueLabel,
            label,
          })
        } else if (reason === 'budget_exhausted') {
          i18nContent = i18n.t('chat:subagent.spawnBlocked.budgetExhausted', {
            defaultValue: '账单余额不足或本次会话 token 配额已耗尽。请减少子 Agent 数量或检查账户余额。',
            label,
          })
        } else {
          i18nContent = i18n.t('chat:subagent.spawnBlocked.fallback', {
            defaultValue:
              'AI 助手暂时无法启动更多并行子任务（当前 {{current}}/{{max}}）。' +
              '请稍等几秒后重试，或减少同时进行的任务数。',
            current: active,
            max: maxActiveLabel,
            label,
          })
        }
      }
    }
    if (noticeType === 'model_override') {
      const rawModelId = typeof payload.model === 'string' ? payload.model : ''
      const friendly = rawModelId ? friendlyModelName(rawModelId) : ''
      if (friendly) {
        i18nContent = i18n.t('chat:systemNotice.modelOverride', {
          defaultValue: 'Skill 已将模型切换为 {{model}}',
          model: friendly,
        })
      }
    }
    if (noticeType === 'model_fallback') {
      const rawModelId = typeof payload.fallback_model === 'string' ? payload.fallback_model : ''
      const friendly = rawModelId ? friendlyModelName(rawModelId) : ''
      if (friendly) {
        i18nContent = i18n.t('chat:systemNotice.modelFallback', {
          defaultValue: '已切换到备用模型 {{model}}',
          model: friendly,
        })
      }
    }

    // W3 Stall detector：tool_failure_notice / tool_failure_nudge 走 i18n 模板，
    // 结构化字段 (tool / error_kind / streak / nudge_threshold) 来自 payload。
    //
    // 二次翻译：
    //   - tool 名走 `chat:toolName.${tool}` lookup（"parse_document" → "解析文档"）；
    //     找不到回落到 `chat:systemNotice.unknownTool` 通用兜底（不要拿
    //     `genericNotice` 兜底——那是给"系统通知"标题用的，错位会渲染出
    //     "在「系统通知」上遇到同类问题"破语义）。
    //   - errorKind 走 `chat:systemNotice.errorKindLabel.${kind}` 短词 catalog
    //     ("resource_not_found" → "找不到资源"）。**不**复用 `chat:toolError.${kind}`：
    //     后者是为 ErrorBanner / ToolErrorCard 设计的"短描述 — 行动建议"形态
    //     ("资源不存在 — 确认 ID 或重新选择资源"），塞到 SYSTEM_NOTICE 括号里
    //     会让用户看到 ErrorBanner 已经出现过的"行动建议"被重复说一遍——视觉
    //     上像系统在啰嗦同一句话。短词 catalog 只给名词标签，括号内简洁不重复。
    //     找不到再回落到 `_unknown` 通用短词，最后兜 raw kind。
    //
    // remaining 量化引导（与 iteration-budget warn 的"已达 70%"一致）：notice 阶段
    // 用 `nudge_threshold - streak` 告诉用户"再失败 N 次将主动介入"。
    //
    // 与 subagent_spawn_blocked 同模式：notice 出现在 chat 流（pushAgentStep）
    // 而不是 toast，让用户可以与对话历史关联看（"runtime 在第几步介入"）。
    if (noticeType === 'tool_failure_notice' || noticeType === 'tool_failure_nudge') {
      const tool = typeof payload.tool === 'string' ? payload.tool : ''
      const errorKind = typeof payload.error_kind === 'string' ? payload.error_kind : ''
      const streak = typeof payload.streak === 'number' ? payload.streak : 0
      const nudgeThreshold = typeof payload.nudge_threshold === 'number'
        ? payload.nudge_threshold
        : 5

      const unknownToolLabel = i18n.t('chat:systemNotice.unknownTool', {
        defaultValue: '工具',
      })
      const toolLabel = tool
        ? i18n.t(`chat:toolName.${tool}`, { defaultValue: tool })
        : unknownToolLabel
      const unknownErrorLabel = i18n.t(
        'chat:systemNotice.errorKindLabel._unknown',
        { defaultValue: '同类问题' },
      )
      const errorLabel = errorKind
        ? i18n.t(`chat:systemNotice.errorKindLabel.${errorKind}`, {
            defaultValue: unknownErrorLabel,
          })
        : unknownErrorLabel
      const remaining = Math.max(1, nudgeThreshold - streak)

      const i18nKey =
        noticeType === 'tool_failure_notice'
          ? 'chat:systemNotice.toolFailureNotice'
          : 'chat:systemNotice.toolFailureNudge'
      i18nContent = i18n.t(i18nKey, {
        defaultValue: rawContent,
        tool: toolLabel,
        errorKind: errorLabel,
        streak,
        remaining,
        count: remaining,
      })
    }

    // W6 Tool repetition tracker (Lane E runtime + Lane H 前端)：
    // tool_repetition_notice / tool_repetition_nudge 走 i18n 模板，**sibling 于
    // tool_failure_***，复用 toolName lookup + plural keyword 策略，但 payload
    // 字段语义不同 ——
    //
    //   - tool_failure: 失败 streak（连续同 tool+kind 失败 N 次）→ payload 含
    //     `error_kind` / `streak`
    //   - tool_repetition: 成功复读（30s 窗口内同 tool+inputDigest 总计 M 次）→
    //     payload 含 `count` / `window_ms`，**没有** `error_kind`（复读没有错误类型）
    //
    // 字段映射（runtime → 模板）：
    //   - `tool` 直接复用 `chat:toolName.${tool}` 翻译（同失败模板）
    //   - `count` (runtime trigger.count) → 模板 `{{repeatCount}}`
    //     **不能直接传 `count: trigger.count`** —— i18next 的 `count` 是 plural
    //     keyword 已被 `remaining` 占用（与 tool-failure 同策略：plural 按"还差
    //     几次"复数化）。所以模板里"复读总次数"用独立变量名 `repeatCount`
    //   - `window_ms` → `seconds = Math.round(window_ms / 1000)` 给用户看的
    //     友好单位（runtime 默认 30000ms；ms 不进文案）
    //   - `remaining = max(1, nudge_threshold - count)` 同 failure 公式形态，
    //     量化引导"再重复 K 次将主动介入"
    //
    // 不引入新的 errorKindLabel 类字典 —— 复读没有错误类型，对齐"没有就不假装有"。
    // 不重构与 tool_failure 分支共用 —— payload 字段差异大，强行抽公共会让
    // sibling 阅读成本反升；保留两个独立 if 块更直观。
    if (noticeType === 'tool_repetition_notice' || noticeType === 'tool_repetition_nudge') {
      const tool = typeof payload.tool === 'string' ? payload.tool : ''
      // **数值字段必须 Number.isFinite 守护**：仅 typeof === 'number' 不排斥
      // NaN / Infinity（实测 Review P1 漏洞）。一旦传染到 Math.round / Math.max，
      // 模板里 `{{seconds}}` / `{{remaining}}` 会渲染成字面 "NaN"，比 raw fallback
      // 还糟。守护后回落值与 runtime DEFAULT_TOOL_REPETITION_* 对齐
      // （window=30s / nudge=3）保证文案语义稳定。
      const rawCount = payload.count
      const count = typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : 0
      const rawWindowMs = payload.window_ms
      const windowMs = typeof rawWindowMs === 'number' && Number.isFinite(rawWindowMs)
        ? rawWindowMs
        : 30_000
      const rawNudgeThreshold = payload.nudge_threshold
      const nudgeThreshold = typeof rawNudgeThreshold === 'number' && Number.isFinite(rawNudgeThreshold)
        ? rawNudgeThreshold
        : 3

      const unknownToolLabel = i18n.t('chat:systemNotice.unknownTool', {
        defaultValue: '工具',
      })
      const toolLabel = tool
        ? i18n.t(`chat:toolName.${tool}`, { defaultValue: tool })
        : unknownToolLabel
      const seconds = Math.max(1, Math.round(windowMs / 1000))
      const remaining = Math.max(1, nudgeThreshold - count)

      const i18nKey =
        noticeType === 'tool_repetition_notice'
          ? 'chat:systemNotice.toolRepetitionNotice'
          : 'chat:systemNotice.toolRepetitionNudge'
      i18nContent = i18n.t(i18nKey, {
        defaultValue: rawContent,
        tool: toolLabel,
        repeatCount: count,
        seconds,
        remaining,
        count: remaining,
      })
    }

    const displayContent = i18nContent ?? rawContent
    const severity = typeof payload.severity === 'string' ? payload.severity : undefined

    if (severity === 'silent') {
      return
    }

    if (displayContent) {
      get().pushAgentStepForSession(sessionId, {
        id: `system-notice-${Date.now()}`,
        type: 'system_notice' as AgentStepType,
        title: displayContent.replace(/^>\s*/gm, '').replace(/\n+/g, ' ').trim(),
        detail: displayContent,
        status: 'done' as AgentStepStatus,
        timestamp: Date.now(),
        noticeType,
      })

      if (noticeType === 'context_truncated') {
        toast.info(
          i18n.t('chat:agentSteps.contextTruncated', {
            defaultValue: '对话上下文已自动压缩，部分早期对话记录已被移除',
          }),
          { duration: 10000 },
        )
      } else if (severity === 'warning') {
        toast.warning(displayContent.replace(/^>\s*/gm, '').replace(/\n+/g, ' ').trim(), {
          duration: 10000,
        })
      }
    }
    return
  }

  if (eventType === AgentStreamEvents.CONTEXT_PRESSURE) {
    return
  }

  if (eventType === AgentStreamEvents.MONITOR_STATUS) {
    const payload = message.payload || {}
    get().updateRunStateForSession(sessionId, {
      monitorStatus: payload,
    })
    return
  }

  if (eventType === AgentStreamEvents.LLM_HEARTBEAT) {
    const payload = message.payload || {}
    const elapsed = typeof payload.elapsed_seconds === 'number' ? payload.elapsed_seconds : 0
    const sinceLastChunk = typeof payload.seconds_since_last_chunk === 'number'
      ? payload.seconds_since_last_chunk : undefined
    get().updateRunStateForSession(sessionId, {
      lastHeartbeatAt: Date.now(),
      llmElapsedSeconds: elapsed,
      secondsSinceLastChunk: sinceLastChunk,
    })
    return
  }

  // ── W4.5 第三波 C1（2026-05-13）─────────────────────────────────
  // 原 TOOL_TIMEOUT case 已删除——wire 层 `StreamEvents.TOOL_TIMEOUT` 物理删，
  // 链路从源头封死。详见文件顶部 docblock。
}

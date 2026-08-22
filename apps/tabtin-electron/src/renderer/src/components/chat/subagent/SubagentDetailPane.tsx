/**
 * SubagentDetailPane — 子 Agent 详情 Pane（PRD v3.1 dogfood 重塑版）
 *
 * 北极星：子 Agent 详情就是「一个新 tab 里的 chat 视图」，跟主 ChatPanel 同款体验。
 *
 * 旧实现的错误（v3.1 重塑前）：
 * 三 KindTab（messages/snapshots/events）+ envelope summarize 把 jsonl 翻成
 * 「1 assistant 思考 / 2 - 块结束」开发者视图。错把"调试器视图"当"用户视图"做。
 *
 * 重塑后实现（：runtime 归档为执行真相）：
 * 1. transcript 数据源见 `useSubagentDetailTranscript`（live + 归档二选一）
 * 2. 直接喂给 MessageList 渲染（主对话同款的 BlockTimeline + ToolUseBlockView 等）
 * 3. 第一条 user message 之前的"父对话继承上下文"折叠成可展开 section
 * 4. snapshots / events 仍在 jsonl 落盘，仅 UI 不显示
 *
 * 与主 ChatPanel 的差异：
 * - 只读（不能跟子 Agent 直接对话——子 Agent 由父 Agent 通过 Task tool 派发）
 * - header 提供子 Agent 特有操作：cancel（running）/ retry（failed）/ 「在对话中定位」
 *
 * Props：
 *   - subagentRunId：唯一 run ID（对应 tab.id）
 *   - parentSessionId：父 chat session ID（IPC 拼路径用）
 *   - isPaneActive：当前是否为活动 Pane（影响 IPC 拉取频率）
 */

import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveSessionScopeId } from '@tabtin/app-shell'
import { AlertTriangle, Loader2, RefreshCw, Crosshair, X, CheckCircle2, XCircle, Ban, HelpCircle, Clock, ChevronDown, ChevronRight, History, PanelRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { useChatRuntimeStore } from '../../../stores/useChatRuntimeStore'
import { useChatStore } from '../../../stores/chat/useChatStore'
import { useSpeakerRegistryStore } from '../../../stores/useSpeakerRegistryStore'
import { TEXT, BORDER, TEXT_COLOR, ICON_SIZE, ANIMATION } from '../registry/chatDesignTokens'
import { scrollToToolCall } from '../tool/scrollToToolCall'
import { getToolDisplayName } from '../registry/toolDisplayName'
import { logger } from '@/utils/logger'
import { toast } from '@tabtin/smartsheet-ui/toast'
import type { SubagentSessionMeta } from '@/stores/contextTabs/types'
import { MessageList } from '../message'
import { EmbeddedMessageTimeline } from '../message'
import { useVirtualSessionMessages } from '@stores/chat/presentation/messageTimeline/useVirtualSessionMessages'
import { ChatIconTooltip } from '../panel/ChatIconTooltip'
import { openSubagentTab } from './openSubagentTab'
import { useSubagentDetailTranscript } from './useSubagentDetailTranscript'
import { appendNestedSubagentCompletionNotifications, buildSubagentVisibleMessages, collectBackgroundSubagentToolCallIds } from './subagentTaskTimeline'
import type { SubagentRun } from '../../../stores/chat/shared/types'

interface SubagentDetailPaneProps {
  subagentRunId: string
  parentSessionId: string
  parentToolCallId?: string
  isPaneActive: boolean
  /**
   * 是否允许「在工作台标签打开」（仅 inline 就地展开场景传 true）。header 会显示一个
   * 打开按钮，点击把该子 Agent 提升成 space 工作台 tab。工作台 tab 场景本就在 tab 里，不传。
   */
  allowOpenInTab?: boolean
  /**
   * 精简 header（仅 inline 就地展开场景传 true）：派发行已做标题 + 状态，这里只保留一排
   * 右对齐操作图标，去掉身份区 / shortid / 进度副标题 / 分隔线，融入「子线程缩进」不再
   * 立一个 header 盒子。工作台 tab 没有派发行做标题，保留完整 header。
   */
  compactHeader?: boolean
  /**
   * run 不可用时（工作台 tab 跨 session / 被 evict）的身份名兜底——来自 tab
   * meta.displayName/label，避免 header 回落到「子 Agent shortid」。inline 就地展开
   * 场景不传（run 一定在当前 store，能直接拿 speaker/role）。
   */
  fallbackName?: string
  /**
   * 可选关闭回调。「行内就地展开」（SubagentInlineDetail——对话内派发标记 /
   * 兜底单卡点行展开）复用本 Pane 时传入——header 操作组末尾会多一个关闭按钮
   * （X），等价于再点一次行收起。工作台 tab 场景不传（tab 由其自身关闭机制处理）。
   */
  onClose?: () => void
}

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  pending: Loader2,
  queued: Clock,
  running: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  cancelled: Ban,
  unknown: HelpCircle,
}

const STATUS_COLOR: Record<string, string> = {
  pending: TEXT_COLOR.muted,
  queued: TEXT_COLOR.muted,
  running: TEXT_COLOR.accent,
  completed: 'text-success/80',
  failed: 'text-destructive/80',
  cancelled: TEXT_COLOR.muted,
  unknown: TEXT_COLOR.muted,
}

const STATUS_ANIMATE = new Set(['running'])
const EMPTY_SUBAGENT_RUNS: SubagentRun[] = []

export const SubagentDetailPane: React.FC<SubagentDetailPaneProps> = ({ subagentRunId, parentSessionId, parentToolCallId, isPaneActive, allowOpenInTab, compactHeader, fallbackName, onClose }) => {
  const { t } = useTranslation('chat')

  // 实时态：SubagentRun（含 status、stepCount、toolHistory、error 等）
  const run = useChatRuntimeStore((s) => {
    const runs = s.subagentRunsBySessionId[parentSessionId] ?? []
    if (parentToolCallId) {
      const exact = runs.find((r) =>
        r.subagentRunId === subagentRunId
        && r.parentToolCallId === parentToolCallId,
      )
      if (exact) return exact
    }
    return runs.find((r) => r.subagentRunId === subagentRunId)
  })
  const sessionSubagentRuns = useChatRuntimeStore((s) => s.subagentRunsBySessionId[parentSessionId] ?? EMPTY_SUBAGENT_RUNS)
  const relatedRuns = useMemo(
    () => sessionSubagentRuns.filter((r) => r.subagentRunId === subagentRunId),
    [sessionSubagentRuns, subagentRunId],
  )
  const isCancelling = useChatRuntimeStore((s) => s.subagentCancellingByRunId[subagentRunId] === true)
  const cancelSubagentRun = useChatRuntimeStore((s) => s.cancelSubagentRun)

  const spaceId = useChatStore((s) => resolveSessionScopeId(s.getSessionById(parentSessionId)))
  const speaker = useSpeakerRegistryStore((s) => s.speakersBySessionId[parentSessionId]?.[subagentRunId])
  const status = run?.status ?? 'unknown'
  const StatusIcon = STATUS_ICON[status] ?? HelpCircle
  const statusColor = STATUS_COLOR[status] ?? TEXT_COLOR.muted
  const statusAnimate = STATUS_ANIMATE.has(status)

  // ：live + runtime 归档选源 / bootstrap / loading·error（见 hook）
  const { messages, firstUserMessageIndex, isLoading, error, handleRefresh } = useSubagentDetailTranscript({
    subagentRunId,
    parentSessionId,
    isPaneActive,
    status,
  })

  // header 标题 = 子 Agent **身份名**，优先级 role → label → display_name（用户拍板）：
  //   - role：主 Agent 经 agent 工具 role 参数显式起的角色名（「测试助手」），最像名字；
  //   - label：agent.description 短标题（「子Agent 1 - 回复1」），role 缺省时回落；
  //   - display_name：runtime 自动拼的「模板名 · shortid · 任务提示」，较啰嗦，再次之；
  //   - fallbackName：工作台 tab 在 run 不可用（跨 session / evict）时的 meta 兜底。
  // **不用 task**——那是主 Agent 的指令 prompt，作为消息气泡进对话流（见 visibleMessages），不当标题。
  const displayName = useMemo(() => {
    return run?.role || run?.label || speaker?.display_name || fallbackName?.trim() || `${t('subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })} ${subagentRunId.slice(0, 8)}`
  }, [run?.role, run?.label, speaker?.display_name, fallbackName, subagentRunId, t])

  // header 进度副标题（review 用户视角 #5：跟卡片 stepInfo 对齐，用户不用滚到底
  // 才知道子 Agent 当前在跑哪个工具 / 第几步）。仅 running/queued 显示。
  const progressSubtitle = useMemo(() => {
    if (!run) return null
    if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'pending') return null
    const stepText =
      run.stepCount && run.stepCount > 0
        ? t('subagent.steps', {
            count: run.stepCount,
            defaultValue: `${run.stepCount} 步`,
          })
        : null
    const toolText = run.latestTool ? getToolDisplayName(t, run.latestTool) : null
    if (stepText && toolText) return `${stepText} · ${toolText}`
    return stepText || toolText || null
  }, [run, t])

  // 失败摘要（review 用户视角 #4：失败态 Pane 缺 error 信息，用户点进去不知道哪挂了）。
  // 复用卡片同款 errorKind i18n 分类；raw error 作为可展开二级信息。
  const failureSummary = useMemo(() => {
    if (run?.status !== 'failed') return null
    const kind = run.errorKind
    if (kind === 'timeout') {
      const minutes = run.timeoutMs ? Math.round(run.timeoutMs / 60_000) : 30
      return {
        title: t('subagent.errorDetail.timeout', {
          minutes,
          defaultValue: `执行超过 ${minutes} 分钟自动停止 —— 建议把任务拆小再派`,
        }),
        detail: run.error,
      }
    }
    if (kind === 'cancelled') {
      return {
        title: t('subagent.errorDetail.cancelled', {
          defaultValue: '已被取消',
        }),
        detail: run.error,
      }
    }
    return {
      title: t('subagent.errorDetail.failed', {
        defaultValue: '执行失败 —— 可重试一次或调整任务描述',
      }),
      detail: run.error,
    }
  }, [run?.status, run?.errorKind, run?.timeoutMs, run?.error, t])

  // 折叠"父对话继承上下文"——firstUserMessageIndex>0 时前面的部分默认收起
  const [inheritedExpanded, setInheritedExpanded] = useState(false)
  const hasInheritedContext = firstUserMessageIndex > 0
  const inheritedCount = hasInheritedContext ? firstUserMessageIndex : 0
  const visibleMessages = useMemo(() => {
    const base = hasInheritedContext && !inheritedExpanded ? messages.slice(firstUserMessageIndex) : messages
    const backgroundToolCallIds = collectBackgroundSubagentToolCallIds(base)
    const descendantBackgroundRuns = sessionSubagentRuns
      .filter((r) =>
        (
          r.dispatchedByRunId === subagentRunId
          && r.background === true
        )
        || (r.parentToolCallId ? backgroundToolCallIds.has(r.parentToolCallId) : false),
      )
      .map((r) => r.background === true ? r : { ...r, background: true })
    // 主 Agent 派发/续跑给子 Agent 的指令（run.task）是每次 tool call 的输入。
    // 同一个子 Agent 被 resume 时，详情 transcript 是完整历史：需要同时补首次
    // 派发 prompt 和后续 resume prompt，不能只补当前选中 run，否则看起来像
    // resume 把第一次 prompt 替换掉了。
    const taskRuns: SubagentRun[] = relatedRuns.length > 0 ? relatedRuns : (run ? [run] : [])
    const withTaskPrompts = buildSubagentVisibleMessages({
      messages: base,
      taskRuns,
      subagentRunId,
    })
    return appendNestedSubagentCompletionNotifications({
      messages: withTaskPrompts,
      descendantRuns: descendantBackgroundRuns,
      subagentRunId,
    })
  }, [messages, hasInheritedContext, firstUserMessageIndex, inheritedExpanded, relatedRuns, run, subagentRunId, sessionSubagentRuns])

  // 虚拟 sessionId 给 MessageList，避免污染主 chat session 的 runtime 订阅
  const virtualSessionId = useMemo(() => `subagent-replay:${subagentRunId}`, [subagentRunId])
  useVirtualSessionMessages(virtualSessionId, visibleMessages)
  const transcriptEmptyStateHint = isLoading
    ? t('subagent.drawer.loading', { defaultValue: '加载中…' })
    : run && (run.status === 'running' || run.status === 'queued' || run.status === 'pending')
      ? t('subagent.tab.startingHint', { defaultValue: '子 Agent 正在启动…' })
      : t('subagent.drawer.empty.messages', { defaultValue: '尚无对话内容' })

  // ── header 操作：cancel / retry / 在对话中定位 ──
  const canCancel = status === 'running' || status === 'queued' || status === 'pending'
  const handleCancel = useCallback(() => {
    if (!canCancel || isCancelling) return
    void cancelSubagentRun(subagentRunId).catch((err) => {
      logger.warn('[SubagentDetailPane] cancel failed', { subagentRunId, err })
    })
  }, [canCancel, isCancelling, cancelSubagentRun, subagentRunId])

  const canRetry = status === 'failed' && !!run?.task
  const handleRetry = useCallback(() => {
    if (!canRetry) return
    const task = run!.task!
    const trimmed = task.length > 60 ? task.slice(0, 60) + '…' : task
    const prompt = t('subagent.retry.prompt', {
      task: trimmed,
      defaultValue: `重试: ${trimmed}`,
    })
    const send = useChatStore.getState().sendMessage
    if (typeof send === 'function') {
      void send(prompt, true, undefined, undefined, parentSessionId)
    } else {
      logger.warn('[SubagentDetailPane] retry but sendMessage unavailable', {
        subagentRunId,
      })
    }
  }, [canRetry, run, parentSessionId, subagentRunId, t])

  const handleScrollToOrigin = useCallback(() => {
    if (!parentToolCallId) return
    scrollToToolCall(parentToolCallId, {
      onMissing: () => {
        toast({
          title: t('subagent.tab.scrollLocateMissingToast', {
            defaultValue: '找不到对应消息，可能已被清理',
          }),
        })
      },
    })
  }, [parentToolCallId, t])

  // 「在工作台标签打开」：把 inline 展开的子 Agent 提升成 space 工作台 tab，并收起 inline。
  // 身份名 displayName 与 header / tab 同口径（role → label → display_name）存进 meta。
  const handleOpenInTab = useCallback(() => {
    if (!spaceId) return
    void openSubagentTab({
      parentSessionId,
      subagentRunId,
      spaceId,
      displayName: run?.role?.trim() || run?.label?.trim() || speaker?.display_name?.trim() || undefined,
      label: run?.label,
      task: run?.task,
      parentToolCallId,
      speakerId: run?.speakerId,
    })
    onClose?.()
  }, [spaceId, parentSessionId, subagentRunId, run?.role, run?.label, run?.task, run?.speakerId, speaker?.display_name, parentToolCallId, onClose])

  // header 操作按钮组（完整 header 与 compactHeader 两态共用）：
  // 在对话中定位 / 重试 / 取消 / 刷新 / 在工作台标签打开。
  const headerActions = (
    <>
      {parentToolCallId && (
        <HeaderButton
          onClick={handleScrollToOrigin}
          title={t('subagent.tab.scrollLocateButton', {
            defaultValue: '在对话中定位',
          })}
          icon={Crosshair}
        />
      )}
      {canRetry && <HeaderButton onClick={handleRetry} title={t('subagent.tab.retryAction', { defaultValue: '重试' })} icon={RefreshCw} />}
      {canCancel && (
        <HeaderButton onClick={handleCancel} title={t('subagent.tab.cancelAction', { defaultValue: '取消' })} icon={isCancelling ? Loader2 : X} disabled={isCancelling} animate={isCancelling} />
      )}
      <HeaderButton onClick={handleRefresh} title={t('subagent.drawer.refresh', { defaultValue: '刷新' })} icon={RefreshCw} animate={isLoading} disabled={isLoading} />
      {/*
       * 「在工作台标签打开」按钮：仅 inline 就地展开（allowOpenInTab）显示。点击把子 Agent
       * 提升成 space 工作台 tab（openSubagentTab）+ 收起 inline（onClose）。收起 inline 走
       * 「再点对话里那一行」（手风琴 toggle）。
       */}
      {allowOpenInTab && spaceId && (
        <HeaderButton
          onClick={handleOpenInTab}
          title={t('subagent.tab.openInWorkbench', {
            defaultValue: '在工作台标签打开',
          })}
          icon={PanelRight}
        />
      )}
    </>
  )

  return (
    <div
      className={cn('flex min-h-0 w-full flex-col', compactHeader ? 'flex-1 bg-transparent' : 'h-full bg-background')}
      role="region"
      aria-label={t('subagent.tab.ariaLabel', {
        defaultValue: '子 Agent 详情',
      })}
    >
      {/* Header：
          - compactHeader（inline 就地展开）：派发行已做标题 + 状态，这里只留一排右对齐操作
            图标，去身份区 / shortid / 进度副标题 / border-b 分隔线——避免与派发行重复，也不在
            「子线程缩进」里再立一个 header 盒子。
          - 完整 header（工作台 tab）：tab 里没有派发行做标题，保留 ✓ + 身份 + 进度 + 操作。 */}
      {compactHeader ? (
        <div className="flex shrink-0 items-center justify-end gap-0.5 px-1 pt-0.5 pb-1">{headerActions}</div>
      ) : (
        <div className={cn('flex items-start gap-2 border-b px-3 py-2 shrink-0', BORDER.subtle)}>
          <StatusIcon
            className={cn(ICON_SIZE.md, 'flex-shrink-0 mt-0.5', statusColor, {
              [ANIMATION.spin]: statusAnimate,
            })}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn(TEXT.header, TEXT_COLOR.primary, 'truncate')} title={displayName}>
                {displayName}
              </span>
              <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'font-mono shrink-0')}>{subagentRunId.slice(0, 8)}</span>
            </div>
            {progressSubtitle && <span className={cn(TEXT.meta, TEXT_COLOR.muted)}>{progressSubtitle}</span>}
            {speaker?.template_id && (
              <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
                {t('subagent.drawer.header.templateVersion', {
                  defaultValue: '模板版本',
                })}
                : {speaker.template_id}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">{headerActions}</div>
        </div>
      )}

      {/* 父对话继承上下文折叠条（dogfood Q3 选项 B） */}
      {hasInheritedContext && (
        <button
          type="button"
          onClick={() => setInheritedExpanded((prev) => !prev)}
          className={cn('flex items-center gap-1.5 px-3 py-1.5 border-b transition-colors shrink-0', BORDER.subtle, TEXT.meta, TEXT_COLOR.muted, 'hover:bg-muted/20 hover:text-foreground')}
        >
          {inheritedExpanded ? <ChevronDown className={ICON_SIZE.sm} /> : <ChevronRight className={ICON_SIZE.sm} />}
          <History className={ICON_SIZE.sm} />
          <span>
            {t('subagent.tab.inheritedContextLabel', {
              count: inheritedCount,
              defaultValue: `父对话继承上下文 (${inheritedCount} 条)`,
            })}
          </span>
          <span className={cn(TEXT_COLOR.faint, 'ml-1 text-caption')}>
            {inheritedExpanded ? t('subagent.tab.collapseHint', { defaultValue: '点击收起' }) : t('subagent.tab.expandHint', { defaultValue: '点击展开' })}
          </span>
        </button>
      )}

      {/* 失败摘要条（review 用户视角 #4）：失败态在 transcript 上方插人话 + raw error */}
      {failureSummary && (
        <div className={cn('flex items-start gap-2 px-3 py-2 border-b shrink-0', BORDER.subtle, 'bg-destructive/5')} data-testid="subagent-detail-pane-failure-banner">
          <AlertTriangle className={cn(ICON_SIZE.sm, 'flex-shrink-0 mt-0.5 text-destructive/80')} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={cn(TEXT.body, 'text-destructive/80 font-medium')}>{failureSummary.title}</span>
            {failureSummary.detail && <span className={cn(TEXT.meta, TEXT_COLOR.muted, 'break-words whitespace-pre-wrap font-mono')}>{failureSummary.detail}</span>}
          </div>
        </div>
      )}

      {/* Body：工作台详情维持独立滚动；inline 把滚动权交给主对话，因此不能保留
          overflow-hidden 这层伪滚动边界，否则嵌套子任务的 sticky 标题无法找到主视口。 */}
      <div className={cn('flex min-h-0 flex-1 flex-col', compactHeader ? 'overflow-visible' : 'overflow-hidden')}>
        {error ? (
          <ErrorState errorCode={error} hasLocalRun={!!run} onRetry={handleRefresh} />
        ) : compactHeader ? (
          <EmbeddedMessageTimeline
            sessionId={virtualSessionId}
            subagentRunSessionId={parentSessionId}
            ownerRunId={subagentRunId}
            showSubagentCompletionPush
            isLoading={isLoading && visibleMessages.length === 0}
            emptyStateHint={transcriptEmptyStateHint}
          />
        ) : (
          <MessageList
            sessionId={virtualSessionId}
            // 子 Agent 详情就是要渲染子代理消息（subagent_run_id 非空）——关闭主时间线
            // 的隔离过滤（visibleMessages 已只含本 run 的子消息）。
            includeSubagentMessages
            // 嵌套孙 Agent 的 run 元数据 keyed 在真实父 chat session 下（不是虚拟
            // session）——透传 parentSessionId 让聚合卡能反查到孙 run 的真实状态，
            // 而不是永远「连接中」（2026-05-29 dogfood bug 2）。
            subagentRunSessionId={parentSessionId}
            // 子 Agent 详情里 user 消息是「主 Agent 给子 Agent 的指令」，走左气泡
            // （与真实用户右气泡区分）。
            userAlign="left"
            // inline 就地展开是「预览」：隐藏每条消息的时间戳 + 复制等 footer，完整操作
            // 去工作台 tab。compactHeader 同为 inline 标记，复用其判定。
            previewMode={compactHeader}
            isLoading={isLoading && visibleMessages.length === 0}
            emptyStateHint={transcriptEmptyStateHint}
            contentPadding="px-3"
          />
        )}
      </div>
    </div>
  )
}

SubagentDetailPane.displayName = 'SubagentDetailPane'

// Re-export typed meta for handler 消费方便
export type { SubagentSessionMeta }

// ─── 内部子组件 ─────────────────────────────────────────────

const HeaderButton: React.FC<{
  onClick: () => void
  title: string
  icon: React.ComponentType<{ className?: string }>
  disabled?: boolean
  animate?: boolean
}> = ({ onClick, title, icon: Icon, disabled, animate }) => (
  <ChatIconTooltip content={title}>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      className={cn('rounded p-1 transition-colors', disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted/40 hover:text-foreground', TEXT_COLOR.muted)}
    >
      <Icon className={cn(ICON_SIZE.sm, animate && ANIMATION.spin)} />
    </button>
  </ChatIconTooltip>
)

/**
 * 错误态分类策略——v3.2 envelope-error 修复后，能精确拿到 main 端 IPC handler
 * 的原始错误码（不再被 ipc-shim 吞成 "returned ok:false without a message"）。
 *
 * 三类（按优先级）：
 *   1. **跨设备 / 归档不可用**：jsonl 类错误码 + 本机 runtime 没该 run
 *      → "该子任务详情仅在派发它的设备上保留"（v3.1 P2-9）
 *   2. **父会话不可达**：parent_session_not_alive / parent_session_missing_organization_or_space
 *      → "会话状态已离线 / 父对话当前未激活，请回到对应对话窗口重新打开后再查看"（v3.1 P2-10）
 *   3. **其他**：通用"加载失败 / 请稍后重试"，可点重试，错误码尾巴显示给开发者
 */
const CROSS_DEVICE_AMBIGUOUS_CODES = new Set(['subagent_not_found', 'file_missing', 'subagents_index_missing'])

const PARENT_SESSION_UNAVAILABLE_CODES = new Set(['parent_session_not_alive', 'parent_session_missing_organization_or_space'])

/**
 * 从 errorCode 提取 base code。兼容三种历史形态：
 *   - 新形态（envelope-error 修复后）：`'parent_session_not_alive'` 直接是 code
 *   - 老形态 fallback（PlatformIpcError code 不可用）：`'ipc_failed:xxx'` → 取冒号后
 *   - reader 自带后缀的：`'read_failed:ENOSPC ...'` → 取冒号前
 *
 * 优先按"完整字符串等于"匹配启发式 set；命不中再剥前缀重匹一次。
 */
function extractBaseCode(errorCode: string): string {
  if (!errorCode.includes(':')) return errorCode
  // 老 fallback 形态 `ipc_failed:xxx` → 取冒号后做精确匹配优先
  if (errorCode.startsWith('ipc_failed:')) {
    return errorCode.slice('ipc_failed:'.length)
  }
  // reader 类带 detail 后缀（`read_failed:ENOSPC`）→ 取冒号前
  return errorCode.slice(0, errorCode.indexOf(':'))
}

const ErrorState: React.FC<{
  errorCode: string
  hasLocalRun: boolean
  onRetry: () => void
}> = ({ errorCode, hasLocalRun, onRetry }) => {
  const { t } = useTranslation('chat')
  const baseCode = extractBaseCode(errorCode)
  const isCrossDevice = !hasLocalRun && CROSS_DEVICE_AMBIGUOUS_CODES.has(baseCode)
  const isParentUnavailable = PARENT_SESSION_UNAVAILABLE_CODES.has(baseCode)
  const isHandled = isCrossDevice || isParentUnavailable

  let title: string
  let detail: string
  if (isCrossDevice) {
    title = t('subagent.tab.crossDeviceTitle', {
      defaultValue: '该子任务详情仅在派发它的设备上保留',
    })
    detail = t('subagent.tab.crossDeviceDetail', {
      defaultValue: '本期子 Agent 的对话记录不跨设备同步。请回到当时派发此任务的设备查看完整详情。',
    })
  } else if (isParentUnavailable) {
    title = t('subagent.tab.parentUnavailableTitle', {
      defaultValue: '父对话当前未激活',
    })
    detail = t('subagent.tab.parentUnavailableDetail', {
      defaultValue: '会话状态已离线。请回到对应对话窗口重新打开后再查看子 Agent 详情。',
    })
  } else {
    title = t('subagent.drawer.errorTitle', { defaultValue: '加载失败' })
    detail = t('subagent.drawer.errorDetail', {
      defaultValue: '请稍后重试，如反复失败请重启应用。',
    })
  }

  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-12 h-full', TEXT.body)} data-testid="subagent-detail-pane-error">
      <div className={cn('flex items-center gap-2', 'text-destructive/80')}>
        <AlertTriangle className={ICON_SIZE.md} />
        <span className={cn(TEXT.header, 'font-medium')}>{title}</span>
      </div>
      <div className={cn(TEXT.body, TEXT_COLOR.muted, 'text-center max-w-md')}>{detail}</div>
      {/* 跨设备 / 父会话不可达都不显示重试——本机重试没用；其他场景给重试按钮 */}
      {!isHandled && (
        <button
          type="button"
          className={cn('mt-2 flex items-center gap-1 rounded border px-2 py-1 transition-colors', BORDER.subtle, TEXT_COLOR.muted, 'hover:bg-muted/20 hover:text-foreground', TEXT.meta)}
          onClick={onRetry}
        >
          <RefreshCw className={ICON_SIZE.sm} />
          {t('subagent.drawer.retry', { defaultValue: '重试' })}
        </button>
      )}
      <code className={cn(TEXT.meta, TEXT_COLOR.faint, 'font-mono mt-1')}>{errorCode}</code>
    </div>
  )
}

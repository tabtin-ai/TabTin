/**
 * AgentChatCapsule —— app-focus 下的 Agent 对话缩略胶囊（右下角悬浮）。
 * 只负责缩略态展示与「展开」入口；展开面板见 AgentChatOverlay。
 */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { Wrench } from 'lucide-react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSessionBusy } from '@stores/chat/execution/sessionRunProjection'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useWsConnectionStore } from '@stores/useWsConnectionStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { AgentAvatar } from '../message'
import { extractAgentAvatarUrl } from '@/utils/resolveAgentAvatar'
import {
  resolveCapsuleActivity,
  resolveCapsulePausedFromRunStatus,
  resolveCapsuleStatus,
  type CapsuleStatusKind,
} from './agentChatCapsuleModel'
import {
  consumeCapsuleMorph,
  getCapsuleMorphRevealDelayMs,
  shouldHideCapsuleForMorph,
} from './chatCapsuleMorph'

export interface AgentChatCapsuleProps {
  sessionId: string | null
  agentId: string | null
  agentName: string | null
  /** 未读从这个时间戳之后起算（进入 app-focus / 上次收起面板时刷新） */
  seenUntilTs: number
  /** 外层定位器正在拖拽；用于暂停会与直接操控叠加的 hover / press 位移。 */
  dragging?: boolean
  /** 在外层定位尚未提交时，为共享元素动画提供最终停靠矩形。 */
  resolveMorphTargetRect?: (measuredRect: DOMRect) => DOMRect
  onExpand: () => void
}

const STATUS_DOT_CLASS: Record<CapsuleStatusKind, string> = {
  ready: 'bg-muted-foreground/60',
  preparing: 'bg-accent',
  queued: 'bg-accent',
  thinking: 'bg-accent',
  planningNext: 'bg-accent',
  working: 'bg-accent',
  finishing: 'bg-accent',
  needsApproval: 'bg-warning',
  needsAnswer: 'bg-warning',
  /** 主动暂停：warning 色，但不进 ANIMATED（与 recovering 脉冲区分） */
  paused: 'bg-warning',
  recovering: 'bg-warning',
  complete: 'bg-success',
  stopped: 'bg-muted-foreground/60',
  error: 'bg-destructive',
}

const ANIMATED_STATUSES = new Set<CapsuleStatusKind>([
  'preparing',
  'queued',
  'thinking',
  'planningNext',
  'working',
  'finishing',
  'recovering',
])

function useCapsuleRuntimeStatus(sessionId: string | null, seenUntilTs: number) {
  const busy = useSessionBusy(sessionId)
  const messages = useChatStore(s => (sessionId ? s.messagesBySessionId[sessionId] : undefined))
  const pendingApproval = useChatStore(s => (
    sessionId ? !!s.pendingApprovalBySessionId[sessionId] : false
  ))
  const pendingAnswer = useChatStore(s => (
    sessionId ? !!s.pendingAskUserBySessionId[sessionId] : false
  ))
  const runState = useChatRuntimeStore(s => (
    sessionId ? s.runStateBySessionId[sessionId] : undefined
  ))
  const queuedCount = useChatRuntimeStore(s => (
    sessionId ? s.runProjectionBySessionId[sessionId]?.queuedRunIds.length ?? 0 : 0
  ))
  // 与 SessionStatusIcon 同口径：local overlay 优先，否则权威 run_state.status
  const effectiveRunStatus = useChatRuntimeStore(s => {
    if (!sessionId) return null
    const projection = s.runProjectionBySessionId[sessionId]
    return projection?.localStatus
      ?? projection?.authoritativeRunState?.status
      ?? null
  })
  const suspended = useWsConnectionStore(s => (
    sessionId ? s.suspendedSessionIds.includes(sessionId) : false
  ))
  const { unreadCount } = useMemo(
    () => resolveCapsuleActivity(messages ?? [], seenUntilTs),
    [messages, seenUntilTs],
  )
  const status = resolveCapsuleStatus({
    busy,
    runPhase: runState?.phase,
    completedToolCalls: runState?.completedToolCalls,
    queuedCount,
    pendingApproval,
    pendingAnswer,
    paused: resolveCapsulePausedFromRunStatus(effectiveRunStatus),
    suspended,
    unreadCount,
  })

  return { queuedCount, runState, status, unreadCount }
}

const TOOL_ACTIVITY_STATUSES = new Set<CapsuleStatusKind>([
  'planningNext',
  'working',
  'finishing',
])

function resolveToolActivityDisplay(
  status: CapsuleStatusKind,
  completedToolCalls: number,
  statusLabel: string,
  translateToolsUsed: (count: number) => string,
) {
  if (completedToolCalls <= 0 || !TOOL_ACTIVITY_STATUSES.has(status)) {
    return {
      accessibleLabel: statusLabel,
      toolCount: undefined,
    }
  }
  const toolsUsedLabel = translateToolsUsed(completedToolCalls)
  return {
    accessibleLabel: `${toolsUsedLabel}，${statusLabel}`,
    toolCount: completedToolCalls,
  }
}

const RollingToolCount: React.FC<{
  count: number
  reducedMotion: boolean
}> = ({ count, reducedMotion }) => (
  <span className="relative inline-flex h-4 min-w-[1ch] items-center justify-center overflow-hidden">
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span
        key={count}
        layout
        data-testid="capsule-tool-count"
        className="inline-block tabular-nums"
        initial={reducedMotion ? false : { opacity: 0, y: 7, filter: 'blur(1px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -7, filter: 'blur(1px)' }}
        transition={reducedMotion
          ? { duration: 0.1 }
          : { type: 'spring', bounce: 0, duration: 0.28 }}
      >
        {count}
      </motion.span>
    </AnimatePresence>
  </span>
)

const CapsuleStatusLine: React.FC<{
  accessibleLabel: string
  label: string
  reducedMotion: boolean
  status: CapsuleStatusKind
  toolCount?: number
  toolCountLabel: string
}> = ({
  accessibleLabel,
  label,
  reducedMotion,
  status,
  toolCount,
  toolCountLabel,
}) => (
  <span
    className="flex max-w-[270px] min-w-0 items-center gap-1.5 text-caption text-foreground-secondary"
    aria-live="polite"
    aria-atomic="true"
    aria-label={accessibleLabel}
  >
    <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
      {ANIMATED_STATUSES.has(status) && !reducedMotion ? (
        <motion.span
          className={cn('absolute h-2.5 w-2.5 rounded-full opacity-20', STATUS_DOT_CLASS[status])}
          animate={{ opacity: [0.16, 0, 0.16], scale: [0.7, 1.7, 0.7] }}
          transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity }}
        />
      ) : null}
      <span className={cn('relative h-1.5 w-1.5 rounded-full', STATUS_DOT_CLASS[status])} />
    </span>
    <span className="flex min-w-0 items-center gap-1" aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={status}
          layout
          className="truncate"
          initial={reducedMotion ? false : { opacity: 0, y: 3, filter: 'blur(2px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -3, filter: 'blur(2px)' }}
          transition={reducedMotion
            ? { duration: 0.12 }
            : { type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {label}
        </motion.span>
      </AnimatePresence>
      <AnimatePresence initial={false} mode="popLayout">
        {typeof toolCount === 'number' ? (
          <motion.span
            key="tool-activity"
            layout
            data-testid="capsule-tool-metric"
            title={toolCountLabel}
            className={cn(
              'flex h-4 shrink-0 items-center gap-0.5 rounded-full px-1',
              'bg-foreground/[0.05] text-foreground-tertiary dark:bg-foreground/[0.08]',
            )}
            initial={reducedMotion ? false : { opacity: 0, x: 4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -4 }}
            transition={reducedMotion
              ? { duration: 0.1 }
              : { type: 'spring', bounce: 0, duration: 0.28 }}
          >
            <Wrench className="h-3 w-3" strokeWidth={1.8} />
            <RollingToolCount count={toolCount} reducedMotion={reducedMotion} />
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  </span>
)

function resolveStatusTranslation(
  status: CapsuleStatusKind,
  counts: {
    queuedCount: number
    unreadCount: number
  },
) {
  return {
    key: `capsule.status.${status}`,
    values: {
      count: status === 'queued' ? counts.queuedCount : counts.unreadCount,
    },
  }
}

export const AgentChatCapsule: React.FC<AgentChatCapsuleProps> = ({
  sessionId,
  agentId,
  agentName,
  seenUntilTs,
  dragging = false,
  resolveMorphTargetRect,
  onExpand,
}) => {
  const { t } = useTranslation('chat')
  const reducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLButtonElement>(null)
  // 首渲前探测：pending 或 morph 播放中都隐藏（抗 Strict Mode 二次挂载已消费 pending）
  const skipFramerEnterRef = useRef(shouldHideCapsuleForMorph())
  const [revealed, setRevealed] = useState(() => !skipFramerEnterRef.current)
  const { queuedCount, runState, status, unreadCount } =
    useCapsuleRuntimeStatus(sessionId, seenUntilTs)
  const displayName = agentName ?? t('capsule.agentFallback')
  const agentSettings = useSpaceStore((s) => {
    if (!agentId) return undefined
    if (s.agentCache[agentId]?.settings) return s.agentCache[agentId]?.settings
    if (s.selectedAgent?.id === agentId) return s.selectedAgent.settings
    return undefined
  })
  const completedToolCalls = runState?.completedToolCalls ?? 0
  const statusTranslation = resolveStatusTranslation(status, {
    queuedCount,
    unreadCount,
  })
  const statusLabel = t(statusTranslation.key, statusTranslation.values)
  const toolActivity = resolveToolActivityDisplay(
    status,
    completedToolCalls,
    statusLabel,
    count => t('capsule.toolsUsed', { count }),
  )

  useLayoutEffect(() => {
    if (!rootRef.current) {
      skipFramerEnterRef.current = false
      setRevealed(true)
      return
    }
    const measuredRect = rootRef.current.getBoundingClientRect()
    consumeCapsuleMorph('to-capsule', rootRef.current, {
      finalRect: resolveMorphTargetRect?.(measuredRect) ?? measuredRect,
    })
    const delay = getCapsuleMorphRevealDelayMs()
    if (delay > 0) {
      // morph 结束后再露出实体，避免与 ghost 叠影
      const id = window.setTimeout(() => setRevealed(true), delay)
      return () => window.clearTimeout(id)
    }
    skipFramerEnterRef.current = false
    setRevealed(true)
  }, [resolveMorphTargetRect])

  const skipFramerEnter = skipFramerEnterRef.current

  return (
    <motion.button
      ref={rootRef}
      type="button"
      data-agent-chat-capsule
      layout
      initial={skipFramerEnter || reducedMotion ? false : { opacity: 0, scale: 0.94, y: 8 }}
      animate={{ opacity: revealed ? 1 : 0, scale: 1, y: 0 }}
      exit={reducedMotion
        ? { opacity: 0, transition: { duration: 0.12 } }
        : { opacity: 0, scale: 0.95, y: 8, transition: { duration: 0.16 } }}
      transition={
        skipFramerEnter || reducedMotion
          ? { duration: 0 }
          : {
              layout: { type: 'spring', bounce: 0, duration: 0.36 },
              opacity: { duration: 0.18 },
              scale: { type: 'spring', bounce: 0, duration: 0.36 },
              y: { type: 'spring', bounce: 0, duration: 0.36 },
            }
      }
      whileHover={reducedMotion || dragging ? undefined : { y: -1 }}
      whileTap={reducedMotion || dragging ? undefined : { scale: 0.97 }}
      onClick={onExpand}
      aria-hidden={!revealed}
      aria-label={`${displayName}，${toolActivity.accessibleLabel}。${t('capsule.expand')}`}
      className={cn(
        'relative flex h-12 max-w-[360px] items-center gap-2.5 rounded-full',
        'cursor-grab select-none pl-2 pr-3 text-left no-drag active:cursor-grabbing',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        OVERLAY_SURFACE_CLASS,
        // visibility 比单靠 opacity 更稳：避免 shadow/blur 在 opacity:0 时仍「透」出一帧
        !revealed && 'invisible pointer-events-none',
      )}
      title={t('capsule.expand')}
    >
      <span data-testid="capsule-agent-avatar" className="inline-flex shrink-0">
        <AgentAvatar
          agentId={agentId}
          name={displayName}
          avatarUrl={extractAgentAvatarUrl(agentSettings)}
          className="h-8 w-8"
        />
      </span>
      <span className="flex min-w-0 flex-col items-start">
        <span className="max-w-[270px] truncate text-body font-medium text-foreground">
          {displayName}
        </span>
        <CapsuleStatusLine
          accessibleLabel={toolActivity.accessibleLabel}
          label={statusLabel}
          reducedMotion={!!reducedMotion}
          status={status}
          toolCount={toolActivity.toolCount}
          toolCountLabel={t('capsule.toolsUsed', {
            count: toolActivity.toolCount ?? 0,
          })}
        />
      </span>
    </motion.button>
  )
}

/**
 * 跨 Agent 终端总览（PRD §5.5）
 *
 * 把「用户主动管理的终端会话」聚合到侧栏列表——本 Agent 置顶、其他 Agent 按
 * Space 分组。Agent 对话里的一次性命令默认只在聊天卡片里看；用户从卡片打开或
 * 自己「+ 新建终端」的会话才出现在此。
 *
 * 数据来源（侧边栏只展示「用户终端 + 用户从对话卡片显式打开的会话」）：
 *   - `useTerminalSessionStore.sessionsBySpace`：persist 到 localStorage 的会话。
 *   - Agent 一次性命令的隐藏 transcript（`transcriptsById`）**不进入侧边栏**，
 *     只在对话里的终端卡片查看；用户点卡片「打开终端」时才会 materialize 进
 *     sessionsBySpace 并出现在此列表。
 *
 * closed 保留策略：合并后对每个 Space 施加 `applyClosedRetention`（7 天 TTL +
 * 每 Space 50 条），与持久化 merge 同一套常量——保证用户终端与 Agent transcript
 * 统一遵守同策略。
 */

import { useMemo } from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useTerminalPaneStatusStore, type PaneStatus } from '@stores/useTerminalPaneStatusStore'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import i18n from '@/i18n'
import {
  applyClosedRetention,
  killPtySession,
  useAgentTerminalTranscriptStore,
  useTerminalSessionStore,
  type TerminalSession,
} from '@components/context-space/sources/terminal'
import type { ContextItem } from './registry/types'

/**
 * 是否为 Phase 2/4 的标签 scope 桶 key（desktop:* / conversation:*）而非真实 spaceId。
 * 跨 Agent 总览按真实 Space/Agent 分组，scope 桶（桌面/对话用户终端）不参与。
 */
function isScopeBucketKey(key: string): boolean {
  return key.startsWith('desktop:') || key.startsWith('conversation:')
}

const DESKTOP_TERMINAL_GROUP_ID = '__desktop_terminal__'

/** 执行设备徽标语义色（侧栏胶囊标签复用） */
export type ExecutionDeviceStatusTone = 'unbound' | 'offline' | 'remote'

/** 执行设备徽标（未绑定/离线/远程）——DesktopPanel 计算、总览按组复用 */
export interface ExecutionDeviceStatus {
  label: string
  title: string
  tone: ExecutionDeviceStatusTone
  /** 远程且执行设备离线时的第二枚标签（如「离线」） */
  secondaryLabel?: string
  secondaryTone?: ExecutionDeviceStatusTone
}

/**
 * 总览展示用的「真实运行态」（B1 治本）。
 *
 * 不再用 `TerminalSession.status`（active/closed，纯前端生命周期，用户终端进程退出
 * 时永不置 closed）判断「运行中」，而是以主进程 `pty:pane-status` 驱动的
 * `useTerminalPaneStatusStore`（running/idle/exited）为真实进程态来源——否则治假
 * 运行的工具自己假运行。
 */
export type TerminalRunState = 'running' | 'idle' | 'exited'

/**
 * 把「会话」+「真实进程态」收敛成展示态。口径（PRD §5.5 已决策 a 治本 + R3 P1-3）：
 *   - session.status==='closed'→ 已结束。**最优先**：本地已确定关闭应压过「可能残留
 *       的 running」paneStatus。主进程 PtyManager.kill 先 deleteSession 再 emit
 *       'exited'，此时 session 已 undefined → ipc.ts 的 onPaneStatus 走 else 分支只
 *       forward 给该 session 的 data 订阅者（终端 tab 开着才收），跨 Agent 总览作为
 *       全局订阅者收不到 exited → paneStatus 残留 running。把 closed 排在 paneStatus
 *       之前，「一键停」后徽标立刻变已结束、不再卡「运行中」。现有链路「关 tab 即
 *       kill+removeStatus」，closed 优先安全。
 *   - paneStatus === 'running' → 运行中（计入 runningCount，真实进程态最高可信度）
 *   - paneStatus === 'exited'  → 已结束（进程真的退了）
 *   - paneStatus === 'idle' / 无真实进程态（远程设备 / 整应用重启后 PTY 已不在）
 *       → 空闲/未知：既不标「运行中」（不再制造假运行），也未必结束
 *
 * 关键不变量：**本地确定 closed 即已结束；否则只有真实进程态为 running 才算运行中**。
 * 空闲 shell（idle）、命令早跑完的 user 终端（idle）都不会再被误计为运行中。
 */
export function resolveSessionRunState(
  session: Pick<TerminalSession, 'status'>,
  paneStatus: PaneStatus | undefined,
): TerminalRunState {
  if (session.status === 'closed') return 'exited'
  if (paneStatus === 'running') return 'running'
  if (paneStatus === 'exited') return 'exited'
  return 'idle'
}

const RUN_STATE_RANK: Record<TerminalRunState, number> = { running: 0, idle: 1, exited: 2 }

export interface TerminalOverviewGroup {
  spaceId: string
  /** 桌面终端组，不对应真实 Space。 */
  isDesktop?: boolean
  /** 当前 active Space（本 Agent）→ 置顶 */
  isCurrent: boolean
  /** Agent / Space 名字（workspace 的 name 即 Agent 名字）；未知时为空串，UI 兜底文案 */
  agentName: string
  /** Space 头像（图片 URL）；缺省时由 UI 退化为名字首字母 */
  /** 该组会话：运行中 → 空闲 → 已结束，组内按 createdAt 倒序 */
  sessions: TerminalSession[]
  /** 该组真实运行中（paneStatus===running）会话数 */
  runningCount: number
}

export interface TerminalOverview {
  groups: TerminalOverviewGroup[]
  /** 全部 Agent 真实运行中会话总数（用于终端行徽标） */
  runningCount: number
  /** 全部会话总数（用于判断是否展示总览） */
  totalCount: number
  /** sessionId → 展示用运行态（运行中/空闲/已结束），UI 据此渲染徽标 */
  runStateById: Record<string, TerminalRunState>
  /** sessionId → 是否「可在本机一键停」（本机有该 PTY 且未结束）。与设备徽标解耦（B3） */
  stoppableById: Record<string, boolean>
}

const EMPTY_OVERVIEW: TerminalOverview = {
  groups: [],
  runningCount: 0,
  totalCount: 0,
  runStateById: {},
  stoppableById: {},
}

export interface BuildTerminalOverviewArgs {
  sessionsBySpace: Record<string, TerminalSession[]>
  transcriptsById: Record<string, TerminalSession>
  spaceMeta: Record<string, { name?: string }>
  selectedSpaceId: string | null
  /**
   * sessionId → 真实进程态（来自 `useTerminalPaneStatusStore`，由主进程
   * `pty:pane-status` 驱动）。本机存活的 PTY（含 agent 命令）必有条目；
   * 缺条目 = 不在本机（远程 / 已被清理）。
   */
  paneStatusById: Record<string, PaneStatus>
}

/**
 * 纯函数：合并两路会话源 → 去重 → 保留策略 → 分组排序。导出以便单测覆盖
 * 「dedup 优先级 / closed 保留 / 本 Agent 置顶」等关键不变量。
 */
export function buildTerminalOverview({
  sessionsBySpace,
  transcriptsById: _transcriptsById,
  spaceMeta,
  selectedSpaceId,
  paneStatusById,
}: BuildTerminalOverviewArgs): TerminalOverview {
  const now = Date.now()

  // spaceId → (sessionId → session)，sessionsBySpace 优先
  const bySpace = new Map<string, Map<string, TerminalSession>>()
  const ensure = (spaceId: string): Map<string, TerminalSession> => {
    let m = bySpace.get(spaceId)
    if (!m) {
      m = new Map()
      bySpace.set(spaceId, m)
    }
    return m
  }

  for (const [bucketKey, sessions] of Object.entries(sessionsBySpace)) {
    if (!sessions?.length) continue
    const isScopeBucket = isScopeBucketKey(bucketKey)
    for (const session of sessions) {
      const targetGroupId = isScopeBucket
        ? (session.executionSpaceId || DESKTOP_TERMINAL_GROUP_ID)
        : bucketKey
      const m = ensure(targetGroupId)
      m.set(session.id, session)
    }
  }

  const groups: TerminalOverviewGroup[] = []
  const runStateById: Record<string, TerminalRunState> = {}
  const stoppableById: Record<string, boolean> = {}
  let totalRunning = 0
  let total = 0

  for (const [spaceId, sessionMap] of bySpace) {
    const retained = applyClosedRetention([...sessionMap.values()], now)
      // 已结束的 Agent 一次性会话（仅 materialize 过）不再占侧边栏
      .filter((s) => s.source !== 'agent' || s.status !== 'closed')
    if (retained.length === 0) continue

    // B1：用真实进程态算展示态——只有 paneStatus===running 才算运行中。
    let runningCount = 0
    for (const s of retained) {
      const runState = resolveSessionRunState(s, paneStatusById[s.id])
      runStateById[s.id] = runState
      // 可在本机一键停 = 本机有这个 PTY 条目（缺条目=不在本机）且未结束。
      // 与设备徽标解耦（B3）：不再用「设备徽标为 null」推断可停。
      stoppableById[s.id] =
        Object.prototype.hasOwnProperty.call(paneStatusById, s.id) && runState !== 'exited'
      if (runState === 'running') runningCount += 1
    }

    // 展示排序：运行中 → 空闲 → 已结束，同档内按 createdAt 倒序（最近在上）
    retained.sort((a, b) => {
      const rankA = RUN_STATE_RANK[runStateById[a.id]]
      const rankB = RUN_STATE_RANK[runStateById[b.id]]
      if (rankA !== rankB) return rankA - rankB
      return b.createdAt - a.createdAt
    })

    totalRunning += runningCount
    total += retained.length
    const meta = spaceMeta[spaceId]
    const isDesktop = spaceId === DESKTOP_TERMINAL_GROUP_ID
    groups.push({
      spaceId,
      isDesktop,
      isCurrent: !isDesktop && spaceId === selectedSpaceId,
      // 保持纯函数无 i18n 依赖（可单测 + 随语言切换刷新）：未知时留空，由 UI 兜底文案
      agentName: isDesktop ? 'Desktop' : (meta?.name?.trim() ?? ''),
      sessions: retained,
      runningCount,
    })
  }

  // 组排序：本 Agent 置顶 → 运行中多的在前 → 名字
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.runningCount !== b.runningCount) return b.runningCount - a.runningCount
    return a.agentName.localeCompare(b.agentName)
  })

  if (groups.length === 0) return EMPTY_OVERVIEW
  return { groups, runningCount: totalRunning, totalCount: total, runStateById, stoppableById }
}

export type TerminalFocusTarget =
  | { kind: 'openTab'; item: ContextItem }
  | { kind: 'session'; session: TerminalSession }

/**
 * 桌面侧栏点「终端」时的聚焦目标：优先已打开的终端 tab，否则最近的用户终端。
 * 不自动新建——新建仅走「+ 新建终端」。
 */
export function pickTerminalFocusTarget(
  spaceId: string,
  visibleItems: ContextItem[],
  overview: TerminalOverview,
): TerminalFocusTarget | null {
  for (let i = visibleItems.length - 1; i >= 0; i -= 1) {
    const item = visibleItems[i]
    if (item.type === 'terminal') {
      return { kind: 'openTab', item }
    }
  }

  const group = overview.groups.find((g) => g.spaceId === spaceId)
    ?? overview.groups.find((g) => g.isDesktop)
  const userSessions = (group?.sessions ?? []).filter(
    (s) => s.source === 'user' && s.status !== 'closed',
  )
  if (userSessions.length === 0) return null

  const latest = userSessions.reduce((best, s) => (s.createdAt > best.createdAt ? s : best))
  return { kind: 'session', session: latest }
}

/**
 * 跨 Agent 终端总览 hook。订阅两路会话源 + Space 元数据，memo 化聚合结果。
 */
export function useCrossAgentTerminalOverview(): TerminalOverview {
  const sessionsBySpace = useTerminalSessionStore((state) => state.sessionsBySpace)
  const transcriptsById = useAgentTerminalTranscriptStore((state) => state.transcriptsById)
  const paneStatuses = useTerminalPaneStatusStore((state) => state.statuses)
  const spaces = useSpaceStore((state) => state.spaces)
  const selectedSpaceId = useSpaceStore((state) => state.selectedSpace?.id ?? null)

  const spaceMeta = useMemo(() => {
    const map: Record<string, { name?: string }> = {}
    for (const space of spaces) {
      map[space.id] = { name: space.name }
    }
    return map
  }, [spaces])

  // 把 pane status store 的 { status, exitCode } 摊平成 sessionId → 进程态，喂给纯函数。
  const paneStatusById = useMemo(() => {
    const map: Record<string, PaneStatus> = {}
    for (const [id, entry] of Object.entries(paneStatuses)) map[id] = entry.status
    return map
  }, [paneStatuses])

  return useMemo(
    () => buildTerminalOverview({ sessionsBySpace, transcriptsById, spaceMeta, selectedSpaceId, paneStatusById }),
    [sessionsBySpace, transcriptsById, spaceMeta, selectedSpaceId, paneStatusById],
  )
}

/**
 * 打开 / 聚焦某个终端会话。
 *
 * 统一了「本 Agent」与「其他 Agent」的点击行为：
 *   - 先 `ensureSpaceSelectedWithFeedback` 切到目标 Space（本 Agent 时为 no-op，
 *     其他 Agent 时切到对应 Space）。
 *   - 会话若还没 materialize 到 sessionsBySpace（如隐藏的 agent transcript），
 *     先补登记；closed 会话补登记后立刻标回 closed，避免误显示成运行中。
 *   - `openResourceTab` 打开 / 聚焦终端 tab。
 *
 * 复用 `TerminalCard.handleJumpToTerminal` 的同款链路（切 Space → materialize →
 * openResourceTab），只是不在此持久化 PTY 快照（总览没有命令/输出上下文）。
 */
export async function openTerminalSession(session: TerminalSession): Promise<void> {
  const { spaceId, id } = session
  if (!spaceId || !id) return

  const isScopedSession = isScopeBucketKey(spaceId)
  const visibleBucketKey = isScopedSession && session.executionSpaceId
    ? session.executionSpaceId
    : spaceId
  // B5：ensureSpaceSelected 内部可能走网络 load（其他 Agent 的 Space 尚未同步），
  // 既可能返回 false（已 toast），也可能直接 throw（网络错误）——后者补 toast 兜底，
  // 避免 reject 静默 + unhandled rejection。
  if (!isScopedSession || session.executionSpaceId) {
    let didSelect = false
    try {
      didSelect = await ensureSpaceSelectedWithFeedback(visibleBucketKey, {
        failureToast: {
          title: i18n.t('desktop.terminalOverview.openFailed', {
            ns: 'context',
            defaultValue: '无法打开终端，所属 Agent 的工作空间不可用',
          }),
          variant: 'destructive',
        },
      })
    } catch {
      toast({
        title: i18n.t('desktop.terminalOverview.openFailed', {
          ns: 'context',
          defaultValue: '无法打开终端，所属 Agent 的工作空间不可用',
        }),
        variant: 'destructive',
      })
      return
    }
    if (!didSelect) return
  }

  const store = useTerminalSessionStore.getState()
  const alreadyMaterialized = (store.sessionsBySpace[visibleBucketKey] ?? []).some((s) => s.id === id)
  if (!alreadyMaterialized) {
    store.addSpaceSession(visibleBucketKey, id, session.title, session.source, session.cwd, session.executionSpaceId)
    if (session.status === 'closed') {
      store.markSpaceSessionClosed(visibleBucketKey, id)
    }
  }

  useSpaceContextTabsStore.getState().openResourceTab(visibleBucketKey, {
    type: 'terminal',
    id,
    title: session.title,
    meta: {
      source: session.source,
      status: session.status,
      cwd: session.cwd,
      createdAt: session.createdAt,
    },
  })
}

/**
 * 一键停：kill PTY 进程组（复用 `killPtySession`）。
 *
 * B3 假停止防护——成功反馈以**真 kill 到本机会话**为前提：
 *   - `killPtySession` 返回 true（本机确实杀到）→ 把两路会话源标 closed（幂等）+ 弹
 *     「已停止终端」成功 toast。
 *   - 返回 false（本机没有这个会话，多半在其他设备）→ **不**标 closed（避免本地把可能
 *     仍在远程跑的会话假性置结束），改弹「请到对应设备停止」，杜绝静默 no-op 却报成功。
 */
export async function stopTerminalSession(session: TerminalSession): Promise<void> {
  const { spaceId, id } = session
  if (!id) return
  const killed = await killPtySession(id)
  if (killed) {
    // R3 P1-3：清掉渲染端残留的 paneStatus。主进程 kill 先 deleteSession 再 emit
    // 'exited'，session 已不存在 → 跨 Agent 总览（全局订阅者）收不到 exited，
    // paneStatus 残留 running 会让徽标卡「运行中」直到重载。对齐既有关闭路径
    // （registry/handlers/terminal.tsx onClose 的 removeStatus）主动清除。
    useTerminalPaneStatusStore.getState().removeStatus(id)
    if (spaceId) {
      useTerminalSessionStore.getState().markSpaceSessionClosed(spaceId, id)
      if (isScopeBucketKey(spaceId) && session.executionSpaceId) {
        useTerminalSessionStore.getState().markSpaceSessionClosed(session.executionSpaceId, id)
      }
      useAgentTerminalTranscriptStore.getState().markTranscriptClosed(spaceId, id)
    }
    // 给「一键停」一个明确反馈——否则用户点完只看到徽标变「已结束」，会怀疑到底停没停。
    toast({
      title: i18n.t('desktop.terminalOverview.stopped', {
        ns: 'context',
        defaultValue: '已停止终端',
      }),
    })
    return
  }
  toast({
    title: i18n.t('desktop.terminalOverview.stopNotLocal', {
      ns: 'context',
      defaultValue: '未能在本机停止，请到对应设备停止',
    }),
    variant: 'destructive',
  })
}

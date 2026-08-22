/**
 * TerminalOverview — 桌面模式终端栏的「跨 Agent 终端总览」列表（PRD §5.5）
 *
 * 渲染在 DesktopPanel 终端行展开区：本 Agent 置顶、其他 Agent 按 Space 分组，
 * 每个会话带「运行中 / 空闲 / 已结束」徽标（基于真实进程态 paneStatus，B1 治本），
 * 本机可停的运行/空闲项可一键停。视觉全量复用 `sidebarUi` 常量，与桌面模式其余行
 * 保持一致。
 */

import React, { useState } from 'react'
import { Terminal, Bot, Square, Plus, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { contextRegistry } from './registry'
import type { TerminalSession } from '@components/context-space/sources/terminal'
import {
  openTerminalSession,
  stopTerminalSession,
  type ExecutionDeviceStatus,
  type TerminalRunState,
  type TerminalOverview as TerminalOverviewData,
  type TerminalOverviewGroup,
} from './terminalOverviewModel'
import { ExecutionDeviceStatusTag } from './ExecutionDeviceStatusTag'
import {
  SIDEBAR_ROW_NESTED,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_BADGE,
  SIDEBAR_COUNT,
  SIDEBAR_ICON,
  SIDEBAR_META,
  SIDEBAR_SUBSECTION_LABEL,
  SIDEBAR_EMOJI_ACTIVE,
  SIDEBAR_EMOJI_INACTIVE,
  SIDEBAR_LINK_ACTION,
  SIDEBAR_ROW_LIST,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'

/** 工作空间是执行现场，终端分组仅显示名称首字母，不展示可配置头像。 */
const WorkspaceMarker: React.FC<{ name: string }> = ({ name }) => (
  <span className="h-3.5 w-3.5 shrink-0 rounded bg-foreground/[0.06] text-accent-text text-caption font-semibold flex items-center justify-center select-none leading-none">
    {name.charAt(0) || '#'}
  </span>
)

/** 新建终端入口（空态与列表底部复用同一行） */
const NewTerminalRow: React.FC<{ onCreate: () => void }> = ({ onCreate }) => {
  const { t } = useTranslation('context')
  return (
    <div className={cn(SIDEBAR_ROW_NESTED, 'flex select-none items-center px-3 py-1')}>
      <button
        type="button"
        className={cn(SIDEBAR_LINK_ACTION, 'flex items-center gap-1')}
        onClick={onCreate}
      >
        <Plus className="h-3 w-3" />
        <span>{t('desktop.terminalOverview.newTerminal', { defaultValue: '新建终端' })}</span>
      </button>
    </div>
  )
}

const TerminalSessionRow: React.FC<{
  session: TerminalSession
  isActive: boolean
  /** 真实进程态：运行中 / 空闲 / 已结束（B1） */
  runState: TerminalRunState
  /** true = 本机有该 PTY 且未结束，可一键停；false = 在远程/离线/已退出，本机 kill 不到 */
  stoppable: boolean
  /** 不可停时的原因（设备 title），用于 tooltip */
  notStoppableHint?: string
}> = ({ session, isActive, runState, stoppable, notStoppableHint }) => {
  const { t } = useTranslation('context')
  const [isOpening, setIsOpening] = useState(false)
  const isExited = runState === 'exited'
  const isRunning = runState === 'running'

  // B5：切 Space 可能走网络 load（慢/可能 throw）——给行 loading + disabled 反馈，
  // 并对 reject 路径 .catch 兜底（失败 toast 已在 openTerminalSession 内处理）。
  const handleOpen = () => {
    if (isOpening) return
    setIsOpening(true)
    openTerminalSession(session)
      .catch(() => { /* 失败反馈已在 openTerminalSession 内 toast */ })
      .finally(() => setIsOpening(false))
  }

  return (
    <TooltipProvider delayDuration={500}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuItem
            as="div"
            role="button"
            tabIndex={0}
            aria-busy={isOpening}
            active={isActive}
            className={cn(SIDEBAR_ROW_NESTED, 'group/term cursor-pointer select-none', isExited && 'opacity-60', isOpening && 'opacity-70')}
            onClick={handleOpen}
            onKeyDown={(e) => { if (e.key === 'Enter') handleOpen() }}
          >
        <span className={cn(
          SIDEBAR_ICON,
          'flex items-center justify-center',
          isActive ? SIDEBAR_EMOJI_ACTIVE : SIDEBAR_EMOJI_INACTIVE,
        )}>
          {isOpening ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : session.source === 'agent' ? (
            <span className="relative inline-flex h-3.5 w-3.5">
              <Terminal className="h-3.5 w-3.5" />
              <Bot className="absolute -top-1 -right-1 h-2 w-2 text-accent-text" />
            </span>
          ) : (
            <Terminal className="h-3.5 w-3.5" />
          )}
        </span>
        <span
          className={cn(SIDEBAR_ROW_LABEL_GROW, isActive && SIDEBAR_ROW_LABEL_ACTIVE)}
          title={session.title}
        >
          {session.title}
        </span>
        {isRunning ? (
          <span className="shrink-0 inline-flex items-center gap-1 text-caption text-warning/80 tabular-nums">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            {t('desktop.terminalOverview.running', { defaultValue: '运行中' })}
          </span>
        ) : isExited ? (
          <span className={SIDEBAR_BADGE}>
            {t('desktop.terminalOverview.ended', { defaultValue: '已结束' })}
          </span>
        ) : (
          // idle / 未知：既不标「运行中」（不再假运行），也未必结束 → 中性「空闲」
          <span className={SIDEBAR_BADGE}>
            {t('desktop.terminalOverview.idle', { defaultValue: '空闲' })}
          </span>
        )}
        {/* 停止控件：
            - 本机可停（running/idle 的本机 PTY）→ 实心一键停按钮。
            - 仅当「确在远程/其他设备运行」（running 且本机不可停）→ 禁用态 + 去对应设备停提示。
            - idle/未知且本机不可停（如可重开的历史终端）→ 不显示任何停止控件：没有在跑的
              进程可停，更不该误称「在其他设备运行」。
            - 已结束 → 无控件。 */}
        {stoppable ? (
          <button
            type="button"
            className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-0 group-hover/term:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
            title={t('desktop.terminalOverview.stop', { defaultValue: '停止此终端' })}
            onClick={(e) => { e.stopPropagation(); void stopTerminalSession(session) }}
          >
            <Square className="h-2.5 w-2.5 fill-current" />
          </button>
        ) : isRunning ? (
          <span
            className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-40 cursor-not-allowed"
            title={notStoppableHint || t('desktop.terminalOverview.stopRemote', {
              defaultValue: '该终端在其他设备上运行，需到对应设备停止',
            })}
          >
            <Square className="h-2.5 w-2.5" />
          </span>
        ) : null}
          </SidebarMenuItem>
        </TooltipTrigger>
        <TooltipContent side="right">{session.title}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const TerminalOverviewGroupView: React.FC<{
  group: TerminalOverviewGroup
  activeTabKey: string | null
  deviceStatus: ExecutionDeviceStatus | null
  runStateById: Record<string, TerminalRunState>
  stoppableById: Record<string, boolean>
}> = ({ group, activeTabKey, deviceStatus, runStateById, stoppableById }) => {
  const { t } = useTranslation('context')
  const displayName = group.agentName || t('desktop.terminalOverview.unknownAgent', { defaultValue: '未知 Agent' })

  return (
    <div className={cn('flex flex-col', SIDEBAR_ROW_LIST)}>
      {/* 分组标题：工作空间标识 + 名字（本 Agent 附「当前」标），右侧设备/运行数徽标。
          排版对齐 sidebarUi 的 SIDEBAR_SUBSECTION_LABEL（text-caption/font-medium/
          text-muted-foreground/60）——因要在 flex 行里并排头像/徽标，未整体套用该常量
          （它含 px-3 pb-0.5 的块级内边距），仅对齐其字号/字重/透明度 token。 */}
      <div className={cn(SIDEBAR_ROW_NESTED, 'flex select-none items-center gap-1.5 px-3 pt-1 pb-0.5 min-w-0')}>
        <WorkspaceMarker name={displayName} />
        <span className="truncate min-w-0 flex-1 text-caption font-medium text-muted-foreground/60">
          {displayName}
          {group.isCurrent && (
            <span className="ml-1 text-muted-foreground/60 font-normal">
              · {t('desktop.terminalOverview.current', { defaultValue: '当前' })}
            </span>
          )}
        </span>
        {deviceStatus && (
          <ExecutionDeviceStatusTag status={deviceStatus} />
        )}
        {group.runningCount > 0 && (
          <span className={SIDEBAR_COUNT} title={t('desktop.terminalOverview.runningCount', {
            count: group.runningCount,
            defaultValue: `${group.runningCount} 个运行中`,
          })}>
            {group.runningCount}
          </span>
        )}
      </div>
      {group.sessions.map((session) => {
        const tabKey = contextRegistry.buildTabKey('terminal', session.id)
        const isActive = group.isCurrent && tabKey === activeTabKey
        return (
          <TerminalSessionRow
            key={session.id}
            session={session}
            isActive={isActive}
            runState={runStateById[session.id] ?? 'idle'}
            stoppable={stoppableById[session.id] ?? false}
            notStoppableHint={deviceStatus?.title}
          />
        )
      })}
    </div>
  )
}

interface TerminalOverviewProps {
  overview: TerminalOverviewData
  activeTabKey: string | null
  /** 按 spaceId 解析对应 Agent 的执行设备状态（未绑定/离线/远程）；本机返回 null */
  resolveDeviceStatus: (spaceId: string) => ExecutionDeviceStatus | null
  /** 在当前 Agent 的 Space 新建终端（受控制设备限制时由上游 toast 提示） */
  onCreateTerminal?: () => void
}

export const TerminalOverview: React.FC<TerminalOverviewProps> = ({
  overview,
  activeTabKey,
  resolveDeviceStatus,
  onCreateTerminal,
}) => {
  const { t } = useTranslation('context')

  // B5：空态不再 return null——给「+ 新建终端」入口 + 一句安心话，缓解「全静默 =
  // 是不是哪里挂了」的焦虑。
  if (overview.groups.length === 0) {
    return (
      <div className="mb-0.5 flex select-none flex-col gap-0.5">
        <div className={cn(SIDEBAR_ROW_NESTED, 'px-3 py-1')}>
          <span className={SIDEBAR_META}>
            {t('desktop.terminalOverview.empty', { defaultValue: '还没有终端在跑' })}
          </span>
        </div>
        {onCreateTerminal && <NewTerminalRow onCreate={onCreateTerminal} />}
      </div>
    )
  }

  // B5：本 Agent 置顶后插一条「其他 Agent」分隔，提升多 Agent 场景的扫描性。
  const firstOtherIndex = overview.groups.findIndex((g) => !g.isCurrent)
  const showOtherSeparator = firstOtherIndex > 0

  return (
    <div className="mb-0.5 flex select-none flex-col gap-0.5">
      {overview.groups.map((group, i) => (
        <React.Fragment key={group.spaceId}>
          {showOtherSeparator && i === firstOtherIndex && (
            <div className={cn(SIDEBAR_SUBSECTION_LABEL, 'pt-1.5')}>
              {t('desktop.terminalOverview.otherAgents', { defaultValue: '其他 Agent' })}
            </div>
          )}
          <TerminalOverviewGroupView
            group={group}
            activeTabKey={activeTabKey}
            deviceStatus={group.isDesktop ? null : resolveDeviceStatus(group.spaceId)}
            runStateById={overview.runStateById}
            stoppableById={overview.stoppableById}
          />
        </React.Fragment>
      ))}
      {onCreateTerminal && <NewTerminalRow onCreate={onCreateTerminal} />}
    </div>
  )
}

TerminalOverview.displayName = 'TerminalOverview'

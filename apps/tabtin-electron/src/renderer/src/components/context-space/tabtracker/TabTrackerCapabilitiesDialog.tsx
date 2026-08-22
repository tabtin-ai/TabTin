/**
 * TabTrackerCapabilitiesDialog — Tracker / 自动化 全部 CLI 能力总览弹窗
 *
 * 数据来自 generated/tracker-capabilities.json（Go CLI tracker_showcase 注册表生成）。
 * 按分组展示 Short/Long help 文案；点「交给 Tin」把 NL 任务发给 Agent。
 * 主场景：用户逐条「回归」自动化能力——点一条，Agent 就用对应 CLI 跑一遍，肉眼看结果。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Search, Sparkles } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  Input,
  ScrollArea,
} from '@components/ui'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { ContextDialogHeader } from '../ContextDialogHeader'
import {
  buildAgentPromptForCommand,
  formatTrackerCliName,
  groupTrackerCommands,
  riskLabel,
  trackerCapabilitiesManifest,
  type TrackerCapabilityCommand,
} from './trackerCapabilities'
import { requestAgentForTracker } from './requestAgentForTracker'

interface TabTrackerCapabilitiesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  spaceId: string
}

function matchesQuery(cmd: TrackerCapabilityCommand, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    cmd.name.toLowerCase().includes(q)
    || cmd.short.toLowerCase().includes(q)
    || cmd.long.toLowerCase().includes(q)
    || cmd.group_label.toLowerCase().includes(q)
  )
}

export const TabTrackerCapabilitiesDialog: React.FC<TabTrackerCapabilitiesDialogProps> = ({
  open,
  onOpenChange,
  spaceId,
}) => {
  const [query, setQuery] = useState('')

  const grouped = useMemo(() => groupTrackerCommands(), [])

  const filteredGroups = useMemo(() => {
    return grouped
      .map(({ group, commands }) => ({
        group,
        commands: commands.filter(cmd => matchesQuery(cmd, query)),
      }))
      .filter(entry => entry.commands.length > 0)
  }, [grouped, query])

  const handleAssign = useCallback((cmd: TrackerCapabilityCommand) => {
    if (!spaceId) return
    void requestAgentForTracker(spaceId, buildAgentPromptForCommand(cmd))
    onOpenChange(false)
  }, [onOpenChange, spaceId])

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) setQuery('')
    onOpenChange(next)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0 z-modal">
        <ContextDialogHeader
          icon={<Sparkles className="h-7 w-7" />}
          title="自动化能力总览"
          description={(
            <>
            与 <code className={CANVAS_TEXT_META}>tabtin tracker</code> CLI 一一对应，共 {trackerCapabilitiesManifest.commands.length} 条能力。点「交给 Tin」即逐条回归。
            </>
          )}
        >
          <div className="relative pt-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索命令或说明…"
              className="pl-8 h-8 text-body"
            />
          </div>
        </ContextDialogHeader>

        <ScrollArea className="flex-1 min-h-0 px-5 pb-5">
          <div className="space-y-5 pr-3">
            {filteredGroups.length === 0 ? (
              <p className="text-body text-muted-foreground/80 py-8 text-center">
                没有匹配的能力
              </p>
            ) : filteredGroups.map(({ group, commands }) => (
              <section key={group.id}>
                <h3 className="text-body font-medium text-foreground/90 mb-2">
                  {group.label}
                  <span className={cn('font-normal', 'ml-1.5', CANVAS_TEXT_META)}>
                    {commands.length}
                  </span>
                </h3>
                <ul className="space-y-2">
                  {commands.map(cmd => {
                    const risk = riskLabel(cmd.risk)
                    return (
                      <li
                        key={cmd.name}
                        className="rounded-md border border-border/40 px-3 py-2.5 hover:border-primary/30 hover:bg-muted/15 transition-colors"
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="text-body font-medium text-foreground/90">
                                {cmd.short}
                              </span>
                              {risk && (
                                <span className={cn(
                                  'px-1.5 py-0.5 rounded',
                                  CANVAS_TEXT_MICRO,
                                  cmd.risk === 'high-risk-write'
                                    ? 'bg-destructive/10 text-destructive/80'
                                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-400/90',
                                )}>
                                  {risk}
                                </span>
                              )}
                            </div>
                            <p className={cn('font-mono', 'mt-0.5', 'truncate', CANVAS_TEXT_META)}>
                              {formatTrackerCliName(cmd.name)}
                            </p>
                            {cmd.long && (
                              <p className={cn('leading-relaxed', 'mt-1.5', 'line-clamp-3', 'whitespace-pre-line', CANVAS_TEXT_META)}>
                                {cmd.long}
                              </p>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={cn('shrink-0', 'h-7', CANVAS_TEXT_META)}
                            onClick={() => handleAssign(cmd)}
                          >
                            交给 Tin
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

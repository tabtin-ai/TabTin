/**
 * 外部 Agent 导入——悬浮进度面板（Layer D，PRD §4.4）。
 *
 * 形态复用 `UploadNotificationPanel`（右下角浮动、可折叠），订阅 `useImportJobStore`。
 * 价值：用户离开导入页后，导入仍在后台跑，进度不丢——面板兜住
 * 「后台进行、期间可正常使用」。
 *
 * 成功完成后侧栏已有档案入口，不再挂「导入完成」toast；失败 / 取消仍提示。
 * job 回到 idle（结果页点完成后 reset）则自动隐藏。
 */

import React, { useEffect, useState } from 'react'
import { Loader2, XCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useImportJobStore } from './useImportJobStore'

export const ImportProgressPanel: React.FC = () => {
  const job = useImportJobStore()
  const isImportPageOpen = useAppPageStore((s) => s.activePage === 'import')
  const [collapsed, setCollapsed] = useState(false)
  const reset = useImportJobStore((s) => s.reset)

  // 成功结果已落侧栏，不必再挂完成 toast
  useEffect(() => {
    if (job.state === 'completed' && !isImportPageOpen) {
      reset()
    }
  }, [job.state, isImportPageOpen, reset])

  // 导入页打开时进度已在页内显示，面板让位避免重复。idle / 刚完成亦不显示。
  if (
    job.state === 'idle'
    || job.state === 'completed'
    || isImportPageOpen
  ) {
    return null
  }

  const pct = job.overall.total > 0 ? Math.round((job.overall.done / job.overall.total) * 100) : 0
  const running = job.state === 'running'

  const headerText = running
    ? `正在导入 ${job.overall.done}/${job.overall.total}`
    : job.state === 'cancelled'
      ? '导入已取消'
      : '导入失败'

  return (
    <div
      data-import-float-panel=""
      className="pointer-events-auto fixed bottom-4 right-4 z-toast w-80 overflow-hidden rounded-lg border border-border/40 bg-background/95 shadow-xl backdrop-blur-sm"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-body font-medium transition-colors hover:bg-muted/10"
        onClick={() => setCollapsed((v) => !v)}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="flex-1 text-left">{headerText}</span>
        {collapsed ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="space-y-2 border-t border-border/20 px-3 py-2.5">
          {running && (
            <>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/30">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {job.currentWorkspace && (
                <div className="truncate font-mono text-[11px] text-muted-foreground/70">
                  {job.currentWorkspace}
                  {job.phase ? `（${job.phase}）` : ''}
                </div>
              )}
            </>
          )}
          {!running && job.report && (
            <div className="text-caption text-muted-foreground/80">
              已成功导入{' '}
              {job.report.visible + job.report.archived + job.report.titleOnly} 条对话
              {job.report.failed > 0 ? `，${job.report.failed} 条失败` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

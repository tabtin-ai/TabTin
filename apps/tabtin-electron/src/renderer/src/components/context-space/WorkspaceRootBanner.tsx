/**
 * WorkspaceRootBanner — Space 顶部「执行根不可达」横幅（RT-3）
 *
 * 进 Space 主动探测执行根（Agent working_dir）；不可达时在工作台顶部贴一条横幅，
 * 明确告知「工作目录 X 不可访问（可能被移动/改名/删除，或外置盘未挂载）」并给出
 * 两个恢复动作：**重试**（外置盘挂回等临时失联）与**重新选择…**（换目录）。
 *
 * 与 `OrchestrationSection`（起始页整页失效卡）的分工：那张卡只在 orchestration
 * 起始页 tab 上可见；本横幅在**任意工作台 tab**之上常驻，让用户在 chat 之外的任何
 * 面板都能第一时间看到 + 一键恢复。
 *
 * **护栏**：只引导用户显式 reselect（`working-dir` 设置面板复用既有 `ProfileWorkingDirForm`
 * → `updateAgent` → PUT /agents/{id}），绝不静默换根（守单根契约 + 透明）。
 *
 * **布局**：只在异常态渲染为 ContentArea 顶部横幅，参与工作台 flex 流，避免和
 * 起始页失效引导 / tab 内容互相覆盖。
 */
import React, { useCallback } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useWorkspaceRootHealth } from './hooks/useWorkspaceRootHealth'

interface WorkspaceRootBannerProps {
  spaceId: string | null
}

export const WorkspaceRootBanner: React.FC<WorkspaceRootBannerProps> = ({ spaceId }) => {
  const { t } = useTranslation('space')
  const openSheet = useAgentSettingsSheetStore((s) => s.open)
  const { status, workingDir, retry } = useWorkspaceRootHealth(spaceId)

  const handleRelocate = useCallback(() => {
    // relocate: true → 打开设置的同时弹出系统选目录器（只开面板用户会以为「重新选择」没反应）
    if (spaceId) openSheet('working-dir', spaceId, { relocate: true })
  }, [openSheet, spaceId])

  if (status !== 'unreachable') return null

  return (
    <div
      role="alert"
      className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-destructive/30 bg-destructive/10"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive/80" />
      <div className="flex-1 min-w-0 flex items-baseline gap-2 flex-wrap">
        <span className="text-caption font-medium text-foreground/90">
          {t('workingDir.bannerTitle', { defaultValue: 'Agent 工作目录不可访问' })}
        </span>
        <span className="text-caption font-mono text-muted-foreground/60 truncate max-w-[40ch]">
          {workingDir}
        </span>
        <span className="text-caption text-muted-foreground/60">
          {t('workingDir.bannerHint', {
            defaultValue: '可能被移动、改名或删除，或外置盘未挂载。',
          })}
        </span>
      </div>
      <Button onClick={retry} variant="ghost" size="sm" className="shrink-0 gap-1">
        <RefreshCw className="h-3.5 w-3.5" />
        {t('workingDir.retryAction', { defaultValue: '重试' })}
      </Button>
      <Button onClick={handleRelocate} variant="outline" size="sm" className="shrink-0">
        {t('workingDir.relocateAction', { defaultValue: '重新选择...' })}
      </Button>
    </div>
  )
}

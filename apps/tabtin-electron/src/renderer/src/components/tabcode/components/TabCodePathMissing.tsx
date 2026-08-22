/**
 * TabCodePathMissing — 项目根目录已不存在的占位
 *
 * 触发场景：
 * - 用户改了 Agent.working_dir 但旧目录没清理
 * - 项目放在外接盘 / 网络盘，盘 unmount / 掉线
 * - working_dir 被 mv / rm
 *
 * 此时 TabCode 不能正常工作（gitStatus / chunker / checkpoint 全部依赖
 * 真实目录），原代码会让底层 git 命令报 `fatal: Invalid path ...`
 * 冒到用户面前。本组件用产品语言告诉用户「目录不在了」，给出可能原因，
 * 并引导去 Agent 设置改 working_dir。
 *
 * 阶段 0 止血（§3.8）：**移除「清理撤销快照」
 * 按钮**——它走 `checkpointIpc.destroy`（删 shadow git 目录），属于 shadow-git
 * 体系的危险 / 即将下线入口，止血阶段一并摘除；shadow git 数据回收留待后续
 * ui-offline / 阶段 5 统一处理。
 *
 * 单根契约下（`docs/single-root-space-prd.md`），不再提供"打开其他项目"按钮——
 * 用户要换工作目录请到 Agent 设置面板改 working_dir，要看别的项目请新建 Space。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderX, Settings } from 'lucide-react'
import { Button, EmptyState } from '@tabtin/smartsheet-ui'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useSpaceStore } from '@stores/useSpaceStore'

interface TabCodePathMissingProps {
  rootPath: string
}

export const TabCodePathMissing: React.FC<TabCodePathMissingProps> = ({
  rootPath,
}) => {
  const { t } = useTranslation('tabcode')

  const handleOpenSettings = useCallback(() => {
    const spaceId = useSpaceStore.getState().selectedSpace?.id
    if (!spaceId) return
    useAgentSettingsSheetStore.getState().open('working-dir', spaceId)
  }, [])

  return (
    <div className="flex h-full items-center justify-center bg-background px-4">
      <div className="flex max-w-[420px] flex-col items-center gap-3">
        <EmptyState
          icon={<FolderX className="h-5 w-5" strokeWidth={1.5} />}
          title={t('pathMissing.title')}
          description={t('pathMissing.description')}
          size="md"
          tone="warning"
          className="max-w-[420px]"
        />

        <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-caption font-mono text-muted-foreground/90">
          {rootPath}
        </code>

        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleOpenSettings}>
            <Settings className="mr-1 h-3.5 w-3.5" />
            {t('pathMissing.gotoSettings', { defaultValue: '修改工作空间' })}
          </Button>
        </div>
      </div>
    </div>
  )
}

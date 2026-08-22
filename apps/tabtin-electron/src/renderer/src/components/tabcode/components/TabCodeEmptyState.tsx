/**
 * TabCode 空状态
 *
 * 单根产品契约下（见 `docs/single-root-space-prd.md` §2.1），TabCode 的"项目根"
 * 永远是该 Space 绑定 Agent 的 `working_dir`。`working_dir` 没设置时，TabCode
 * 无法工作，引导用户去设置面板配置而不是让用户挑目录（没用——挑了也不会被接受）。
 */

import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderCode, ArrowRight } from 'lucide-react'
import { Button, EmptyState } from '@tabtin/smartsheet-ui'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useSpaceStore } from '@stores/useSpaceStore'

export const TabCodeEmptyState: React.FC = () => {
  const { t } = useTranslation('tabcode')

  const handleSetupWorkingDir = useCallback(() => {
    const spaceId = useSpaceStore.getState().selectedSpace?.id
    if (!spaceId) return
    useAgentSettingsSheetStore.getState().open('working-dir', spaceId)
  }, [])

  return (
    <div className="flex h-full items-center justify-center bg-background px-4">
      <EmptyState
        icon={<FolderCode className="h-5 w-5" strokeWidth={1.5} />}
        title={t('empty.title', { defaultValue: 'Agent 还没设置工作目录' })}
        description={t('empty.description', {
          defaultValue: '到 Agent 设置面板配置一个本地目录，TabCode 就能开始工作了',
        })}
        size="md"
        tone="info"
        className="max-w-[320px]"
        action={(
          <Button variant="ghost" size="sm" onClick={handleSetupWorkingDir}>
            {t('empty.setupWorkingDir', { defaultValue: '前往设置' })}
            <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Button>
        )}
      />
    </div>
  )
}

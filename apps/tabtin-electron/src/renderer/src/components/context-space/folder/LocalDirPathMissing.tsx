/**
 * LocalDirPathMissing — 本地目录根路径已不可达的整页降级
 *
 * 对齐 TabCodePathMissing：Finder 改名/移动/外置盘卸载后，不再静默空白树，
 * 而是用产品语言说明原因，并给出「重试 / 重新选择」。
 *
 * - workspace：执行根失效 → 打开 working-dir 设置（显式重绑，不静默换根）
 * - user：用户添加目录失效 → 系统选目录后由上层更新 store + tab
 */

import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderX, RefreshCw, Settings } from 'lucide-react'
import { Button, EmptyState } from '@tabtin/smartsheet-ui'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { createLogger } from '@/utils/logger'

const log = createLogger('LocalDirPathMissing')

export type LocalDirRelocateMode = 'workspace' | 'user'

interface LocalDirPathMissingProps {
  rootPath: string
  relocateMode: LocalDirRelocateMode
  spaceId?: string | null
  onRetry: () => void
  /** user 模式：用户选了新目录后回调；workspace 模式不使用 */
  onUserRelocate?: (newPath: string) => void | Promise<void>
}

export const LocalDirPathMissing: React.FC<LocalDirPathMissingProps> = ({
  rootPath,
  relocateMode,
  spaceId,
  onRetry,
  onUserRelocate,
}) => {
  const { t } = useTranslation('context')
  const [relocating, setRelocating] = useState(false)
  const [relocateError, setRelocateError] = useState<string | null>(null)

  const handleWorkspaceRelocate = useCallback(() => {
    const resolvedSpaceId = spaceId || useSpaceStore.getState().selectedSpace?.id
    if (!resolvedSpaceId) return
    useAgentSettingsSheetStore.getState().open('working-dir', resolvedSpaceId, { relocate: true })
  }, [spaceId])

  const handleUserRelocate = useCallback(async () => {
    if (!onUserRelocate) return
    const tabtin = window.tabtin
    if (!tabtin?.showOpenDialog) {
      setRelocateError(
        t('folder.errors.openFolderDescription', {
          defaultValue: '当前环境不支持文件夹选择。',
        }),
      )
      return
    }
    setRelocating(true)
    setRelocateError(null)
    try {
      const picked = await tabtin.showOpenDialog({ properties: ['openDirectory'] })
      const nextPath = picked?.[0]
      if (!nextPath) return
      await onUserRelocate(nextPath)
    } catch (err) {
      log.error('user relocate failed', {
        errorType: err instanceof Error ? err.name : typeof err,
      })
      setRelocateError(
        formatIpcErrorForUser(
          err,
          t('folder.errors.relocateFailed', { defaultValue: '重新选择目录失败' }),
        ),
      )
    } finally {
      setRelocating(false)
    }
  }, [onUserRelocate, t])

  const handleRelocate = relocateMode === 'workspace' ? handleWorkspaceRelocate : () => {
    void handleUserRelocate()
  }

  return (
    <div className="flex h-full items-center justify-center bg-background px-4">
      <div className="flex max-w-[420px] flex-col items-center gap-3">
        <EmptyState
          icon={<FolderX className="h-5 w-5" strokeWidth={1.5} />}
          title={t('folder.pathMissing.title', {
            defaultValue: '目录不可访问',
          })}
          description={t('folder.pathMissing.description', {
            defaultValue: '目录可能被移动、改名或删除，或外置盘未挂载。请重试，或重新选择目录。',
          })}
          size="md"
          tone="warning"
          className="max-w-[420px]"
        />

        <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-caption font-mono text-muted-foreground/90">
          {rootPath}
        </code>

        {relocateError ? (
          <p className="max-w-full text-center text-caption text-destructive/90">
            {relocateError}
          </p>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {t('folder.pathMissing.retry', { defaultValue: '重试' })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRelocate}
            disabled={relocating}
          >
            <Settings className="mr-1 h-3.5 w-3.5" />
            {relocateMode === 'workspace'
              ? t('folder.pathMissing.gotoSettings', { defaultValue: '重新选择工作目录…' })
              : t('folder.pathMissing.reselect', { defaultValue: '重新选择…' })}
          </Button>
        </div>
      </div>
    </div>
  )
}

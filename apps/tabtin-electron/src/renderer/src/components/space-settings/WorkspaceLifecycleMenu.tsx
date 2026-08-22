/**
 * Workspace 生命周期入口（删除 / 回收站 / 归档）
 *
 * Workspace 设置页走 AgentProfilePane；入口放在页面底部「危险操作」区，
 * 避免右上角 ⋯ 把破坏性操作藏进菜单。Agent 停用仍只在「我的 Agent」详情危险区。
 */

import React, { useState } from 'react'
import {
  AlertTriangle,
  Trash2,
  Archive,
} from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  toast,
} from '@tabtin/smartsheet-ui'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useAuthStore } from '@stores/useAuthStore'
import { canManageSpaceLifecycle } from '@/hooks/useCanManageSpaceLifecycle'
import { SettingsNameConfirmDialog } from '@components/settings/SettingsNameConfirmDialog'
import { confirmDirtyBeforeSpaceDelete } from '@components/context-space/dirtyExitConfirm/spaceDeleteGuard'
import { SPACE_ARCHIVE_UI_ENABLED, SPACE_TRASH_UI_ENABLED } from '@/utils/featureFlags'
import {
  SETTINGS_CONTROL_SM,
  SETTINGS_HINT,
  SETTINGS_SECTION_TITLE,
} from '@components/settings/settingsUi'
import { cn } from '@utils/cn'
import type { Space } from '@tabtin/app-shell'
import { useSpaceDeleteGuard } from './hooks/useSpaceDeleteGuard'

interface WorkspaceLifecycleMenuProps {
  space: Space
}

export const WorkspaceLifecycleMenu: React.FC<WorkspaceLifecycleMenuProps> = ({
  space,
}) => {
  const { t } = useTranslation('space')
  const agent = useSpaceStore((state) => state.selectedAgent)
  const { deleteSpace, archiveSpace, loadSpaces, isLoading } = useSpaceStore(
    useShallow((s) => ({
      deleteSpace: s.deleteSpace,
      archiveSpace: s.archiveSpace,
      loadSpaces: s.loadSpaces,
      isLoading: s.isLoading,
    })),
  )

  const currentUserRole = useOrganizationStore((state) => state.currentUserRole)
  const selectedOrganization = useOrganizationStore(
    (state) => state.selectedOrganization,
  )
  const user = useAuthStore((state) => state.user)
  const isOwner = !!(
    user &&
    selectedOrganization &&
    user.id === selectedOrganization.owner_id
  )
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const canManage = canManageSpaceLifecycle(
    space,
    agent,
    user?.id ?? null,
    effectiveRole,
  )

  const deleteGuard = useSpaceDeleteGuard(space)
  const lifecycleDisabled =
    deleteGuard.isResolving || deleteGuard.isRemoteViewer

  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false)
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteInputValue, setDeleteInputValue] = useState('')
  const [dangerError, setDangerError] = useState('')

  if (!canManage) return null

  const handleTrash = async () => {
    setDangerError('')
    const deleted = await deleteSpace(space.id)
    if (!deleted) {
      setDangerError(
        useSpaceStore.getState().error ??
          t('errors.trashFailed', { defaultValue: '移入回收站失败' }),
      )
      return
    }
    toast({
      title: t('trash.trashSuccess', {
        defaultValue: `已删除：${space.name}`,
      }),
    })
  }

  const handleArchive = async () => {
    setDangerError('')
    try {
      await archiveSpace(space.id)
    } catch (err) {
      setDangerError(
        err instanceof Error
          ? err.message
          : t('errors.archiveFailed', { defaultValue: '归档失败' }),
      )
    }
  }

  const handleDelete = async () => {
    setDangerError('')
    if (deleteInputValue.trim() !== space.name.trim()) {
      const msg = t('validation.nameMismatch')
      setDangerError(msg)
      throw new Error(msg)
    }
    const ok = await confirmDirtyBeforeSpaceDelete({
      spaceId: space.id,
      spaceName: space.name,
    })
    if (!ok) {
      const msg = t('errors.deleteCancelled', { defaultValue: '删除已取消' })
      setDangerError(msg)
      throw new Error(msg)
    }
    const deleted = await deleteSpace(space.id)
    if (!deleted) {
      const msg = useSpaceStore.getState().error ?? t('errors.deleteFailed')
      setDangerError(msg)
      throw new Error(msg)
    }
    if (space.organization_id) {
      void loadSpaces(space.organization_id).catch(() => {})
    }
  }

  return (
    <>
      <section
        className="mt-16 border-t border-border/40 pt-8"
        data-testid="workspace-lifecycle-danger"
        aria-label={t('danger.title', { defaultValue: '危险操作' })}
      >
        <h4 className={cn(SETTINGS_SECTION_TITLE, 'mb-3 flex items-center gap-1.5')}>
          <AlertTriangle className="h-3 w-3" />
          {t('danger.title', { defaultValue: '危险操作' })}
        </h4>

        {SPACE_TRASH_UI_ENABLED && (
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground">
                {t('danger.trashTitle', { defaultValue: '移入回收站' })}
              </div>
              <div className={SETTINGS_HINT}>{t('danger.trashDesc')}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTrashConfirmOpen(true)}
              disabled={
                isLoading ||
                lifecycleDisabled ||
                deleteGuard.blockReason === 'last-space'
              }
              className={cn('shrink-0 gap-1', SETTINGS_CONTROL_SM)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('actions.trash', { defaultValue: '移入回收站' })}
            </Button>
          </div>
        )}

        {SPACE_ARCHIVE_UI_ENABLED && (
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
              <div className="text-body font-medium text-foreground">
                {t('danger.archiveTitle')}
              </div>
              <div className={SETTINGS_HINT}>{t('danger.archiveDesc')}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setArchiveConfirmOpen(true)}
              disabled={isLoading || lifecycleDisabled}
              className={cn('shrink-0 gap-1', SETTINGS_CONTROL_SM)}
            >
              <Archive className="h-3.5 w-3.5" />
              {t('actions.archive')}
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between gap-4 py-2">
          <div className="min-w-0">
            <div className="text-body font-medium text-foreground">
              {t('danger.deleteTitle')}
            </div>
            <div className={SETTINGS_HINT}>{t('danger.deleteDesc')}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setDangerError('')
              setDeleteInputValue('')
              setDeleteDialogOpen(true)
            }}
            disabled={isLoading || !deleteGuard.canDelete}
            className={cn(
              'shrink-0 gap-1 text-destructive/70 hover:text-destructive hover:bg-destructive/5',
              SETTINGS_CONTROL_SM,
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('actions.delete')}
          </Button>
        </div>

        {deleteGuard.blockReason === 'remote' && (
          <p className={cn(SETTINGS_HINT, 'pt-1')}>
            {deleteGuard.controlDeviceName
              ? t('danger.remoteLifecycleHintWithDevice', {
                  device: deleteGuard.controlDeviceName,
                  defaultValue: `正在远程查看。删除等操作请回到执行设备「${deleteGuard.controlDeviceName}」本机进行。`,
                })
              : t('danger.remoteLifecycleHint', {
                  defaultValue:
                    '正在远程查看。删除等操作请回到执行设备本机进行。',
                })}
          </p>
        )}
        {deleteGuard.blockReason === 'last-space' && (
          <p className={cn(SETTINGS_HINT, 'pt-1')}>
            {t('danger.lastSpaceHint', {
              defaultValue:
                '这是当前 Team 在这台设备上的最后一个 Space，需至少保留一个，不能删除或移入回收站。',
            })}
          </p>
        )}
        {deleteGuard.blockReason === 'resolving' && (
          <p className={cn(SETTINGS_HINT, 'pt-1')}>
            {t('danger.deviceResolvingHint', {
              defaultValue: '正在识别本机设备，请稍候再试删除或移入回收站。',
            })}
          </p>
        )}
        {dangerError && !deleteDialogOpen ? (
          <p className="pt-2 text-caption text-destructive">{dangerError}</p>
        ) : null}
      </section>

      <SettingsNameConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open)
          if (!open) {
            setDeleteInputValue('')
            setDangerError('')
          }
        }}
        title={t('confirm.title')}
        subtitle={t('confirm.subtitle')}
        items={[
          t('confirm.items.spaceOnly', {
            name: space.name,
            defaultValue: `只删除工作空间记录和必要关系：${space.name}`,
          }),
          t('confirm.items.keepAgent', {
            defaultValue: 'Agent 身份不会被停用或删除',
          }),
          t('confirm.items.keepResources', {
            defaultValue: '组织文档、表格和云端文件不会被删除',
          }),
          space.working_dir
            ? t('confirm.items.keepWorkingDirPath', {
                path: space.working_dir,
                defaultValue: `本机工作目录会保留在原位置：${space.working_dir}`,
              })
            : t('confirm.items.keepWorkingDir', {
                defaultValue: '本机工作目录不会被删除',
              }),
        ]}
        warning={t('confirm.warning')}
        inputLabel={t('confirm.inputLabel')}
        inputPlaceholder={space.name}
        inputValue={deleteInputValue}
        onInputChange={setDeleteInputValue}
        expectedValue={space.name}
        error={dangerError}
        isLoading={isLoading}
        confirmText={t('actions.confirmDelete')}
        cancelText={t('actions.cancel')}
        onConfirm={handleDelete}
      />

      {SPACE_TRASH_UI_ENABLED && (
        <ConfirmDialog
          open={trashConfirmOpen}
          onOpenChange={setTrashConfirmOpen}
          title={t('danger.trashConfirmTitle', {
            defaultValue: '确认移入回收站？',
          })}
          description={t('danger.trashConfirmDesc', {
            name: space.name,
            defaultValue: `确定要将「${space.name}」移入回收站吗？30 天内可从回收站恢复。`,
          })}
          variant="destructive"
          onConfirm={handleTrash}
        />
      )}

      {SPACE_ARCHIVE_UI_ENABLED && (
        <ConfirmDialog
          open={archiveConfirmOpen}
          onOpenChange={setArchiveConfirmOpen}
          title={t('danger.archiveConfirmTitle', {
            defaultValue: '确认归档？',
          })}
          description={t('danger.archiveConfirmDesc', {
            name: space.name,
            defaultValue: `确定要归档「${space.name}」吗？归档后不会显示在列表中，但可以恢复。`,
          })}
          variant="destructive"
          onConfirm={handleArchive}
        />
      )}
    </>
  )
}

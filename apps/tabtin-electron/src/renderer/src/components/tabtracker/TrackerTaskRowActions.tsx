import React, { useCallback, useState } from 'react'
import {
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Zap,
} from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { TrackerTask } from '@/services/trackerApi'
import * as trackerApi from '@/services/trackerApi'
import { invalidateTrackerAfterTrigger } from '@/services/invalidateTrackerAfterTrigger'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { createLogger } from '@/utils/logger'
import { describeTriggerFrequency } from './triggerFrequency'

const log = createLogger('TrackerTaskRowActions')

type RowAction = 'activate' | 'resume' | 'pause' | 'trigger'

export interface TrackerTaskRowActionsProps {
  task: TrackerTask
  className?: string
}

export const TrackerTaskRowActions: React.FC<TrackerTaskRowActionsProps> = ({
  task,
  className,
}) => {
  const { t } = useTranslation('tabtracker')
  const setDialogState = useTrackerStore(s => s.setDialogState)
  const patchTaskFromWS = useTrackerStore(s => s.patchTaskFromWS)
  const deleteTask = useTrackerStore(s => s.deleteTask)

  const [pendingAction, setPendingAction] = useState<RowAction | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const isActive = task.status === 'active'
  const canTriggerManually = task.status === 'active' || task.status === 'paused'

  const runAction = useCallback(async (action: RowAction) => {
    if (action === 'trigger' && task.has_active_run) return
    setPendingAction(action)
    log.info(`automation action started taskId=${task.id} action=${action} status=${task.status}`)
    try {
      if (action === 'activate') {
        const updated = await trackerApi.activateTask(task.id)
        const freq = describeTriggerFrequency(updated.trigger_type, updated.trigger_config, t)
        toast.success(freq.isHighFrequency
          ? t('detail.highFrequencyToast', {
              summary: freq.summary,
              defaultValue: '已启用 · {{summary}}',
            })
          : t('toast.activated'))
      } else if (action === 'resume') {
        await trackerApi.resumeTask(task.id)
        toast.success(t('detail.actions.resumed'))
      } else if (action === 'pause') {
        await trackerApi.pauseTask(task.id)
        toast.success(t('detail.actions.paused'))
      } else if (action === 'trigger') {
        await trackerApi.triggerTask(task.id)
        toast.success(t('detail.actions.triggered'))
        await invalidateTrackerAfterTrigger(task.id)
        log.info(`automation action completed taskId=${task.id} action=${action}`)
        return
      }
      await patchTaskFromWS(task.id)
      log.info(`automation action completed taskId=${task.id} action=${action}`)
    } catch (error) {
      log.error(`automation action failed taskId=${task.id} action=${action}`, error)
      toast.error(t('toast.error'))
    } finally {
      setPendingAction(null)
    }
  }, [patchTaskFromWS, t, task])

  const handleToggle = useCallback((checked: boolean) => {
    if (checked) {
      void runAction(task.status === 'draft' ? 'activate' : 'resume')
      return
    }
    void runAction('pause')
  }, [runAction, task.status])

  const handleEdit = useCallback(() => {
    setDialogState({ open: true, editTask: task })
  }, [setDialogState, task])

  const handleDelete = useCallback(async () => {
    const deleted = await deleteTask(task.id)
    if (!deleted) {
      throw new Error(`automation delete failed taskId=${task.id}`)
    }
    toast.success(t('detail.actions.deleted'))
  }, [deleteTask, t, task.id])

  const busy = pendingAction !== null

  return (
    <div
      className={cn('flex items-center justify-end gap-2', className)}
      onClick={event => event.stopPropagation()}
    >
      <Switch
        checked={isActive}
        disabled={busy}
        onCheckedChange={handleToggle}
        aria-label={isActive
          ? t('detail.actions.pause')
          : t('detail.actions.resume')}
        data-testid="tracker-row-status-toggle"
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label={t('panel.rowActions.menu')}
            disabled={busy}
          >
            {busy
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <MoreHorizontal className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40" onClick={event => event.stopPropagation()}>
          {canTriggerManually ? (
            <DropdownMenuItem
              className="gap-2 text-body"
              disabled={busy || Boolean(task.has_active_run)}
              title={task.has_active_run
                ? t('detail.actions.triggerDisabledActiveRun')
                : t('detail.actions.trigger')}
              onSelect={() => void runAction('trigger')}
            >
              <Zap className="h-[1em] w-[1em]" />
              {t('detail.actions.trigger')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem className="gap-2 text-body" disabled={busy} onSelect={handleEdit}>
            <Pencil className="h-[1em] w-[1em]" />
            {t('detail.actions.edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-body text-destructive focus:text-destructive"
            disabled={busy}
            onSelect={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-[1em] w-[1em]" />
            {t('detail.actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={t('detail.actions.confirmDeleteTitle')}
        description={t('detail.actions.confirmDeleteHint')}
        confirmText={t('detail.actions.confirmDelete')}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  )
}

TrackerTaskRowActions.displayName = 'TrackerTaskRowActions'

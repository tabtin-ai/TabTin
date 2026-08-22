import React, { useCallback, useEffect, useState } from 'react'
import { Trash2, RotateCcw, Bot } from 'lucide-react'
import { Button, ConfirmDialog, toast } from '@components/ui'
import { TrashMemberAwareButton } from './TrashMemberAwareButton'
import type { Organization } from '@tabtin/app-shell'
import {
  ProjectApiService,
  SpaceApiService,
  type TrashedSpace,
  type DeactivatedAgent,
} from '@tabtin/app-shell'
import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { cn } from '@utils/cn'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSection } from '../SettingsSection'
import { SETTINGS_HINT, SETTINGS_ROW_HOVER, SETTINGS_SECTION_TITLE, SETTINGS_TEXT_MICRO } from '../settingsUi'

interface OrganizationTrashedSpacesPanelProps {
  organization: Organization
  canManageOrganization: boolean
  embedded?: boolean
}

const TRASH_RETENTION_DAYS = 30

const getDaysLeft = (trashedAt: string | null): number => {
  if (!trashedAt) return TRASH_RETENTION_DAYS
  const trashed = new Date(trashedAt)
  if (Number.isNaN(trashed.getTime())) return TRASH_RETENTION_DAYS
  const daysPassed = Math.floor((Date.now() - trashed.getTime()) / (1000 * 60 * 60 * 24))
  return Math.max(0, TRASH_RETENTION_DAYS - daysPassed)
}

export const OrganizationTrashedSpacesPanel: React.FC<OrganizationTrashedSpacesPanelProps> = ({
  organization,
  canManageOrganization,
  embedded = false,
}) => {
  const { t } = useTranslation('organization')
  const [items, setItems] = useState<TrashedSpace[]>([])
  const [deactivatedAgents, setDeactivatedAgents] = useState<DeactivatedAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set())
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [deleteConfirmItem, setDeleteConfirmItem] = useState<TrashedSpace | null>(null)
  const [reactivatingIds, setReactivatingIds] = useState<Set<string>>(new Set())
  const loadSpaces = useSpaceStore(state => state.loadSpaces)
  const reactivateAgent = useSpaceStore(state => state.reactivateAgent)

  const loadTrashedSpaces = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [trashedData, deactivatedData] = await Promise.all([
        ProjectApiService.listTrashed(organization.id),
        SpaceApiService.listDeactivatedAgents(organization.id).catch(() => ({ items: [], total: 0 })),
      ])
      setItems(trashedData.items ?? [])
      setDeactivatedAgents(deactivatedData.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : t('trashedSpaces.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [organization.id, t])

  useEffect(() => {
    void loadTrashedSpaces()
  }, [loadTrashedSpaces])

  const handleRestore = async (space: TrashedSpace) => {
    setRestoringIds(prev => new Set(prev).add(space.id))
    try {
      await ProjectApiService.restoreFromTrash(space.id)
      setItems(prev => prev.filter(s => s.id !== space.id))
      toast({ title: t('trashedSpaces.restoreSuccess', { name: space.name }) })
      void loadSpaces(organization.id).catch(() => {})
    } catch (err) {
      toast({
        title: t('trashedSpaces.restoreFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev)
        next.delete(space.id)
        return next
      })
    }
  }

  const confirmPermanentDelete = async () => {
    if (!deleteConfirmItem) return
    const space = deleteConfirmItem
    setDeleteConfirmItem(null)
    setDeletingIds(prev => new Set(prev).add(space.id))
    try {
      await ProjectApiService.permanentDeleteFromTrash(space.id)
      setItems(prev => prev.filter(s => s.id !== space.id))
      toast({ title: t('trashedSpaces.deleteSuccess', { name: space.name }) })
    } catch (err) {
      toast({
        title: t('trashedSpaces.deleteFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(space.id)
        return next
      })
    }
  }

  const handleReactivateAgent = async (agent: DeactivatedAgent) => {
    setReactivatingIds(prev => new Set(prev).add(agent.id))
    try {
      await reactivateAgent(agent.id)
      setDeactivatedAgents(prev => prev.filter(a => a.id !== agent.id))
      toast({ title: t('deactivatedAgents.restoreSuccess', { name: agent.name }) })
      void loadSpaces(organization.id).catch(() => {})
    } catch (err) {
      toast({
        title: t('deactivatedAgents.restoreFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setReactivatingIds(prev => {
        const next = new Set(prev)
        next.delete(agent.id)
        return next
      })
    }
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return ''
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  const totalCount = items.length + deactivatedAgents.length
  const isEmpty = totalCount === 0

  const body = (
    <>
      {embedded && totalCount > 0 ? (
        <div className="mb-3 flex justify-end">
          <span className={SETTINGS_HINT}>
            {t('trashedSpaces.count', { count: totalCount })}
          </span>
        </div>
      ) : null}

      {loading ? (
        <p className={SETTINGS_HINT}>{t('trashedSpaces.loading')}</p>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-body text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={loadTrashedSpaces}>
            {t('trashedSpaces.retry', { defaultValue: 'Retry' })}
          </Button>
        </div>
      ) : isEmpty ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Trash2 className="h-8 w-8 text-muted-foreground/20 mb-3" />
          <p className={SETTINGS_SECTION_TITLE}>{t('trashedSpaces.empty')}</p>
          <p className={cn(SETTINGS_HINT, 'mt-1')}>{t('trashedSpaces.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.length > 0 && (
            <div className="space-y-1">
              {items.map(space => {
                const isRestoring = restoringIds.has(space.id)
                const isDeleting = deletingIds.has(space.id)
                const isActing = isRestoring || isDeleting
                const daysLeft = getDaysLeft(space.trashed_at)
                return (
                  <div
                    key={space.id}
                    className={cn('group flex items-center justify-between gap-3 rounded-interactive px-3 py-2', SETTINGS_ROW_HOVER)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn(SETTINGS_TEXT_MICRO, 'font-medium', 'h-6 w-6 rounded bg-foreground/[0.06] text-accent-text flex items-center justify-center shrink-0')}>{space.name?.charAt(0) || '?'}</span>
                      <div className="min-w-0">
                        <div className="text-body font-medium truncate">{space.name}</div>
                        {space.trashed_at && (
                          <div className={SETTINGS_HINT}>
                            {t('trashedSpaces.trashedAt', { date: formatDate(space.trashed_at) })}
                            {daysLeft > 0 && (
                              <>
                                {' · '}
                                <span className={cn(daysLeft <= 7 && 'text-warning')}>
                                  {t('trashedSpaces.daysLeft', { days: daysLeft })}
                                </span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <TrashMemberAwareButton
                        adminLocked={!canManageOrganization}
                        adminHint={t('trashedSpaces.adminRequired')}
                        disabled={isActing}
                        onClick={() => { void handleRestore(space) }}
                        className="shrink-0 h-7 text-body"
                      >
                        <RotateCcw className={cn('h-[1em] w-[1em] mr-1', isRestoring && 'animate-spin')} />
                        {isRestoring ? t('trashedSpaces.restoring') : t('trashedSpaces.restore')}
                      </TrashMemberAwareButton>
                      <TrashMemberAwareButton
                        adminLocked={!canManageOrganization}
                        adminHint={t('trashedSpaces.adminRequired')}
                        disabled={isActing}
                        onClick={() => setDeleteConfirmItem(space)}
                        className="shrink-0 h-7 text-body text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-[1em] w-[1em] mr-1" />
                        {t('trashedSpaces.permanentDelete')}
                      </TrashMemberAwareButton>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {deactivatedAgents.length > 0 && (
            <SettingsSection
              title={
                <span className="flex items-center gap-2">
                  <Bot className="h-[1em] w-[1em]" />
                  {t('deactivatedAgents.title', { defaultValue: '已停用的 Agent' })}
                </span>
              }
              subtitle={t('deactivatedAgents.subtitle', { defaultValue: '这些 Agent 已被删除但可以恢复，恢复后将重新出现在侧边栏中。' })}
            >
              <div className="space-y-1">
                {deactivatedAgents.map(agent => {
                  const isReactivating = reactivatingIds.has(agent.id)
                  return (
                    <div
                      key={agent.id}
                      className={cn('flex items-center justify-between gap-3 rounded-interactive px-3 py-2', SETTINGS_ROW_HOVER)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn(SETTINGS_TEXT_MICRO, 'font-medium', 'h-6 w-6 rounded bg-foreground/[0.06] text-muted-foreground flex items-center justify-center shrink-0')}>
                          <Bot className="h-3 w-3" />
                        </span>
                        <div className="min-w-0">
                          <div className="text-body font-medium truncate">{agent.name}</div>
                          {agent.deactivated_at && (
                            <div className={SETTINGS_HINT}>
                              {t('deactivatedAgents.deactivatedAt', { date: formatDate(agent.deactivated_at), defaultValue: `停用于 ${formatDate(agent.deactivated_at)}` })}
                            </div>
                          )}
                        </div>
                      </div>

                      {canManageOrganization && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isReactivating}
                          onClick={() => handleReactivateAgent(agent)}
                          className="shrink-0 h-7 text-body"
                        >
                          <RotateCcw className={cn('h-[1em] w-[1em] mr-1', isReactivating && 'animate-spin')} />
                          {isReactivating ? t('deactivatedAgents.restoring') : t('deactivatedAgents.restore')}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </SettingsSection>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirmItem}
        onOpenChange={(open) => { if (!open) setDeleteConfirmItem(null) }}
        title={t('trashedSpaces.deleteConfirmTitle')}
        description={t('trashedSpaces.deleteConfirm', { name: deleteConfirmItem?.name || '' })}
        variant="destructive"
        onConfirm={() => { void confirmPermanentDelete() }}
      />
    </>
  )

  if (embedded) {
    return body
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Trash2 className="h-4 w-4" />}
        title={t('trashedSpaces.title')}
        subtitle={t('trashedSpaces.subtitle')}
        meta={
          totalCount > 0 ? (
            <span className={SETTINGS_HINT}>
              {t('trashedSpaces.count', { count: totalCount })}
            </span>
          ) : undefined
        }
      />
      {body}
    </SettingsPanelLayout>
  )
}

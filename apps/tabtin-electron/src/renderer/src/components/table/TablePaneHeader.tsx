import React from 'react'
import {
  Button,
  toast,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'
import { Lock, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ViewSwitcher } from '@components/view/ViewSwitcher'
import { useViewStore } from '@stores/useViewStore'
import { tableStore, useTableStore } from '@stores/useTableStore'
import { useTableViewUiStore } from '@stores/useTableViewUiStore'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import {
  useCollabPeersForTable,
  useCollabIsOnlineForTable,
  useCollabStatusForTable,
  useCollabConnectionStatusForTable,
  useCollabReconnectForTable,
  useCollabViewUpdaterForTable,
} from '@stores/useTableCollabStore'
import { CollabStatusBadge, CollabStatus, type CollabConnectionStatus } from '@tabtin/collab-core'
import { OnlinePresencePopover } from '@components/collab/OnlinePresencePopover'
import { buildColumnMetaVisibilityUpdate } from '@tabtin/table-ui'
import { useTableReadonly } from '@components/table/TableReadonlyContext'
import type { Table } from '@tabtin/table-core'
import { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from '@/lib/duplicateNameError'
import { shouldShowTableCollabStatusBadge } from './tableCollabStatusBadgeVisibility'

interface TablePaneHeaderProps {
  table: Table
  className?: string
}

/** 顶栏截断文案的 hover 全文：用应用内 Tooltip，不用原生 title */
function HeaderTruncateTooltip({
  content,
  children,
  className,
}: {
  content: string
  children: React.ReactElement
  className?: string
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          className={cn('max-w-xs px-2 py-1 text-caption leading-relaxed', className)}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const fallbackUserName = (username?: string, email?: string, fallback = '') => {
  if (username && username.trim().length > 0) {
    return username
  }
  if (email && email.trim().length > 0) {
    return email
  }
  return fallback
}

export const TablePaneHeader: React.FC<TablePaneHeaderProps> = ({ table, className }) => {
  const { t } = useTranslation(['table', 'common', 'collab'])
  const { isTableReadonly } = useTableReadonly()
  const tableNamePlaceholder = t('table:toolbar.tableNamePlaceholder')
  const updateTable = useTableStore(state => state.updateTable)
  const fields = useTableStore(state => state.fields)
  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const draft = useViewStore(state => (currentViewId ? state.draftStates[currentViewId] : undefined))
  const updateView = useViewStore(state => state.updateView)
  const collabUpdateView = useCollabViewUpdaterForTable(table.id)
  const clearDraft = useViewStore(state => state.clearDraft)
  const currentView = React.useMemo(
    () => views.find(view => view.id === currentViewId) ?? null,
    [views, currentViewId]
  )

  const personalViewByScope = useTableViewUiStore(state => state.personalViewByScope)
  const personalViewDraftByScope = useTableViewUiStore(state => state.personalViewDraftByScope)
  const dismissedLockedTipByScope = useTableViewUiStore(state => state.dismissedLockedTipByScope)
  const setPersonalViewEnabled = useTableViewUiStore(state => state.setPersonalViewEnabled)
  const clearPersonalViewDraft = useTableViewUiStore(state => state.clearPersonalViewDraft)
  const dismissLockedTip = useTableViewUiStore(state => state.dismissLockedTip)
  const resetLockedTip = useTableViewUiStore(state => state.resetLockedTip)

  const user = useAuthStore(state => state.user)
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const collabStatus = useCollabStatusForTable(table.id)
  const collabConnectionStatus = useCollabConnectionStatusForTable(table.id)
  const collabReconnect = useCollabReconnectForTable(table.id)
  const isCollabOnline = useCollabIsOnlineForTable(table.id)
  const showCollabStatusBadge = shouldShowTableCollabStatusBadge(
    collabStatus,
    collabConnectionStatus,
  )

  const scopeKey = currentViewId ? `${table.id}:${currentViewId}` : null
  const isPersonalViewEnabled = scopeKey ? Boolean(personalViewByScope[scopeKey]) : false
  const personalViewDraft = scopeKey ? personalViewDraftByScope[scopeKey] : undefined
  const isLockedTipDismissed = scopeKey ? Boolean(dismissedLockedTipByScope[scopeKey]) : false
  const showLockedTip =
    Boolean(currentView?.is_locked) && !isPersonalViewEnabled && !isLockedTipDismissed

  const [personalCloseDialogOpen, setPersonalCloseDialogOpen] = React.useState(false)
  const [isClosingPersonalView, setIsClosingPersonalView] = React.useState(false)
  const [isEditingTableName, setIsEditingTableName] = React.useState(false)
  const [editingTableName, setEditingTableName] = React.useState(table.name)
  const [isSavingTableName, setIsSavingTableName] = React.useState(false)
  const tableNameInputRef = React.useRef<HTMLInputElement | null>(null)

  const userDisplayName = fallbackUserName(
    user?.nickname || user?.username,
    user?.email,
    t('common:user')
  )

  React.useEffect(() => {
    if (!isEditingTableName) {
      setEditingTableName(table.name)
    }
  }, [table.id, table.name, isEditingTableName])

  React.useEffect(() => {
    if (!isEditingTableName) {
      return
    }
    tableNameInputRef.current?.focus()
    tableNameInputRef.current?.select()
  }, [isEditingTableName])

  const closePersonalView = React.useCallback(
    async (syncToShared: boolean) => {
      if (!currentViewId) {
        return
      }

      const hasLocalDraft = Boolean(
        personalViewDraft &&
          (personalViewDraft.filters ||
            personalViewDraft.groups ||
            personalViewDraft.filter_logic ||
            personalViewDraft.sorts ||
            personalViewDraft.visible_fields ||
            personalViewDraft.field_order ||
            personalViewDraft.column_meta ||
            personalViewDraft.config)
      )
      const hasDirtyFilterDraft = Boolean(draft?.isDirty)

      if (syncToShared && currentView && !currentView.is_locked && (hasLocalDraft || hasDirtyFilterDraft)) {
        const baseConfig = (currentView.config as Record<string, unknown>) ?? {}
        const mergedConfig = {
          ...baseConfig,
          ...((personalViewDraft?.config as Record<string, unknown> | undefined) ?? {}),
          ...(hasDirtyFilterDraft
            ? { filter_logic: draft?.filter_logic }
            : personalViewDraft?.filter_logic
              ? { filter_logic: personalViewDraft.filter_logic }
              : {}),
        }

        const generalPayload: Record<string, unknown> = {}
        if (hasDirtyFilterDraft) {
          generalPayload.filters = draft?.filters ?? []
          generalPayload.groups = draft?.groups ?? []
          generalPayload.config = mergedConfig
        } else if (personalViewDraft?.filters || personalViewDraft?.groups || personalViewDraft?.filter_logic) {
          generalPayload.filters = personalViewDraft?.filters ?? currentView.filters ?? []
          generalPayload.groups = personalViewDraft?.groups ?? currentView.groups ?? []
          generalPayload.config = mergedConfig
        } else if (personalViewDraft?.config) {
          generalPayload.config = mergedConfig
        }
        if (personalViewDraft?.sorts) {
          generalPayload.sorts = personalViewDraft.sorts
        }

        const hasColumnMetaDraft = Boolean(personalViewDraft?.column_meta)
        if (!hasColumnMetaDraft && personalViewDraft?.visible_fields) {
          generalPayload.visible_fields = personalViewDraft.visible_fields
          if (fields.length > 0) {
            generalPayload.column_meta = buildColumnMetaVisibilityUpdate(
              currentView as any,
              fields as any,
              personalViewDraft.visible_fields
            )
          }
        }
        if (!hasColumnMetaDraft && personalViewDraft?.field_order) {
          generalPayload.field_order = personalViewDraft.field_order
        }

        setIsClosingPersonalView(true)
        try {
          // 两阶段提交：
          // 1) 普通视图配置（filters/groups/sorts/config）
          // 2) 列配置（column_meta）走独立 patch 语义
          const syncSteps: Array<Record<string, unknown>> = []
          if (Object.keys(generalPayload).length > 0) {
            syncSteps.push(generalPayload)
          }
          if (hasColumnMetaDraft) {
            syncSteps.push({
              column_meta: personalViewDraft?.column_meta,
            })
          }

          const runtimeUpdateView = collabUpdateView ?? (isCollabOnline ? null : updateView)
          if (!runtimeUpdateView) {
            toast({
              title: t('table:header.personalViewSyncFailedTitle'),
              description: t('table:header.personalViewSyncFailedDesc'),
              variant: 'destructive',
            })
            return
          }

          for (const stepPayload of syncSteps) {
            const result = await runtimeUpdateView(currentView.id, stepPayload as any, { silent: true })
            if (!result) {
              toast({
                title: t('table:header.personalViewSyncFailedTitle'),
                description: t('table:header.personalViewSyncFailedDesc'),
                variant: 'destructive',
              })
              return
            }
          }

          toast({
            title: t('table:header.personalViewSyncSuccessTitle'),
          })
        } catch {
          toast({
            title: t('table:header.personalViewSyncFailedTitle'),
            description: t('table:header.personalViewSyncFailedDesc'),
            variant: 'destructive',
          })
          return
        } finally {
          setIsClosingPersonalView(false)
        }
      }

      if (hasDirtyFilterDraft) {
        await clearDraft(currentViewId)
      }
      clearPersonalViewDraft(table.id, currentViewId)
      setPersonalViewEnabled(table.id, currentViewId, false)
      setPersonalCloseDialogOpen(false)
    },
    [
      clearDraft,
      clearPersonalViewDraft,
      currentView,
      currentViewId,
      draft,
      fields,
      personalViewDraft,
      setPersonalViewEnabled,
      table.id,
      t,
      collabUpdateView,
      isCollabOnline,
      updateView,
    ]
  )

  const handleDiscardPersonalAndClose = () => {
    void closePersonalView(false)
  }

  const handleSyncPersonalAndClose = () => {
    void closePersonalView(true)
  }

  const handleEnablePersonalView = () => {
    if (isTableReadonly) {
      return
    }
    if (!currentViewId) {
      return
    }
    setPersonalViewEnabled(table.id, currentViewId, true)
    resetLockedTip(table.id, currentViewId)
  }

  const handleDismissLockedTip = () => {
    if (!currentViewId) {
      return
    }
    dismissLockedTip(table.id, currentViewId)
  }

  const startTableNameEdit = React.useCallback(
    (event?: React.MouseEvent) => {
      if (isTableReadonly) {
        return
      }
      event?.stopPropagation()
      if (isSavingTableName) {
        return
      }
      setEditingTableName(table.name)
      setIsEditingTableName(true)
    },
    [isSavingTableName, isTableReadonly, table.name]
  )

  const cancelTableNameEdit = React.useCallback(() => {
    setEditingTableName(table.name)
    setIsEditingTableName(false)
  }, [table.name])

  const submitTableNameEdit = React.useCallback(async () => {
    if (isTableReadonly) {
      return
    }
    if (isSavingTableName) {
      return
    }

    const nextName = editingTableName.trim()
    if (!nextName) {
      cancelTableNameEdit()
      return
    }

    if (nextName === table.name) {
      setIsEditingTableName(false)
      return
    }

    setIsSavingTableName(true)
    const updated = await updateTable(table.id, { name: nextName })
    setIsSavingTableName(false)

    if (!updated) {
      const errorMessage = tableStore.getState().error
      const normalizedMessage = errorMessage?.trim()
      const isDuplicateNameError = isDuplicateNameErrorMessage(normalizedMessage)
        || !normalizedMessage
        || normalizedMessage === t('table:apiErrors.updateFailed')
        || normalizedMessage === '更新表格失败'
        || normalizedMessage === 'update table failed'
      toast({
        title: isDuplicateNameError ? DUPLICATE_NAME_ERROR_TITLE : t('table:apiErrors.updateFailed'),
        description: isDuplicateNameError ? undefined : normalizedMessage,
        variant: 'destructive',
      })
      cancelTableNameEdit()
      return
    }

    setIsEditingTableName(false)
  }, [
    cancelTableNameEdit,
    editingTableName,
    isSavingTableName,
    isTableReadonly,
    table.id,
    table.name,
    t,
    updateTable,
  ])

  const hasDescription = Boolean(table.description)

  return (
    <div className={cn('shrink-0 border-b border-border/60 bg-background', className)}>
      <div
        className={cn(
          'flex items-center gap-2 px-3 @container/table-pane-header',
          // 有描述时标题/描述分行，顶栏略增高；无描述保持单行 h-9
          hasDescription ? 'min-h-9 py-1' : 'h-9',
        )}
      >
        {/* 左侧尽量吃满剩余空间；标题+描述同一纵向单元格并垂直居中 */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/40 text-body">
            {table.icon || '📄'}
          </div>
          {/* 标题/描述同一单元格：纵向排列 + 单元格自身垂直居中 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center overflow-hidden self-center">
            {isEditingTableName ? (
              <div className="inline-grid min-w-0 max-w-full align-middle">
                <span
                  aria-hidden="true"
                  className="invisible col-start-1 row-start-1 whitespace-pre rounded-[calc(var(--radius)-2px)] border border-transparent px-1.5 py-0.5 text-body font-semibold"
                >
                  {(editingTableName || tableNamePlaceholder) + ' '}
                </span>
                <input
                  ref={tableNameInputRef}
                  value={editingTableName}
                  onChange={event => setEditingTableName(event.target.value)}
                  onMouseDown={event => event.stopPropagation()}
                  onBlur={() => {
                    void submitTableNameEdit()
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      void submitTableNameEdit()
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelTableNameEdit()
                    }
                  }}
                  disabled={isSavingTableName}
                  className="col-start-1 row-start-1 h-6 min-w-0 w-full max-w-full rounded-[calc(var(--radius)-2px)] border border-input/70 bg-background/90 px-1.5 py-0.5 text-body font-semibold ring-offset-background placeholder:text-muted-foreground focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={tableNamePlaceholder}
                />
              </div>
            ) : (
              <HeaderTruncateTooltip content={table.name}>
                <div
                  className="min-w-0 truncate select-none text-body font-semibold leading-5 text-foreground transition-colors hover:text-primary"
                  onMouseDown={event => event.stopPropagation()}
                  onClick={startTableNameEdit}
                  onDoubleClick={startTableNameEdit}
                >
                  {table.name}
                </div>
              </HeaderTruncateTooltip>
            )}
            {table.description ? (
              <HeaderTruncateTooltip content={table.description}>
                <div className="min-w-0 truncate text-caption leading-4 text-muted-foreground/80">
                  {table.description}
                </div>
              </HeaderTruncateTooltip>
            ) : null}
          </div>
          {/* 协作状态统一显示在表头，避免连接中状态挤占网格内容区。 */}
          {showCollabStatusBadge && collabStatus != null && (
            <CollabStatusBadge
              status={collabStatus}
              connectionStatus={(collabConnectionStatus as CollabConnectionStatus | null) ?? undefined}
              onReconnect={collabReconnect ?? undefined}
              className="ml-1 shrink-0 self-center"
              labels={{
                [CollabStatus.INITIAL]: t('common:collab.statusInitial'),
                [CollabStatus.CONNECTING]: t('common:collab.statusConnecting'),
                [CollabStatus.SYNCING]: t('common:collab.statusSyncing'),
                [CollabStatus.SYNCED]: t('common:collab.statusSynced'),
                [CollabStatus.DISCONNECTED]: t('common:collab.statusDisconnected'),
                [CollabStatus.FORCE_CLOSED]: t('common:collab.statusForceClosed'),
              }}
              stuckLabel={t('common:collab.statusStuckConnecting')}
              reconnectHint={t('common:collab.clickToReconnect')}
            />
          )}
        </div>

        <div className="min-w-0 shrink">
          <ViewSwitcher className="min-w-0 max-w-full" />
        </div>

        <div className="hidden shrink-0 items-center gap-3 @lg/table-pane-header:flex">
          <CollabPresenceIndicator
            tableId={table.id}
            isAuthenticated={isAuthenticated}
            user={user}
            userDisplayName={userDisplayName}
          />
        </div>
      </div>

      {showLockedTip ? (
        <div className="flex items-center justify-between gap-2 border-t border-warning/20 bg-warning/10 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5 text-body text-warning">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('table:header.lockedTip')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-6 border-warning/40 bg-background px-2 text-caption text-warning hover:bg-warning/20"
              onClick={handleEnablePersonalView}
            >
              {t('table:header.enablePersonalView')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 px-0 text-warning hover:bg-warning/20"
              onClick={handleDismissLockedTip}
              title={t('table:header.dismissLockedTip')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={personalCloseDialogOpen} onOpenChange={setPersonalCloseDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('table:header.personalViewCloseDialogTitle')}</DialogTitle>
            <DialogDescription>{t('table:header.personalViewCloseDialogDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={handleSyncPersonalAndClose}
              disabled={isClosingPersonalView}
            >
              {t('table:header.personalViewCloseSync')}
            </Button>
            <Button
              type="button"
              onClick={handleDiscardPersonalAndClose}
              disabled={isClosingPersonalView}
            >
              {t('table:header.personalViewCloseDiscard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── 协作者 Presence 指示器 ──

interface CollabPresenceIndicatorProps {
  tableId: string
  isAuthenticated: boolean
  user: ReturnType<typeof useAuthStore.getState>['user']
  userDisplayName: string
}

const CollabPresenceIndicator: React.FC<CollabPresenceIndicatorProps> = ({
  tableId,
  isAuthenticated,
  user,
  userDisplayName,
}) => {
  const peers = useCollabPeersForTable(tableId)
  const isOnline = useCollabIsOnlineForTable(tableId)

  if (!isAuthenticated || !user?.id) return null

  return (
    <OnlinePresencePopover
      isOnline={isOnline}
      peers={peers.map(peer => ({
        id: peer.user.id,
        name: peer.user.name,
        type: peer.user.type === 'agent' ? 'agent' as const : 'user' as const,
        avatar: peer.user.avatar,
        color: peer.user.color,
      }))}
      self={{
        id: user.id,
        name: userDisplayName,
        avatar: user.avatar,
        type: 'user',
      }}
    />
  )
}

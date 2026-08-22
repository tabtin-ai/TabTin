import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@components/ui'
import { SpaceApiService, type SpaceContextItem } from '@/services/spaceApi'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import { deleteResourcesToTrash, isBatchDeletableResource } from './resourceBatchDelete'

interface UseResourceBatchDeleteOptions {
  items: SpaceContextItem[]
  spaceId: string
  resetKey?: string
  organizationId?: string | null
  enabled?: boolean
}

export interface ResourceBatchDeleteController {
  selectionMode: boolean
  selectedIds: ReadonlySet<string>
  selectedCount: number
  busy: boolean
  confirmOpen: boolean
  hasSelectableItems: boolean
  isSelected: (item: SpaceContextItem) => boolean
  isSelectable: (item: SpaceContextItem) => boolean
  isBusy: (item: SpaceContextItem) => boolean
  isBusyId: (id: string) => boolean
  toggleSelectionMode: () => void
  toggleSelection: (item: SpaceContextItem) => void
  requestDelete: () => void
  setConfirmOpen: (open: boolean) => void
  confirmDelete: () => Promise<void>
}

export function useResourceBatchDelete({
  items,
  spaceId,
  resetKey,
  organizationId,
  enabled = true,
}: UseResourceBatchDeleteOptions): ResourceBatchDeleteController {
  const { t } = useTranslation('context')
  const handleResourceWsEvent = useUnifiedResources(state => state.handleWsEvent)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const operationGenerationRef = useRef(0)

  const isSelectable = useCallback(
    (item: SpaceContextItem) => enabled && isBatchDeletableResource(item),
    [enabled],
  )
  const selectedItems = useMemo(
    () => items.filter(item => selectedIds.has(item.id) && isSelectable(item)),
    [isSelectable, items, selectedIds],
  )

  useEffect(() => {
    operationGenerationRef.current += 1
    setSelectionMode(false)
    setSelectedIds(new Set())
    setConfirmOpen(false)
  }, [resetKey, spaceId])

  useEffect(() => {
    if (!enabled && selectionMode) {
      setSelectionMode(false)
      setSelectedIds(new Set())
      setConfirmOpen(false)
    }
  }, [enabled, selectionMode])

  const toggleSelectionMode = useCallback(() => {
    if (!enabled || busyIds.size > 0) return
    setSelectionMode(current => !current)
    setSelectedIds(new Set())
    setConfirmOpen(false)
  }, [busyIds.size, enabled])

  const toggleSelection = useCallback((item: SpaceContextItem) => {
    if (!isSelectable(item) || busyIds.has(item.id)) return
    setSelectedIds(current => {
      const next = new Set(current)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }, [busyIds, isSelectable])

  const requestDelete = useCallback(() => {
    if (selectedItems.length > 0 && busyIds.size === 0) setConfirmOpen(true)
  }, [busyIds.size, selectedItems.length])

  const confirmDelete = useCallback(async () => {
    const deletingItems = selectedItems
    if (deletingItems.length === 0 || busyIds.size > 0) return

    setConfirmOpen(false)
    setBusyIds(new Set(deletingItems.map(item => item.id)))
    const operationGeneration = operationGenerationRef.current
    const { failedIds } = await deleteResourcesToTrash(
      deletingItems,
      organizationId,
      {
        trashResource: item => SpaceApiService.trashContextResource(item),
        archiveContextItem: itemId => SpaceApiService.archiveContextItem(itemId),
        onDeleted: (item, movedToTrash) => {
          handleResourceWsEvent({
            type: movedToTrash ? 'resource_trashed' : 'resource_archived',
            resource_type: item.item_type,
            resource_id: item.resource_id,
            space_id: item.space_id ?? spaceId,
            organization_id: item.organization_id ?? organizationId ?? null,
          })
        },
      },
    )

    setBusyIds(new Set())
    if (operationGeneration !== operationGenerationRef.current) return
    setSelectedIds(new Set())
    setSelectionMode(false)

    if (failedIds.size > 0) {
      toast.error(t('home.assetBrowser.batchDeleteFailed', {
        count: failedIds.size,
        defaultValue: '{{count}} 项删除失败',
      }))
      return
    }
    toast({
      title: t('home.assetBrowser.batchDeleteSuccess', {
        count: deletingItems.length,
        defaultValue: '已删除 {{count}} 项',
      }),
    })
  }, [busyIds.size, handleResourceWsEvent, organizationId, selectedItems, spaceId, t])

  return {
    selectionMode,
    selectedIds,
    selectedCount: selectedItems.length,
    busy: busyIds.size > 0,
    confirmOpen,
    hasSelectableItems: items.some(isSelectable),
    isSelected: item => selectedIds.has(item.id),
    isSelectable,
    isBusy: item => busyIds.has(item.id),
    isBusyId: id => busyIds.has(id),
    toggleSelectionMode,
    toggleSelection,
    requestDelete,
    setConfirmOpen,
    confirmDelete,
  }
}

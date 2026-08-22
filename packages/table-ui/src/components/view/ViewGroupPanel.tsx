import React, { useMemo } from 'react'
import type { Field, ViewGroup, ViewMeta } from '../../types'
import {
  ViewGroupPopover,
  type GroupPanelTexts,
} from './ViewGroupPopover'

interface ViewGroupPanelStoreSlice {
  initializeDraft: (viewId: string) => void
  setDraftGroups: (viewId: string, groups: ViewGroup[]) => void
  applyDraft: (viewId: string) => Promise<void>
}

interface ViewGroupDraftSlice {
  groups?: ViewGroup[]
}

export interface ViewGroupPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewId: string | null
  fields: Field[]
  views: ViewMeta[]
  footer?: React.ReactNode
  triggerTooltip?: React.ReactNode
  children?: React.ReactNode
  store: ViewGroupPanelStoreSlice
  draft: ViewGroupDraftSlice | undefined
  translate: (key: string, options?: Record<string, unknown>) => string
  disabled?: boolean
}

const buildTexts = (t: ViewGroupPanelProps['translate']): GroupPanelTexts => ({
  descriptionKanban: String(t('view:groupPanel.descriptionKanban')),
  descriptionDefault: String(t('view:groupPanel.descriptionDefault')),
  emptyGroupPlacement: String(t('view:groupPanel.emptyGroupPlacement')),
  title: String(t('view:groupPanel.title')),
  empty: String(t('view:groupPanel.empty')),
  add: String(t('view:groupPanel.add')),
  remove: String(t('common:delete')),
  fieldPlaceholder: String(t('view:groupPanel.fieldPlaceholder')),
  orderAsc: String(t('view:groupPanel.orderAsc')),
  orderDesc: String(t('view:groupPanel.orderDesc')),
  moveUp: String(t('common:up')),
  moveDown: String(t('common:down')),
  searchPlaceholder: String(t('view:groupPanel.searchPlaceholder')),
  noResults: String(t('view:groupPanel.noResults')),
})

export const ViewGroupPanel: React.FC<ViewGroupPanelProps> = ({
  open,
  onOpenChange,
  viewId,
  fields,
  views,
  footer,
  triggerTooltip,
  children,
  store,
  draft,
  translate,
  disabled = false,
}) => {
  const texts = useMemo(() => buildTexts(translate), [translate])

  return (
    <ViewGroupPopover
      open={open}
      onOpenChange={onOpenChange}
      viewId={viewId}
      fields={fields}
      views={views}
      draft={draft}
      store={store}
      texts={texts}
      disabled={disabled}
      footer={footer}
      triggerTooltip={triggerTooltip}
    >
      {children}
    </ViewGroupPopover>
  )
}

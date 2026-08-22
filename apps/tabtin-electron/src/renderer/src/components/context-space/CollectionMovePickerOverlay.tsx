import React from 'react'
import { FolderOutput } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SpaceCollection } from '@/services/spaceApi'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'

export interface CollectionMovePickerOverlayProps {
  open: boolean
  anchorPosition: { x: number; y: number }
  collections: SpaceCollection[]
  onClose: () => void
  onSelect: (collectionId: string) => void
  onSelectRoot?: () => void
  canSelectCollection?: (collection: SpaceCollection) => boolean
  highlightCollectionId?: string | null
  titleKey?: string
  rootLabelKey?: string
}

function hasSelectableTargets(
  collections: SpaceCollection[],
  canSelectCollection?: (collection: SpaceCollection) => boolean,
): boolean {
  for (const collection of collections) {
    const canSelect = canSelectCollection?.(collection) ?? true
    if (canSelect) return true
    if (hasSelectableTargets(collection.children ?? [], canSelectCollection)) return true
  }
  return false
}

function renderCollectionBranch(
  collection: SpaceCollection,
  depth: number,
  props: Pick<
    CollectionMovePickerOverlayProps,
    'onSelect' | 'canSelectCollection' | 'highlightCollectionId'
  >,
): React.ReactNode {
  const canSelect = props.canSelectCollection?.(collection) ?? true
  if (!canSelect) {
    return (collection.children ?? []).map(child =>
      renderCollectionBranch(child, depth + 1, props),
    )
  }

  return (
    <React.Fragment key={collection.id}>
      <button
        type="button"
        className={cn(
          'flex items-center gap-2 py-1.5 rounded-md text-body w-full hover:bg-muted/60 transition-colors text-left',
          props.highlightCollectionId === collection.id && 'bg-muted/30',
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => props.onSelect(collection.id)}
      >
        <span>{collection.icon || '📁'}</span>
        <span className="truncate">{collection.name}</span>
      </button>
      {(collection.children ?? []).map(child => renderCollectionBranch(child, depth + 1, props))}
    </React.Fragment>
  )
}

export const CollectionMovePickerOverlay: React.FC<CollectionMovePickerOverlayProps> = ({
  open,
  anchorPosition,
  collections,
  onClose,
  onSelect,
  onSelectRoot,
  canSelectCollection,
  highlightCollectionId = null,
  titleKey = 'sidebar.moveToCollectionTitle',
  rootLabelKey = 'sidebar.moveToCollectionRoot',
}) => {
  const { t } = useTranslation('context')

  if (!open) return null

  const hasRootTarget = Boolean(onSelectRoot)
  const hasFolderTargets = hasSelectableTargets(collections, canSelectCollection)
  const isEmpty = !hasRootTarget && !hasFolderTargets

  return (
    <div className="fixed inset-0 z-modal" onClick={onClose}>
      <div
        className={cn(
          OVERLAY_SURFACE_CLASS,
          'absolute rounded-interactive p-1 w-56 max-h-72 overflow-y-auto',
        )}
        style={{ left: anchorPosition.x, top: anchorPosition.y }}
        onClick={event => event.stopPropagation()}
      >
        <div className="px-2 py-1.5 text-caption font-medium text-muted-foreground/60">
          {t(titleKey, { defaultValue: 'Move to...' })}
        </div>
        {isEmpty ? (
          <div className="px-2 py-3 text-center text-caption text-muted-foreground/60">
            {t('sidebar.moveToCollectionEmpty', { defaultValue: 'No valid destinations' })}
          </div>
        ) : (
          <>
            {onSelectRoot && (
              <button
                type="button"
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-body w-full hover:bg-muted/60 transition-colors text-left text-muted-foreground"
                onClick={onSelectRoot}
              >
                <FolderOutput className="h-3.5 w-3.5" />
                <span>{t(rootLabelKey, { defaultValue: 'Move to collection root' })}</span>
              </button>
            )}
            {collections.map(coll =>
              renderCollectionBranch(coll, 0, {
                onSelect,
                canSelectCollection,
                highlightCollectionId,
              }),
            )}
          </>
        )}
      </div>
    </div>
  )
}

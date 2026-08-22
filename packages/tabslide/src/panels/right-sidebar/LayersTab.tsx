import React, { useCallback, useMemo, useRef, useState } from 'react'
import type { PPTElement, Slide } from '../../types/slides'
import { resolveMovableLayerIds } from '../../store/slide'
import { computeLayerDropToIndex, type LayerDropPlacement } from '../../utils/layer-reorder'
import { buildLayerItems, layerItemSize, type LayerItem } from '../../utils/layer-items'
import { shouldAppendSelection } from '../../utils/modifier'
import { useT } from '../../i18n'
import { LayerBtn } from './shared/components'
import { ScrollArea } from '../../components/ui/ScrollArea'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Eye, EyeOff, Lock, Unlock } from 'lucide-react'

const lic = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

const TypeIcons: Record<string, React.ReactNode> = {
  text:  <svg {...lic}><path d="M4 7V4h16v3"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/></svg>,
  image: <svg {...lic}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  shape: <svg {...lic}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>,
  line:  <svg {...lic}><line x1="5" y1="19" x2="19" y2="5"/></svg>,
  chart: <svg {...lic}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  table: <svg {...lic}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>,
  latex: <svg {...lic}><path d="M4 20l4-16"/><path d="M10 20l4-16"/><line x1="2" y1="14" x2="16" y2="14"/><line x1="6" y1="8" x2="20" y2="8"/></svg>,
  video: <svg {...lic}><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  audio: <svg {...lic}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
}

const EyeOpenIcon = () => (
  <svg {...lic} width={13} height={13}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
)
const EyeClosedIcon = () => (
  <svg {...lic} width={13} height={13}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
)
const LockIcon = () => (
  <svg {...lic} width={13} height={13}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
)
const UnlockIcon = () => (
  <svg {...lic} width={13} height={13}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
)
const GroupIcon = () => (
  <svg {...lic} width={13} height={13}><rect x="4" y="4" width="8" height="8" rx="1.5"/><rect x="12" y="12" width="8" height="8" rx="1.5"/></svg>
)
const ChevronIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <svg {...lic} width={11} height={11} className="transition-transform duration-150" style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
)

interface LayerPreviewPlacement {
  targetVisualIndex: number
  insertionVisualIndex: number
}

const DROP_PLACEHOLDER_MIN_HEIGHT = 28

const resolveInsertionItemIndex = (items: LayerItem[], insertionAt: number): number => {
  const maxInsertAt = items.reduce((sum, item) => sum + layerItemSize(item), 0)
  const clampedInsertionAt = Math.max(0, Math.min(Math.trunc(insertionAt), maxInsertAt))

  let offset = 0
  for (let idx = 0; idx < items.length; idx += 1) {
    if (clampedInsertionAt <= offset) return idx
    offset += layerItemSize(items[idx]!)
    if (clampedInsertionAt < offset) return idx + 1
  }
  return items.length
}

const resolveLayerPreviewPlacement = (
  itemsInArrayOrder: LayerItem[],
  dragKey: string,
  toArrayIdx: number,
): LayerPreviewPlacement | null => {
  const dragArrayIndex = itemsInArrayOrder.findIndex((item) => item.key === dragKey)
  if (dragArrayIndex < 0) return null
  const dragItem = itemsInArrayOrder[dragArrayIndex]
  if (!dragItem) return null

  const remainingItems = itemsInArrayOrder.filter((_, idx) => idx !== dragArrayIndex)
  const insertionArrayIndex = resolveInsertionItemIndex(remainingItems, toArrayIdx)
  const previewArrayItems = [
    ...remainingItems.slice(0, insertionArrayIndex),
    dragItem,
    ...remainingItems.slice(insertionArrayIndex),
  ]
  const previewVisualItems = [...previewArrayItems].reverse()
  const targetVisualIndex = previewVisualItems.findIndex((item) => item.key === dragKey)
  if (targetVisualIndex < 0) return null

  const currentVisualIndex = itemsInArrayOrder.length - 1 - dragArrayIndex
  if (currentVisualIndex === targetVisualIndex) return null

  return {
    targetVisualIndex,
    insertionVisualIndex:
      currentVisualIndex < targetVisualIndex
        ? targetVisualIndex + 1
        : targetVisualIndex,
  }
}

export interface LayerListProps {
  page: Slide
  selectedIds: string[]
  onSelect: (id: string, append?: boolean) => void
  onSelectDirect?: (ids: string[]) => void
  onToggleVisibility: (id: string) => void
  onSetVisibility: (ids: string[], visible: boolean) => void
  onToggleLock: (id: string) => void
  onSetLock: (ids: string[], locked: boolean) => void
  onSetGroupName: (ids: string[], groupName: string) => void
  onBringForward: (ids: string[]) => void
  onSendBackward: (ids: string[]) => void
  onBringToFront: (ids: string[]) => void
  onSendToBack: (ids: string[]) => void
  onReorder: (from: number, to: number) => void
}

export const LayerList: React.FC<LayerListProps> = ({
  page, selectedIds, onSelect, onSelectDirect,
  onToggleVisibility, onSetVisibility, onToggleLock, onSetLock, onSetGroupName,
  onBringForward, onSendBackward, onBringToFront, onSendToBack,
  onReorder,
}) => {
  const translate = useT()
  const selectedSet = new Set(selectedIds)
  const hasSelection = selectedIds.length > 0
  const layerItems = buildLayerItems(page.elements)
  const topLayerItems = [...layerItems].reverse()
  const allElementIds = page.elements.map((el) => el.id)
  const hasLayerItems = allElementIds.length > 0
  const allLayersHidden = hasLayerItems && page.elements.every((el) => el.visible === false)
  const allLayersLocked = hasLayerItems && page.elements.every((el) => el.locked)
  const movableIdSet = new Set(resolveMovableLayerIds(page.elements, allElementIds))
  const hasMovableSelection = resolveMovableLayerIds(page.elements, selectedIds).length > 0

  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragRange, setDragRange] = useState<{ start: number; end: number } | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; placement: 'before' | 'after' } | null>(null)
  const [dragItemHeight, setDragItemHeight] = useState(0)
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set())
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const setItemRef = useCallback((key: string, node: HTMLDivElement | null) => {
    const refs = itemRefs.current
    if (!node) {
      refs.delete(key)
      return
    }
    refs.set(key, node)
  }, [])

  const dragVisualIndex = useMemo(() => {
    if (!dragKey) return null
    const idx = topLayerItems.findIndex((item) => item.key === dragKey)
    return idx >= 0 ? idx : null
  }, [dragKey, topLayerItems])

  const previewPlacement = useMemo(() => {
    if (!dragKey || !dragRange || !dropTarget) return null
    const target = layerItems.find((item) => item.key === dropTarget.key)
    if (!target) return null
    const dragItem = layerItems.find((item) => item.key === dragKey)

    const toArrayIdx = computeLayerDropToIndex({
      drag: dragRange,
      target: { start: target.start, end: target.end },
      placement: dropTarget.placement,
      totalCount: page.elements.length,
      dragMemberCount: dragItem?.ids.length,
      dragMemberIndices: dragItem?.memberIndices ? new Set(dragItem.memberIndices) : undefined,
    })
    if (toArrayIdx === null) return null
    return resolveLayerPreviewPlacement(layerItems, dragKey, toArrayIdx)
  }, [dragKey, dragRange, dropTarget, layerItems, page.elements.length])

  const previewTargetVisualIndex = previewPlacement?.targetVisualIndex ?? null
  const previewInsertionVisualIndex = previewPlacement?.insertionVisualIndex ?? null
  const placeholderHeight = Math.max(DROP_PLACEHOLDER_MIN_HEIGHT, dragItemHeight || 0)
  const hasAvoidancePreview = (
    dragVisualIndex !== null
    && previewTargetVisualIndex !== null
    && previewTargetVisualIndex !== dragVisualIndex
    && dragItemHeight > 0
  )

  const getItemShiftY = useCallback((visualIndex: number, key: string) => {
    if (
      !hasAvoidancePreview
      || dragKey === null
      || dragVisualIndex === null
      || previewTargetVisualIndex === null
      || key === dragKey
    ) {
      return 0
    }
    const shift = placeholderHeight
    if (dragVisualIndex < previewTargetVisualIndex) {
      return visualIndex > dragVisualIndex && visualIndex <= previewTargetVisualIndex ? -shift : 0
    }
    if (dragVisualIndex > previewTargetVisualIndex) {
      return visualIndex >= previewTargetVisualIndex && visualIndex < dragVisualIndex ? shift : 0
    }
    return 0
  }, [dragKey, dragVisualIndex, hasAvoidancePreview, placeholderHeight, previewTargetVisualIndex])

  const dropPlaceholderTop = useMemo(() => {
    if (!hasAvoidancePreview || previewInsertionVisualIndex === null || topLayerItems.length === 0) {
      return null
    }
    if (previewInsertionVisualIndex >= topLayerItems.length) {
      const lastKey = topLayerItems[topLayerItems.length - 1]?.key
      const lastNode = lastKey ? itemRefs.current.get(lastKey) : null
      if (!lastNode) return null
      return Math.max(0, lastNode.offsetTop + lastNode.offsetHeight)
    }
    const targetKey = topLayerItems[previewInsertionVisualIndex]?.key
    const targetNode = targetKey ? itemRefs.current.get(targetKey) : null
    if (!targetNode) return null
    return Math.max(0, targetNode.offsetTop)
  }, [hasAvoidancePreview, previewInsertionVisualIndex, topLayerItems])

  const handleDragStart = (item: LayerItem, draggable: boolean) => (e: React.DragEvent) => {
    if (!draggable) { e.preventDefault(); return }
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', item.key)
    } catch {
      // 某些环境下 setData 可能受限，不影响主流程
    }
    setDragKey(item.key)
    setDragRange({ start: item.start, end: item.end })
    setDropTarget(null)
    const node = itemRefs.current.get(item.key)
    if (!node) {
      setDragItemHeight(0)
      return
    }
    const rect = node.getBoundingClientRect()
    setDragItemHeight(Math.max(0, Math.round(rect.height)))
  }

  const handleDragOver = (key: string) => (e: React.DragEvent) => {
    if (!dragRange) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const placement: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTarget({ key, placement })
  }

  const handleDrop = (targetStart: number, targetEnd: number, targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragRange) return
    const placement: LayerDropPlacement = dropTarget && dropTarget.key === targetKey ? dropTarget.placement : 'before'
    const dragItem = layerItems.find((item) => item.key === dragKey)
    const toArrayIdx = computeLayerDropToIndex({ drag: dragRange, target: { start: targetStart, end: targetEnd }, placement, totalCount: page.elements.length, dragMemberCount: dragItem?.ids.length, dragMemberIndices: dragItem?.memberIndices ? new Set(dragItem.memberIndices) : undefined })
    if (toArrayIdx !== null) onReorder(dragRange.start, toArrayIdx)
    setDragKey(null); setDragRange(null); setDropTarget(null); setDragItemHeight(0)
  }

  const handleDragEnd = () => { setDragKey(null); setDragRange(null); setDropTarget(null); setDragItemHeight(0) }

  const toggleGroupExpanded = (groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId)
      return next
    })
  }

  const beginGroupRename = (groupId: string, currentName?: string) => {
    setEditingGroupId(groupId)
    setEditingGroupName((currentName || '').trim())
  }

  const commitGroupRename = (groupId: string, ids: string[]) => {
    if (editingGroupId !== groupId) return
    onSetGroupName(ids, editingGroupName)
    setEditingGroupId(null); setEditingGroupName('')
  }

  const cancelGroupRename = () => { setEditingGroupId(null); setEditingGroupName('') }
  const getLayerActionTitle = (key: string) => (
    hasSelection && !hasMovableSelection
      ? translate('property.layer.action.lockedHint')
      : translate(key)
  )
  const getLayerElementLabel = useCallback((element: PPTElement) => {
    if (element.type === 'text') {
      const raw = element.content || ''
      const stripped = raw.replace(/<[^>]+>/g, '').trim()
      return stripped.length > 20 ? `${stripped.slice(0, 20)}…` : stripped || translate('element.type.text')
    }
    if (element.type === 'image') return translate('element.type.image')
    if (element.type === 'chart') return element.chartTitle || translate('element.type.chart')
    if (element.type === 'table') return translate('element.type.table')
    if (element.type === 'latex') return translate('element.type.latex')
    if (element.type === 'shape') return element.text?.content?.replace(/<[^>]+>/g, '').trim() || translate('element.type.shape')
    if (element.type === 'video') return translate('element.type.video')
    if (element.type === 'audio') return translate('element.type.audio')
    return element.type
  }, [translate])

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <ScrollArea
        style={{ flex: 1, minWidth: 0 }}
        viewportStyle={{ padding: '4px 0', position: 'relative', minWidth: 0 }}
      >
        {topLayerItems.length === 0 ? (
          <div className="py-5 px-3.5 text-body text-muted-foreground/60 text-center">
            {translate('property.layer.empty')}
          </div>
        ) : (
          <>
            {topLayerItems.map((item, visualIdx) => {
              const isDragging = dragKey === item.key
              const dropPlacement = dropTarget?.key === item.key ? dropTarget.placement : null
              const showDropBefore = !hasAvoidancePreview && !isDragging && dropPlacement === 'before'
              const showDropAfter = !hasAvoidancePreview && !isDragging && dropPlacement === 'after'

              if (item.kind === 'element') {
                const el = item.element
                const isSelected = selectedSet.has(el.id)
                const isHidden = el.visible === false
                const isLocked = el.locked
                const canReorder = movableIdSet.has(el.id)
                const elName = getLayerElementLabel(el)

                return (
                  <div
                    key={item.key}
                    ref={(node) => setItemRef(item.key, node)}
                    className={`min-w-0 ${isDragging ? 'opacity-[0.05]' : ''}`}
                    style={{
                      transform: `translateY(${getItemShiftY(visualIdx, item.key)}px)`,
                      transition: dragKey !== null ? 'transform 180ms ease' : undefined,
                      willChange: dragKey !== null ? 'transform' : undefined,
                    }}
                  >
                    <div
                      draggable={canReorder}
                      onDragStart={handleDragStart(item, canReorder)}
                      onDragOver={handleDragOver(item.key)}
                      onDrop={handleDrop(item.start, item.end, item.key)}
                      onDragEnd={handleDragEnd}
                      onClick={(e) => onSelect(el.id, shouldAppendSelection(e.nativeEvent))}
                      className={`flex items-center gap-1.5 py-1 pr-2.5 pl-3.5 w-full min-w-0 box-border overflow-hidden text-body select-none transition-colors ${canReorder ? 'cursor-grab' : 'cursor-pointer'} ${isHidden ? 'text-muted-foreground/60 opacity-50' : 'text-foreground'} ${isSelected ? 'bg-accent/10' : 'hover:bg-muted/80'} ${showDropBefore ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent'} ${showDropAfter ? 'border-b-2 border-b-accent' : 'border-b-2 border-b-transparent'}`}
                    >
                      <span className={`flex shrink-0 ${isSelected ? 'text-accent' : 'text-muted-foreground/60'}`}>
                        {TypeIcons[el.type] || TypeIcons.shape}
                      </span>
                      <span className={`flex-1 min-w-0 truncate ${isHidden ? 'line-through' : ''}`}>
                        {elName}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); onToggleVisibility(el.id) }} title={isHidden ? translate('property.layer.show') : translate('property.layer.hide')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${isHidden ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
                        {isHidden ? <EyeClosedIcon /> : <EyeOpenIcon />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); onToggleLock(el.id) }} title={isLocked ? translate('property.layer.unlock') : translate('property.layer.lock')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${isLocked ? 'text-accent' : 'text-muted-foreground/60'}`}>
                        {isLocked ? <LockIcon /> : <UnlockIcon />}
                      </button>
                    </div>
                  </div>
                )
              }

              const groupSelectedCount = item.ids.filter((id) => selectedSet.has(id)).length
              const isGroupSelected = groupSelectedCount === item.ids.length && groupSelectedCount > 0
              const isGroupPartial = groupSelectedCount > 0 && groupSelectedCount < item.ids.length
              const allHidden = item.members.every((member) => member.visible === false)
              const anyHidden = item.members.some((member) => member.visible === false)
              const allLocked = item.members.every((member) => member.locked)
              const anyLocked = item.members.some((member) => member.locked)
              const canReorder = item.ids.every((id) => movableIdSet.has(id))
              const isExpanded = expandedGroupIds.has(item.groupId)
              const customGroupName = item.members
                .map((member) => (typeof member.groupName === 'string' ? member.groupName.trim() : ''))
                .find((name) => name.length > 0)
              const groupDisplayName = customGroupName || translate('property.layer.group.defaultName', { count: item.members.length })
              const isEditingGroup = editingGroupId === item.groupId

              return (
                <div
                  key={item.key}
                  ref={(node) => setItemRef(item.key, node)}
                  className={`min-w-0 ${isDragging ? 'opacity-[0.05]' : ''}`}
                  style={{
                    transform: `translateY(${getItemShiftY(visualIdx, item.key)}px)`,
                    transition: dragKey !== null ? 'transform 180ms ease' : undefined,
                    willChange: dragKey !== null ? 'transform' : undefined,
                  }}
                >
                  <div
                    draggable={canReorder}
                    onDragStart={handleDragStart(item, canReorder)}
                    onDragOver={handleDragOver(item.key)}
                    onDrop={handleDrop(item.start, item.end, item.key)}
                    onDragEnd={handleDragEnd}
                    onClick={(e) => onSelect(item.members[0]!.id, shouldAppendSelection(e.nativeEvent))}
                    onDoubleClick={(e) => { e.stopPropagation(); beginGroupRename(item.groupId, customGroupName) }}
                    className={`flex items-center gap-1.5 py-1 px-2.5 w-full min-w-0 box-border overflow-hidden text-body select-none transition-colors ${canReorder ? 'cursor-grab' : 'cursor-pointer'} ${allHidden ? 'text-muted-foreground/60 opacity-50' : 'text-foreground'} ${isGroupSelected ? 'bg-accent/10' : isGroupPartial ? 'bg-muted/60' : 'hover:bg-muted/80'} ${showDropBefore ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent'} ${showDropAfter ? 'border-b-2 border-b-accent' : 'border-b-2 border-b-transparent'}`}
                  >
                    <button onClick={(e) => { e.stopPropagation(); toggleGroupExpanded(item.groupId) }} title={isExpanded ? translate('property.layer.group.collapse') : translate('property.layer.group.expand')} className="border-none bg-transparent p-0 mr-px w-3 h-3 text-muted-foreground/60 flex items-center justify-center cursor-pointer shrink-0">
                      <ChevronIcon expanded={isExpanded} />
                    </button>
                    <span className={`flex shrink-0 ${isGroupSelected ? 'text-accent' : 'text-muted-foreground'}`}>
                      <GroupIcon />
                    </span>
                    {isEditingGroup ? (
                      <input
                        autoFocus value={editingGroupName}
                        onChange={(e) => setEditingGroupName(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitGroupRename(item.groupId, item.ids); return } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelGroupRename() } }}
                        onBlur={() => commitGroupRename(item.groupId, item.ids)}
                        placeholder={translate('property.layer.group.placeholder')}
                        className="flex-1 min-w-0 border border-accent rounded bg-background text-foreground text-body py-0.5 px-1.5 outline-none"
                      />
                    ) : (
                      <span className={`flex-1 min-w-0 truncate font-medium ${allHidden ? 'line-through' : ''}`} title={translate('property.layer.group.renameHint')}>
                        {groupDisplayName}
                      </span>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); onSetVisibility(item.ids, allHidden) }} title={allHidden ? translate('property.layer.group.show') : anyHidden ? translate('property.layer.group.hidePartial') : translate('property.layer.group.hide')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${allHidden ? 'text-muted-foreground/60' : anyHidden ? 'text-accent' : 'text-muted-foreground'}`}>
                      {allHidden ? <EyeClosedIcon /> : <EyeOpenIcon />}
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); onSetLock(item.ids, !allLocked) }} title={allLocked ? translate('property.layer.group.unlock') : anyLocked ? translate('property.layer.group.lockPartial') : translate('property.layer.group.lock')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${allLocked || anyLocked ? 'text-accent' : 'text-muted-foreground/60'}`}>
                      {allLocked ? <LockIcon /> : <UnlockIcon />}
                    </button>
                  </div>

                  {isExpanded && [...item.members].reverse().map((member, memberIdx) => {
                    const isMemberSelected = selectedSet.has(member.id)
                    const isMemberHidden = member.visible === false
                    const isMemberLocked = member.locked
                    const memberName = getLayerElementLabel(member)
                    return (
                      <div
                        key={`${item.key}:member:${member.id}`}
                        onClick={(e) => {
                          if (shouldAppendSelection(e.nativeEvent)) {
                            onSelect(member.id, true)
                          } else if (onSelectDirect) {
                            onSelectDirect([member.id])
                          } else {
                            onSelect(member.id, false)
                          }
                        }}
                        className={`flex items-center gap-1.5 py-1 pr-2.5 pl-7 w-full min-w-0 box-border overflow-hidden cursor-pointer text-body select-none transition-colors ${isMemberHidden ? 'text-muted-foreground/60 opacity-[0.55]' : 'text-muted-foreground'} ${isMemberSelected ? 'bg-accent/10' : 'hover:bg-muted/80'}`}
                      >
                        <span className={`flex shrink-0 ${isMemberSelected ? 'text-accent' : 'text-muted-foreground/60'}`}>
                          {TypeIcons[member.type] || TypeIcons.shape}
                        </span>
                        <span className={`flex-1 min-w-0 truncate ${isMemberHidden ? 'line-through' : ''}`}>
                          {memberName}
                        </span>
                        <button onClick={(e) => { e.stopPropagation(); onToggleVisibility(member.id) }} title={isMemberHidden ? translate('property.layer.show') : translate('property.layer.hide')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${isMemberHidden ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
                          {isMemberHidden ? <EyeClosedIcon /> : <EyeOpenIcon />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onToggleLock(member.id) }} title={isMemberLocked ? translate('property.layer.unlock') : translate('property.layer.lock')} className={`border-none bg-transparent p-0.5 cursor-pointer flex rounded-sm shrink-0 ${isMemberLocked ? 'text-accent' : 'text-muted-foreground/60'}`}>
                          {isMemberLocked ? <LockIcon /> : <UnlockIcon />}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })}

            {dropPlaceholderTop !== null && (
              <div
                className="absolute left-2.5 right-2.5 border border-dashed border-accent rounded-sm bg-accent/10 pointer-events-none box-border z-[1]"
                style={{ top: dropPlaceholderTop, height: placeholderHeight }}
              />
            )}
          </>
        )}
      </ScrollArea>

      <div className="flex shrink-0 items-center border-t border-border/30 px-2.5 py-1" aria-label="Layer actions">
        <div className="flex gap-1.5">
          <LayerBtn title={getLayerActionTitle('property.layer.action.toFront')} onClick={() => onBringToFront(selectedIds)} disabled={!hasMovableSelection}>
            <ArrowUpToLine className="h-3 w-3" strokeWidth={1.75} />
          </LayerBtn>
          <LayerBtn title={getLayerActionTitle('property.layer.action.forward')} onClick={() => onBringForward(selectedIds)} disabled={!hasMovableSelection}>
            <ArrowUp className="h-3 w-3" strokeWidth={1.75} />
          </LayerBtn>
          <LayerBtn title={getLayerActionTitle('property.layer.action.backward')} onClick={() => onSendBackward(selectedIds)} disabled={!hasMovableSelection}>
            <ArrowDown className="h-3 w-3" strokeWidth={1.75} />
          </LayerBtn>
          <LayerBtn title={getLayerActionTitle('property.layer.action.toBack')} onClick={() => onSendToBack(selectedIds)} disabled={!hasMovableSelection}>
            <ArrowDownToLine className="h-3 w-3" strokeWidth={1.75} />
          </LayerBtn>
        </div>
        <div className="flex-1" />
        <div className="flex gap-0.5">
          <LayerBtn
            title={translate(allLayersHidden ? 'property.layer.action.showAll' : 'property.layer.action.hideAll')}
            onClick={() => onSetVisibility(allElementIds, allLayersHidden)}
            disabled={!hasLayerItems}
          >
            {allLayersHidden ? <EyeOff className="h-3 w-3" strokeWidth={1.75} /> : <Eye className="h-3 w-3" strokeWidth={1.75} />}
          </LayerBtn>
          <LayerBtn
            title={translate(allLayersLocked ? 'property.layer.action.unlockAll' : 'property.layer.action.lockAll')}
            onClick={() => onSetLock(allElementIds, !allLayersLocked)}
            disabled={!hasLayerItems}
            active={allLayersLocked}
          >
            {allLayersLocked ? <Lock className="h-3 w-3" strokeWidth={1.75} /> : <Unlock className="h-3 w-3" strokeWidth={1.75} />}
          </LayerBtn>
        </div>
      </div>
    </div>
  )
}

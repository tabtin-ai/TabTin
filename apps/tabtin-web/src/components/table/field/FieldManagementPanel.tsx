/**
 * FieldManagementPanel — Web 端字段管理面板
 *
 * 对齐 Electron 的 FieldManagementDialog：
 * - 拖拽重排序字段顺序
 * - 开关控制字段可见性
 * - 主键字段不可隐藏
 * - 搜索过滤
 * - 通过 updateView({ column_meta }) 持久化
 */

import React, { useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  toast,
  ScrollArea,
} from '@tabtin/smartsheet-ui'
import { Eye, EyeOff, GripVertical, Search } from 'lucide-react'
import type { Field, ViewColumnMeta, ViewMeta, ViewUpdateRequest } from '@tabtin/table-core'
import { buildColumnMetaUpdatePayload } from '@/types/table-adapters'
import {
  FIELD_MANAGEMENT_CONTENT_CLASS_NAME,
  FIELD_MANAGEMENT_LIST_CLASS_NAME,
  FIELD_MANAGEMENT_SUMMARY_CLASS_NAME,
} from './fieldManagementLayout'

interface FieldManagementPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fields: Field[]
  currentView: ViewMeta | null
  updateView: (
    viewId: string,
    payload: ViewUpdateRequest,
    options?: { silent?: boolean; refreshRecords?: boolean }
  ) => Promise<unknown>
}

function getFieldOrder(view: ViewMeta | null, fields: Field[]): string[] {
  const meta = (view?.column_meta ?? {}) as Record<string, { order?: number }>
  const sorted = [...fields].sort((a, b) => {
    const oa = meta[a.id]?.order ?? Infinity
    const ob = meta[b.id]?.order ?? Infinity
    return oa - ob
  })
  return sorted.map(f => f.id)
}

function getVisibleFieldIds(view: ViewMeta | null, fields: Field[]): Set<string> {
  const meta = (view?.column_meta ?? {}) as Record<string, { hidden?: boolean; visible?: boolean }>
  const visible = new Set<string>()
  for (const f of fields) {
    const cm = meta[f.id]
    if (cm?.hidden === true) continue
    if (cm?.visible === false) continue
    visible.add(f.id)
  }
  if (visible.size === 0 && fields.length > 0) {
    for (const f of fields) visible.add(f.id)
  }
  return visible
}

const GRID_LOCKED_PRIMARY = true

interface SortableFieldItemProps {
  field: Field
  isVisible: boolean
  isPrimaryLocked: boolean
  primaryLabel: string
  onToggle: (fieldId: string) => void
}

const SortableFieldItem: React.FC<SortableFieldItemProps> = ({
  field,
  isVisible,
  isPrimaryLocked,
  primaryLabel,
  onToggle,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-md border border-transparent px-2 py-1.5 hover:bg-accent/50"
    >
      <button
        type="button"
        className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <span className="flex-1 truncate text-body">{field.name}</span>
      {field.is_primary && (
        <span className="shrink-0 text-caption text-muted-foreground">
          {primaryLabel}
        </span>
      )}
      <Switch
        checked={isVisible}
        onCheckedChange={() => onToggle(field.id)}
        disabled={isPrimaryLocked && field.is_primary}
        className="shrink-0"
      />
    </div>
  )
}

export const FieldManagementPanel: React.FC<FieldManagementPanelProps> = ({
  open,
  onOpenChange,
  fields,
  currentView,
  updateView,
}) => {
  const { t } = useTranslation('table')
  const [searchQuery, setSearchQuery] = useState('')

  const orderedFieldIds = useMemo(
    () => getFieldOrder(currentView, fields),
    [currentView, fields],
  )
  const visibleFieldIds = useMemo(
    () => getVisibleFieldIds(currentView, fields),
    [currentView, fields],
  )

  const fieldById = useMemo(() => {
    const map = new Map<string, Field>()
    for (const f of fields) map.set(f.id, f)
    return map
  }, [fields])

  const orderedFields = useMemo(
    () => orderedFieldIds.map(id => fieldById.get(id)).filter(Boolean) as Field[],
    [orderedFieldIds, fieldById],
  )

  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return orderedFields
    const q = searchQuery.trim().toLowerCase()
    return orderedFields.filter(f =>
      f.name.toLowerCase().includes(q) || f.field_type.toLowerCase().includes(q),
    )
  }, [orderedFields, searchQuery])

  const visibleCount = visibleFieldIds.size
  const hiddenCount = fields.length - visibleCount

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const buildColumnMeta = useCallback(
    (nextOrder: string[], nextVisible: Set<string>): ViewColumnMeta => {
      const meta: ViewColumnMeta = {}
      for (let i = 0; i < nextOrder.length; i++) {
        meta[nextOrder[i]] = {
          order: i,
          hidden: !nextVisible.has(nextOrder[i]),
        }
      }
      return meta
    },
    [],
  )

  const persistColumnMeta = useCallback(
    async (meta: ViewColumnMeta) => {
      if (!currentView) return
      try {
        await updateView(
          currentView.id,
          buildColumnMetaUpdatePayload(meta),
          { silent: true, refreshRecords: false },
        )
      } catch (e) {
        console.error('[FieldManagement] update failed', e)
        toast({ title: t('actions.reorderFailed', { defaultValue: 'Operation failed' }), variant: 'destructive' })
      }
    },
    [currentView, updateView, t],
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = orderedFieldIds.indexOf(String(active.id))
      const newIndex = orderedFieldIds.indexOf(String(over.id))
      if (oldIndex === -1 || newIndex === -1) return

      const nextOrder = arrayMove(orderedFieldIds, oldIndex, newIndex)
      void persistColumnMeta(buildColumnMeta(nextOrder, visibleFieldIds))
    },
    [orderedFieldIds, visibleFieldIds, buildColumnMeta, persistColumnMeta],
  )

  const handleToggleVisibility = useCallback(
    (fieldId: string) => {
      const next = new Set(visibleFieldIds)
      if (next.has(fieldId)) {
        if (next.size <= 1) {
          toast({ title: t('toolbar.cannotHideLastField', { defaultValue: 'At least one visible field must be kept' }), variant: 'destructive' })
          return
        }
        next.delete(fieldId)
      } else {
        next.add(fieldId)
      }
      void persistColumnMeta(buildColumnMeta(orderedFieldIds, next))
    },
    [visibleFieldIds, orderedFieldIds, buildColumnMeta, persistColumnMeta, t],
  )

  const handleShowAll = useCallback(() => {
    const next = new Set(orderedFieldIds)
    void persistColumnMeta(buildColumnMeta(orderedFieldIds, next))
  }, [orderedFieldIds, buildColumnMeta, persistColumnMeta])

  const handleHideAll = useCallback(() => {
    if (fields.length === 0) return
    const primaryId = fields.find(f => f.is_primary)?.id
    const next = new Set<string>()
    if (primaryId) next.add(primaryId)
    if (next.size === 0 && orderedFieldIds.length > 0) {
      next.add(orderedFieldIds[0])
    }
    void persistColumnMeta(buildColumnMeta(orderedFieldIds, next))
  }, [fields, orderedFieldIds, buildColumnMeta, persistColumnMeta])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={FIELD_MANAGEMENT_CONTENT_CLASS_NAME}>
        <DialogHeader>
          <DialogTitle>{t('toolbar.manageFields', { defaultValue: 'Manage fields' })}</DialogTitle>
        </DialogHeader>

        <div className={FIELD_MANAGEMENT_SUMMARY_CLASS_NAME}>
          <span className="min-w-0 whitespace-normal">
            {t('toolbar.fieldSummary', {
              defaultValue: '{{total}} fields · {{visible}} visible · {{hidden}} hidden',
              total: fields.length,
              visible: visibleCount,
              hidden: hiddenCount,
            })}
          </span>
          <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-body"
              onClick={handleShowAll}
            >
              <Eye className="size-3" />
              {t('toolbar.showAll', { defaultValue: 'Show all' })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-body"
              onClick={handleHideAll}
            >
              <EyeOff className="size-3" />
              {t('toolbar.hideAll', { defaultValue: 'Hide all' })}
            </Button>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t('toolbar.searchFields', { defaultValue: 'Search fields...' })}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <ScrollArea className={FIELD_MANAGEMENT_LIST_CLASS_NAME}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={filteredFields.map(f => f.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5 py-1">
                {filteredFields.map(field => (
                  <SortableFieldItem
                    key={field.id}
                    field={field}
                    isVisible={visibleFieldIds.has(field.id)}
                    isPrimaryLocked={GRID_LOCKED_PRIMARY}
                    primaryLabel={t('toolbar.primaryField', { defaultValue: 'Primary key' })}
                    onToggle={handleToggleVisibility}
                  />
                ))}
                {filteredFields.length === 0 && (
                  <div className="py-6 text-center text-body text-muted-foreground">
                    {t('toolbar.noFieldsFound', { defaultValue: 'No fields found' })}
                  </div>
                )}
              </div>
            </SortableContext>
          </DndContext>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

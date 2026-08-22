/**
 * FieldManagementDialog - 字段管理对话框
 * 显示所有字段，支持编辑、删除、可见性切换、AI 配置
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  ConfirmDialog,
  Input,
  ScrollArea,
  toast,
  EmptyState,
  cn,
} from '@tabtin/smartsheet-ui';
import { useShallow } from 'zustand/react/shallow';
import { useTableStore } from '@stores/useTableStore';
import { useViewStore } from '@stores/useViewStore';
import {
  buildColumnMetaUpdatePayload,
  FieldApiService,
  isPrimaryFieldAllowedType,
} from '@tabtin/table-core';
import {
  Eye,
  EyeOff,
  Search,
  GripVertical,
} from 'lucide-react';
import { arrayMove } from '@dnd-kit/sortable';
import type { Field } from '@tabtin/table-core';
import { useFieldSettingStore } from '@/stores/useFieldSettingStore';
import { useTableCollabOptional } from '../table/TableCollabContext';
import { useUndoRedoContext } from '@components/view/UndoRedoContext';
import { useCollabViewsMetaForTable } from '@stores/useTableCollabStore';
import { FieldTypeIcon } from './FieldTypeIcon';
import { FieldRowMoreMenu } from './FieldRowMoreMenu';
import {
  buildViewColumnMetaUpdate,
  buildViewVisibilityColumnMetaOnlyUpdate,
  getViewFieldOrderSnapshot,
  getViewVisibilitySnapshot,
  isPrimaryVisibilityLocked,
  mergeReorderedSubsetIntoFieldOrder,
} from '@tabtin/table-ui';
import {
  DndKitContext,
  Draggable,
  Droppable,
  type DragEndEvent,
  verticalListSortingStrategy,
} from '@/components/common/dnd-kit';
import { useTranslation } from 'react-i18next';

export interface FieldManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container?: HTMLElement | null;
}

export const FieldManagementDialog: React.FC<FieldManagementDialogProps> = ({
  open,
  onOpenChange,
  container,
}) => {
  const { t } = useTranslation(['field', 'common', 'table']);
  const { selectedTable, fields, loadFields, getTable } = useTableStore(
    useShallow((s) => ({
      selectedTable: s.selectedTable,
      fields: s.fields,
      loadFields: s.loadFields,
      getTable: s.getTable,
    })),
  );
  const views = useViewStore((state) => state.views);
  const currentViewId = useViewStore((state) => state.currentViewId);
  const updateViewRest = useViewStore((state) => state.updateView);
  // ：协作在线时字段显隐/重排必须写 Y.Doc viewsMeta（updateViewForRuntime），
  // 否则只写 REST、协作显示读 Y.Doc 看不到变化（「隐藏字段没用」）。
  const tableCollab = useTableCollabOptional();
  const undoRedoContext = useUndoRedoContext();
  const updateView = tableCollab?.updateViewForRuntime ?? updateViewRest;
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingField, setDeletingField] = useState<Field | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isReordering, setIsReordering] = useState(false);

  // ：协作在线时视图配置（可见性/列序）的权威源是 Y.Doc viewsMeta。读写必须同源，
  // 否则 toggle 基于过时的 REST 快照计算，会复活其它已隐藏字段、且开关状态不刷新。
  const collabViewsMeta = useCollabViewsMetaForTable(selectedTable?.id ?? null);
  const currentView = useMemo(() => {
    if (collabViewsMeta) {
      const collabView = collabViewsMeta.find(
        (view) => String(view.id) === currentViewId,
      );
      if (collabView) return collabView;
    }
    return views.find((view) => view.id === currentViewId) ?? null;
  }, [collabViewsMeta, views, currentViewId]);

  const { visibleFieldIds } = useMemo(
    () => getViewVisibilitySnapshot(currentView, fields),
    [currentView, fields],
  );
  const { orderedFieldIds: baseOrderedFieldIds } = useMemo(
    () => getViewFieldOrderSnapshot(currentView, fields),
    [currentView, fields],
  );
  const [orderedFieldIds, setOrderedFieldIds] =
    useState<string[]>(baseOrderedFieldIds);
  const lockPrimaryVisibility = useMemo(
    () => isPrimaryVisibilityLocked(currentView?.view_type),
    [currentView?.view_type],
  );

  const canToggleVisibility = Boolean(currentView);

  useEffect(() => {
    setOrderedFieldIds(baseOrderedFieldIds);
  }, [baseOrderedFieldIds, open]);

  const orderedFields = useMemo(() => {
    const fieldById = new Map(fields.map((field) => [field.id, field]));
    return orderedFieldIds
      .map((fieldId) => fieldById.get(fieldId))
      .filter((field): field is Field => Boolean(field));
  }, [fields, orderedFieldIds]);

  const filteredFields = useMemo(() => {
    const sourceFields = orderedFields.length > 0 ? orderedFields : fields;
    if (!searchQuery.trim()) return sourceFields;
    const q = searchQuery.trim().toLowerCase();
    return sourceFields.filter(
      (field) =>
        field.name.toLowerCase().includes(q) ||
        field.field_type.toLowerCase().includes(q),
    );
  }, [fields, orderedFields, searchQuery]);

  const filteredFieldIds = useMemo(
    () => filteredFields.map((field) => field.id),
    [filteredFields],
  );
  const canReorderFields =
    Boolean(currentView) && filteredFields.length > 1 && !isReordering;

  // Reset search when dialog closes
  useEffect(() => {
    if (!open) setSearchQuery('');
  }, [open]);

  const handleEdit = (field: Field) => {
    useFieldSettingStore
      .getState()
      .openForEdit(field.id, undefined, selectedTable?.id ?? null);
  };

  const handleDelete = (field: Field) => {
    setDeletingField(field);
    setShowDeleteConfirm(true);
  };

  const handleToggleVisibility = async (field: Field) => {
    if (!currentView || !canToggleVisibility) {
      toast({
        title: t('field:errors.visibilityUnavailableTitle'),
        description: t('field:errors.visibilityUnavailableDesc'),
        variant: 'destructive',
      });
      return;
    }
    if (field.is_primary && lockPrimaryVisibility) {
      return;
    }

    const isVisible = visibleFieldIds.includes(field.id);
    const nextVisible = isVisible
      ? visibleFieldIds.filter((fieldId) => fieldId !== field.id)
      : [...visibleFieldIds, field.id];

    if (nextVisible.length === 0) {
      toast({
        title: t('field:errors.keepAtLeastOneTitle'),
        description: t('field:errors.keepAtLeastOneDesc'),
        variant: 'destructive',
      });
      return;
    }

    try {
      const payload = buildViewVisibilityColumnMetaOnlyUpdate(
        currentView,
        fields,
        nextVisible,
      );
      await updateView(currentView.id, payload);
    } catch (error) {
      console.error('❌ 更新字段可见性失败:', error);
      toast({
        title: t('field:errors.updateFailedTitle'),
        description:
          error instanceof Error
            ? error.message
            : t('field:errors.updateFailedDesc'),
        variant: 'destructive',
      });
    }
  };

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      if (!currentView?.id || isReordering) {
        return;
      }

      const activeId = String(event.active.id);
      const overId = event.over?.id ? String(event.over.id) : null;

      if (!overId || activeId === overId) {
        return;
      }

      const fromIndex = filteredFieldIds.indexOf(activeId);
      const toIndex = filteredFieldIds.indexOf(overId);

      if (fromIndex < 0 || toIndex < 0) {
        return;
      }

      const nextSubsetOrder = arrayMove(filteredFieldIds, fromIndex, toIndex);
      const nextFieldOrder = mergeReorderedSubsetIntoFieldOrder(
        orderedFieldIds,
        nextSubsetOrder,
      );

      if (
        nextFieldOrder.every(
          (fieldId, index) => fieldId === orderedFieldIds[index],
        )
      ) {
        return;
      }

      const nextColumnMeta = buildViewColumnMetaUpdate(currentView, fields, {
        visibleFieldIds,
        fieldOrder: nextFieldOrder,
      });

      setOrderedFieldIds(nextFieldOrder);
      setIsReordering(true);

      try {
        const result = await updateView(
          currentView.id,
          buildColumnMetaUpdatePayload(nextColumnMeta),
          {
            silent: true,
            refreshRecords: false,
          },
        );

        if (!result) {
          throw new Error(String(t('table:field.reorderFailedDesc')));
        }
      } catch (error) {
        console.error('❌ 更新字段顺序失败:', error);
        setOrderedFieldIds(baseOrderedFieldIds);
        toast({
          title: t('table:field.reorderFailedTitle'),
          description:
            error instanceof Error
              ? error.message
              : t('table:field.reorderFailedDesc'),
          variant: 'destructive',
        });
      } finally {
        setIsReordering(false);
      }
    },
    [
      baseOrderedFieldIds,
      currentView,
      fields,
      filteredFieldIds,
      isReordering,
      orderedFieldIds,
      t,
      updateView,
      visibleFieldIds,
    ],
  );

  const handleConfirmDelete = async () => {
    if (!deletingField || !selectedTable) return;

    try {
      await FieldApiService.deleteField(deletingField.id);

      // 刷新字段列表
      await loadFields(selectedTable.id);
      await undoRedoContext?.refreshStacks();
      undoRedoContext?.recordBackendUndoable();

      setDeletingField(null);
    } catch (error) {
      console.error('❌ 删除字段失败:', error);
    }
  };

  const handleSetPrimaryField = async (field: Field) => {
    if (!selectedTable || field.is_primary || !isPrimaryFieldAllowedType(field.field_type)) {
      return;
    }

    try {
      let schemaVersion =
        typeof selectedTable.schema_version === 'number'
          ? selectedTable.schema_version
          : undefined;
      await FieldApiService.setPrimaryField(field.id, {
        getExpectedSchemaVersion: () => schemaVersion,
        refreshSchemaVersion: async () => {
          const table = await getTable(selectedTable.id);
          if (typeof table?.schema_version === 'number') {
            schemaVersion = table.schema_version;
          }
        },
      });
      await getTable(selectedTable.id);
      await loadFields(selectedTable.id);
      await undoRedoContext?.refreshStacks();
      toast({
        title: t('field:actions.setPrimarySuccess'),
      });
    } catch (error) {
      console.error('❌ 设置主字段失败:', error);
      toast({
        title: t('field:errors.setPrimaryFailedTitle'),
        description:
          error instanceof Error
            ? error.message
            : t('field:errors.setPrimaryFailedDesc'),
        variant: 'destructive',
      });
    }
  };

  if (!selectedTable) return null;

  const visibleCount = fields.filter((f) =>
    visibleFieldIds.includes(f.id),
  ).length;
  const hiddenCount = fields.length - visibleCount;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
        <SheetContent
          side="right"
          overlay={false}
          container={container}
          className="pointer-events-auto w-[420px] sm:max-w-[420px] flex flex-col overflow-hidden p-0 shadow-2xl data-[state=open]:!animate-none data-[state=closed]:!animate-none !transition-none"
          onFocusOutside={(event) => event.preventDefault()}
        >
          <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-body">
              {t('field:dialog.title')}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t('field:dialog.description', {
                defaultValue: '管理表格字段的显示、编辑与删除。',
              })}
            </SheetDescription>
          </SheetHeader>

          {/* Summary bar */}
          <div className="flex items-center gap-3 px-4 text-body text-muted-foreground">
            <span>
              {t('field:dialog.totalFields', {
                count: fields.length,
                defaultValue: '共 {{count}} 个字段',
              })}
            </span>
            {canToggleVisibility && (
              <>
                <span className="text-border">|</span>
                <span className="flex items-center gap-1">
                  <Eye className="h-3 w-3" />
                  {visibleCount}
                </span>
                {hiddenCount > 0 && (
                  <span className="flex items-center gap-1 text-muted-foreground/60">
                    <EyeOff className="h-3 w-3" />
                    {hiddenCount}
                  </span>
                )}
              </>
            )}
          </div>

          {/* Search */}
          {fields.length > 6 && (
            <div className="px-4">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={String(
                    t('field:dialog.searchPlaceholder', {
                      defaultValue: '搜索字段…',
                    }),
                  )}
                  className="h-8 pl-8 text-body"
                />
              </div>
            </div>
          )}

          {/* Field list */}
          <DndKitContext onDragEnd={handleDragEnd}>
            <ScrollArea className="flex-1 px-4 pb-4">
              <div className="space-y-0.5">
                {filteredFields.length === 0 ? (
                  <EmptyState
                    icon="search"
                    title={
                      searchQuery.trim()
                        ? t('field:dialog.noSearchResults', {
                            defaultValue: '没有匹配的字段',
                          })
                        : t('field:dialog.empty')
                    }
                    size="sm"
                    className="py-8"
                  />
                ) : (
                  <Droppable
                    items={filteredFieldIds}
                    strategy={verticalListSortingStrategy}
                  >
                    {filteredFields.map((field) => {
                      const isVisible = visibleFieldIds.includes(field.id);
                      return (
                        <Draggable
                          key={field.id}
                          id={field.id}
                          disabled={!canReorderFields}
                        >
                          {({
                            setNodeRef,
                            attributes,
                            listeners,
                            style,
                            isDragging,
                          }) => (
                            <div
                              key={field.id}
                              id={field.id}
                              ref={setNodeRef}
                              style={style}
                              className={cn(
                                'group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60',
                                !isVisible &&
                                  canToggleVisibility &&
                                  'opacity-60',
                                isDragging && 'bg-muted/80 shadow-sm',
                              )}
                            >
                              <button
                                type="button"
                                {...attributes}
                                {...listeners}
                                disabled={!canReorderFields}
                                className={cn(
                                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors',
                                  canReorderFields
                                    ? 'cursor-grab hover:bg-muted hover:text-foreground active:cursor-grabbing'
                                    : 'cursor-default opacity-50',
                                )}
                                title={t('field:dialog.reorderField', {
                                  defaultValue: '拖拽调整字段顺序',
                                })}
                                aria-label={String(
                                  t('field:dialog.reorderField', {
                                    defaultValue: '拖拽调整字段顺序',
                                  }),
                                )}
                              >
                                <GripVertical className="h-3.5 w-3.5" />
                              </button>

                              {/* Field type icon */}
                              <FieldTypeIcon
                                type={field.field_type}
                                className="shrink-0"
                                size={14}
                              />

                              {/* Field name */}
                              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                                <span className="truncate text-body">
                                  {field.name}
                                </span>
                                {field.is_primary && (
                                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0 text-caption font-medium text-primary">
                                    {t('field:labels.primary')}
                                  </span>
                                )}
                              </div>

                              {/* Field type label */}
                              <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">
                                {t(`field:types.${field.field_type}`, {
                                  defaultValue: field.field_type,
                                })}
                              </span>

                              <FieldRowMoreMenu
                                field={field}
                                isVisible={isVisible}
                                canToggleVisibility={canToggleVisibility}
                                lockPrimaryVisibility={lockPrimaryVisibility}
                                onToggleVisibility={handleToggleVisibility}
                                onSetPrimary={handleSetPrimaryField}
                                onEdit={handleEdit}
                                onDelete={handleDelete}
                              />
                            </div>
                          )}
                        </Draggable>
                      );
                    })}
                  </Droppable>
                )}
              </div>
            </ScrollArea>
          </DndKitContext>
        </SheetContent>
      </Sheet>

      {/* 编辑字段已迁移到 FieldSettingPanel，由 useFieldSettingStore 控制 */}

      {/* 删除确认对话框 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title={t('field:dialog.deleteTitle')}
        description={t('field:dialog.deleteDescription', {
          name: deletingField?.name ?? '',
        })}
        confirmText={t('field:actions.delete')}
        cancelText={t('common:cancel')}
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />

      {/* AI 配置已迁移到 FieldSettingPanel，由 useFieldSettingStore 控制 */}
    </>
  );
};

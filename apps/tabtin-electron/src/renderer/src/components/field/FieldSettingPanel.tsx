/**
 * FieldSettingPanel - 统一字段设置面板
 *
 * 合并 EditFieldDialog + CreateFieldDialog + AI 配置，以 Sheet 侧边栏形式展示。
 * 支持 Add / Edit / Insert 三种模式。
 *
 * 调用方通过 useFieldSettingStore 打开面板:
 *   openForAdd()           — 新建字段
 *   openForEdit(fieldId)   — 编辑字段
 *   openForInsert(refId, 'before' | 'after') — 插入字段
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  Button,
  ScrollArea,
  toast,
  ConversionPreviewDialog,
  useFieldConversion,
  FieldConfigFormBody,
  type LinkTableOption,
  type LinkForeignMeta,
  type LinkableFieldItem,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import {
  FieldApiService,
  TableApiService,
  ViewApiService,
  type Field,
  type FieldOptions as CoreFieldOptions,
} from '@tabtin/table-core'
import { useTableStore } from '@/stores/useTableStore'
import { useViewStore } from '@/stores/useViewStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useRecordStore } from '@/stores/useRecordStore'
import { useShallow } from 'zustand/react/shallow'
import { toOrganizationMembers } from '@tabtin/table-ui'
import { useFieldSettingStore } from '@/stores/useFieldSettingStore'
import { useFieldSettingForm, type FieldType } from './useFieldSettingForm'
import { SelectChoicesEditor } from './field-config'
import { useTableCollabOptional } from '@components/table/TableCollabContext'
import {
  announceTableDrawerOpen,
  useCloseOnOtherTableDrawerOpen,
} from '@/components/table/utils/tableDrawerCoordinator'

type ConversionErrorLike = {
  response?: {
    data?: {
      message?: unknown
      error?: unknown
    }
  }
  message?: unknown
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null

const getConversionErrorMessage = (error: unknown): string => {
  const apiError = error as ConversionErrorLike
  return (
    nonEmptyString(apiError.response?.data?.message) ||
    nonEmptyString(apiError.response?.data?.error) ||
    nonEmptyString(apiError.message) ||
    String(error)
  )
}

// ─── Component ──────────────────────────────────────────

interface FieldSettingPanelProps {
  hostId?: string
}

export const FieldSettingPanel: React.FC<FieldSettingPanelProps> = ({ hostId }) => {
  const { t } = useTranslation(['field', 'common'])
  const drawerId = React.useId()

  // ── Store state ──
  const {
    isOpen,
    operator,
    tableId: panelTableId,
    hostId: panelHostId,
    fieldId,
    referenceFieldId,
    insertPosition,
    activeSection,
    initialFieldType,
    initialFieldName,
    close,
  } = useFieldSettingStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      operator: s.operator,
      tableId: s.tableId,
      hostId: s.hostId,
      fieldId: s.fieldId,
      referenceFieldId: s.referenceFieldId,
      insertPosition: s.insertPosition,
      activeSection: s.activeSection,
      initialFieldType: s.initialFieldType,
      initialFieldName: s.initialFieldName,
      close: s.close,
    }))
  )

  const fields = useTableStore((s) => s.fields)
  const selectedTable = useTableStore((s) => s.selectedTable)
  const loadFields = useTableStore((s) => s.loadFields)
  const upsertFieldLocal = useTableStore((s) => s.upsertFieldLocal)
  const currentViewId = useViewStore((s) => s.currentViewId)
  const loadViews = useViewStore((s) => s.loadViews)
  const refreshCurrentView = useViewStore((s) => s.refreshCurrentView)
  const loadRecordsByTable = useRecordStore((s) => s.loadRecordsByTable)
  const selectedSpace = useSpaceStore((s) => s.selectedSpace)
  const organizationMembers = useOrganizationStore((s) => s.members)
  const defaultUserOptions = useMemo(
    () => toOrganizationMembers(organizationMembers),
    [organizationMembers],
  )
  const tableCollab = useTableCollabOptional()
  const isScopedOpen =
    isOpen &&
    (!panelTableId || panelTableId === selectedTable?.id) &&
    (hostId ? panelHostId === hostId : !panelHostId)

  // ── Resolve editing field ──
  const editingField = useMemo<Field | null>(() => {
    if (operator !== 'edit' || !fieldId) return null
    return fields.find((f) => f.id === fieldId) ?? null
  }, [operator, fieldId, fields])

  const isPrimary = editingField?.is_primary ?? false

  // ── Form hook ──
  const form = useFieldSettingForm()
  const {
    state,
    handleFieldTypeChange,
    initForCreate,
    initFromField,
    validate,
    buildPayload,
  } = form

  // ── Loading state ──
  const [isSubmitting, setIsSubmitting] = useState(false)
  const fieldNameInputRef = useRef<HTMLInputElement>(null)

  const conversion = useFieldConversion({
    onError: (error) => {
      toast({
        title: t('field:fieldSettingPanel.conversionFailed', { defaultValue: '字段转换失败' }),
        description: getConversionErrorMessage(error),
        variant: 'destructive',
      })
    },
  })
  const {
    previewOpen: conversionPreviewOpen,
    preview: conversionPreview,
    previewLoading: conversionPreviewLoading,
    converting: conversionConverting,
    startPreview,
    executeConversion: execConversion,
    cancelPreview,
    setPreviewOpen: setConversionPreviewOpen,
    formatResultParts,
  } = conversion

  const [conversionCheckError, setConversionCheckError] = useState<string | null>(null)
  const [conversionCheckPending, setConversionCheckPending] = useState(false)
  const [forceConversion, setForceConversion] = useState(false)
  const conversionCheckSeqRef = useRef(0)

  // Track which open session has been initialized to avoid double-init or missed init
  const initSessionRef = useRef<string | null>(null)

  // ── Initialize form when panel opens ──
  // Use useLayoutEffect to populate form BEFORE browser paints,
  // preventing flash of blank form when opening in edit mode.
  useLayoutEffect(() => {
    if (!isScopedOpen) {
      // Panel closed — invalidate in-flight checks and reset session tracker
      initSessionRef.current = null
      conversionCheckSeqRef.current += 1
      setConversionCheckError(null)
      setConversionCheckPending(false)
      return
    }

    if (operator === 'edit') {
      // 编辑模式：直接从 fields 查找，不依赖 editingField useMemo 的时序
      const field = fieldId ? fields.find((f) => f.id === fieldId) : null
      if (field) {
        const sessionKey = `edit:${field.id}:${field.updated_at}`
        if (initSessionRef.current === sessionKey) return // 已初始化
        initSessionRef.current = sessionKey
        conversionCheckSeqRef.current += 1
        setConversionCheckError(null)
        setConversionCheckPending(false)
        initFromField(field)
      }
      // field 为 null 说明 fields 还没加载完或 fieldId 不匹配，等下一次渲染
      return
    }

    // add / insert 模式（可从右键菜单预填字段类型与名称）
    const sessionKey = `${operator}:${referenceFieldId ?? 'none'}:${initialFieldType ?? 'text'}:${initialFieldName ?? ''}`
    if (initSessionRef.current === sessionKey) return
    initSessionRef.current = sessionKey
    conversionCheckSeqRef.current += 1
    setConversionCheckError(null)
    setConversionCheckPending(false)
    const createType = (initialFieldType as FieldType | null) || 'text'
    initForCreate(createType, initialFieldName ? { name: initialFieldName } : undefined)
  }, [
    isScopedOpen,
    operator,
    fieldId,
    referenceFieldId,
    fields,
    initFromField,
    initForCreate,
    initialFieldType,
    initialFieldName,
  ])

  // ── Delayed focus: wait for Sheet slide-in animation to complete ──
  // Avoids browser scroll-into-view behaviour that shifts the table grid.
  React.useEffect(() => {
    if (!isScopedOpen) return
    const timer = setTimeout(() => {
      fieldNameInputRef.current?.focus({ preventScroll: true })
    }, 350)
    return () => clearTimeout(timer)
  }, [isScopedOpen])

  // ── Data provider callbacks for FieldConfigFormBody ──

  const onLoadTables = useCallback(async (): Promise<LinkTableOption[]> => {
    if (!selectedSpace?.id) return []
    const res = await TableApiService.getTablesBySpace(selectedSpace.organization_id, selectedSpace.id)
    const tableList = (res?.tables || res || []) as Array<{
      id: string
      name: string
      current_user_role?: string | null
    }>
    return tableList.map((t) => ({
      id: t.id,
      name: t.name,
      currentUserRole: t.current_user_role ?? null,
    }))
  }, [selectedSpace?.id, selectedSpace?.organization_id])

  // 高级设置始终按「当前表单选中的目标表」拉字段/视图，避免编辑态走
  // getLinkableFields（读已落库 config）失败时被静默成空列表。
  const onLoadForeignMeta = useCallback(
    async (tableId: string): Promise<LinkForeignMeta> => {
      const [fieldsResp, viewsResp] = await Promise.all([
        FieldApiService.getFields(tableId),
        ViewApiService.getViewsByTable(tableId),
      ])
      const fieldList = (fieldsResp as { fields?: unknown })?.fields ?? fieldsResp
      const mappedFields: LinkableFieldItem[] = (Array.isArray(fieldList) ? fieldList : []).map((f: any) => ({
        id: String(f.id),
        name: f.name || '',
        field_type: f.field_type || 'text',
        is_primary: Boolean(f.is_primary),
      }))
      const viewList = (viewsResp as { views?: unknown })?.views ?? viewsResp
      const views = (Array.isArray(viewList) ? viewList : []).map((v: any) => ({
        id: String(v.id),
        name: v.name || '',
      }))
      return { fields: mappedFields, views }
    },
    [],
  )

  // ── Table fields (for Skill input selector) ──
  const tableFields = useMemo(() => {
    return fields.map((f) => ({ id: f.id, name: f.name, field_type: f.field_type }))
  }, [fields])

  // ── Refresh helper ──
  const refreshFieldsAndView = useCallback(async (options?: { includeRecords?: boolean }) => {
    if (selectedTable?.id) {
      await loadFields(selectedTable.id)
      if (currentViewId) {
        await loadViews(selectedTable.id)
      }
      if (options?.includeRecords) {
        await loadRecordsByTable(selectedTable.id, { page: 1 })
        if (currentViewId) {
          await refreshCurrentView()
        }
      }
    }
  }, [selectedTable?.id, currentViewId, loadFields, loadViews, loadRecordsByTable, refreshCurrentView])

  const isStructuralFieldType = useCallback((type: FieldType) => {
    return type === 'link'
  }, [])

  const isTypeSwitchBlockedInEdit = useCallback(
    (nextType: FieldType) => {
      if (operator !== 'edit' || !editingField) return false
      return nextType !== (editingField.field_type as FieldType) && isStructuralFieldType(nextType)
    },
    [operator, editingField, isStructuralFieldType],
  )

  const getUnsupportedConversionMessage = useCallback(() => {
    return {
      title: t('field:fieldSettingPanel.unsupportedConversionTitle', {
        defaultValue: '该类型不支持直接转换',
      }),
      description: t('field:fieldSettingPanel.unsupportedConversionDesc', {
        defaultValue: '当前字段类型不支持直接转换为该类型，请新建字段后迁移数据。',
      }),
    }
  }, [t])

  const showUnsupportedConversion = useCallback(() => {
    const message = getUnsupportedConversionMessage()
    setConversionCheckError(message.description)
  }, [getUnsupportedConversionMessage])

  // ── Handle field type change ──
  const onFieldTypeChange = useCallback(
    (newType: FieldType) => {
      conversionCheckSeqRef.current += 1
      const checkSeq = conversionCheckSeqRef.current
      if (isTypeSwitchBlockedInEdit(newType)) {
        setConversionCheckPending(false)
        showUnsupportedConversion()
        return
      }
      setConversionCheckError(null)
      setConversionCheckPending(false)

      if (operator === 'edit' && editingField && newType !== editingField.field_type) {
        setConversionCheckPending(true)
        void conversion.checkConversion(editingField.id, newType)
          .then((result) => {
            if (conversionCheckSeqRef.current !== checkSeq) return
            if (result && !result.can_convert) {
              showUnsupportedConversion()
              return
            }
            handleFieldTypeChange(newType, editingField)
          })
          .finally(() => {
            if (conversionCheckSeqRef.current === checkSeq) {
              setConversionCheckPending(false)
            }
          })
        return
      }
      handleFieldTypeChange(newType, editingField)
    },
    [handleFieldTypeChange, editingField, isTypeSwitchBlockedInEdit, operator, conversion, showUnsupportedConversion],
  )

  // ── Execute conversion after preview confirmation ──
  const handleConversionConfirm = useCallback(async () => {
    if (!editingField || !selectedTable?.id) return
    const payload = buildPayload(editingField)
    const result = await execConversion(
      editingField.id,
      state.fieldType as import('@tabtin/table-core').FieldType,
      payload.options as Record<string, unknown> | undefined,
      {
        name: payload.name,
        description: payload.description,
        default_value: payload.default_value,
        width: payload.width,
        validation_rules: payload.validation_rules,
        visibility_roles: payload.visibility_roles,
      },
      { force: forceConversion },
    )
    if (result) {
      const parts = formatResultParts(result, t)
      toast({
        title: t('field:fieldSettingPanel.updateSuccess', { defaultValue: '字段已更新' }),
        description: parts.length > 0 ? parts.join('；') : undefined,
      })
      setForceConversion(false)
      await refreshFieldsAndView({ includeRecords: true })
      close()
    }
  }, [editingField, selectedTable?.id, buildPayload, state.fieldType, execConversion, formatResultParts, refreshFieldsAndView, close, t, forceConversion])

  // ── Handle submit ──
  const handleSubmit = useCallback(async () => {
    const errs = validate({
      existingFields: tableFields,
      excludeFieldId: operator === 'edit' ? fieldId ?? undefined : undefined,
    })
    if (Object.keys(errs).length > 0) return

    if (!selectedTable?.id) {
      toast({
        title: t('field:fieldSettingPanel.noTableError', { defaultValue: '没有选中的表格' }),
        variant: 'destructive',
      })
      return
    }

    if (conversionCheckError) {
      return
    }

    setIsSubmitting(true)

    // 协作路径创建字段已乐观写入 fields store + Y.Doc；此时立即走 REST refresh
    // 会在异步持久化完成前拿到旧字段列表、覆盖刚建的字段（ 回归），故跳过。
    let skipRefresh = false
    let updatedFieldForLocalSync: Field | null = null

    try {
      if (operator === 'edit' && editingField) {
        // ─── Edit mode ───
        const payload = buildPayload(editingField)
        const typeChanged = state.fieldType !== editingField.field_type

        if (typeChanged) {
          if (isStructuralFieldType(state.fieldType)) {
            throw new Error(
              t('field:fieldSettingPanel.typeSwitchBlockedDesc', {
                defaultValue: '关联字段和查找引用字段需要新建后迁移数据，不支持通过类型转换直接修改。',
              }),
            )
          }

          setIsSubmitting(false)
          await startPreview(
            editingField.id,
            editingField.name,
            editingField.field_type,
            state.fieldType,
            payload.options as Record<string, unknown>,
          )
          return
        }

        // : 无论是否在协作模式，字段编辑必须通过 REST API 持久化。
        // 协作路径（updateFieldForRuntime）仅写 Y.Doc，不调 REST，导致保存无效。
        const updatedField = await FieldApiService.updateField(editingField.id, {
          name: payload.name,
          description: payload.description,
          default_value: payload.default_value,
          options: payload.options as CoreFieldOptions | undefined,
          width: payload.width,
          validation_rules: payload.validation_rules,
          visibility_roles: payload.visibility_roles,
        })
        updatedFieldForLocalSync = updatedField
        upsertFieldLocal(selectedTable.id, updatedField)
        if (tableCollab?.isCollabRuntime) {
          await tableCollab.updateFieldForRuntime(editingField.id, {
            name: updatedField.name ?? payload.name,
            field_type: updatedField.field_type ?? payload.field_type,
            options: (updatedField.options ?? payload.options) as Record<string, unknown> | undefined,
            default_value: updatedField.default_value ?? payload.default_value ?? null,
          })
        }

        toast({
          title: t('field:fieldSettingPanel.updateSuccess', { defaultValue: '字段已更新' }),
        })
      } else {
        // ─── Add / Insert mode ───
        const insertRef =
          operator === 'insert' && referenceFieldId && insertPosition
            ? { referenceFieldId, position: insertPosition }
            : null

        const payload = buildPayload(null, insertRef)

        // 协作 createFieldForRuntime 只写 Y.Doc 元数据，接不住 validation_rules；
        // 有验证规则时必须走 REST，与编辑字段  同口径。
        const hasValidationRules =
          !!payload.validation_rules && Object.keys(payload.validation_rules).length > 0
        if (
          tableCollab?.isCollabRuntime &&
          !isStructuralFieldType(payload.field_type) &&
          !hasValidationRules
        ) {
          await tableCollab.createFieldForRuntime({
            name: payload.name,
            field_type: payload.field_type,
            description: payload.description,
            default_value: payload.default_value,
            options: payload.options as Record<string, unknown> | undefined,
            insert_position: payload.insert_position,
            reference_field_id: payload.reference_field_id,
          })
          skipRefresh = true
        } else {
          await FieldApiService.createField({
            table_id: selectedTable.id,
            name: payload.name,
            field_type: payload.field_type,
            default_value: payload.default_value,
            description: payload.description,
            options: payload.options as CoreFieldOptions,
            width: payload.width,
            validation_rules: payload.validation_rules,
            visibility_roles: payload.visibility_roles,
            ...(payload.insert_position ? { insert_position: payload.insert_position } : {}),
            ...(payload.reference_field_id ? { reference_field_id: payload.reference_field_id } : {}),
          })
        }

        toast({
          title: t('field:fieldSettingPanel.createSuccess', { defaultValue: '字段已创建' }),
        })
      }

      if (!skipRefresh) {
        await refreshFieldsAndView()
      }
      if (updatedFieldForLocalSync) {
        upsertFieldLocal(selectedTable.id, updatedFieldForLocalSync)
      }
      close()
    } catch (error: any) {
      const msg =
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        String(error)
      toast({
        title:
          operator === 'edit'
            ? t('field:fieldSettingPanel.updateFailed', { defaultValue: '更新字段失败' })
            : t('field:fieldSettingPanel.createFailed', { defaultValue: '创建字段失败' }),
        description: msg,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [
    validate,
    tableFields,
    fieldId,
    selectedTable?.id,
    operator,
    editingField,
    referenceFieldId,
    insertPosition,
    buildPayload,
    state.fieldType,
    startPreview,
    isStructuralFieldType,
    refreshFieldsAndView,
    close,
    tableCollab,
    upsertFieldLocal,
    t,
    conversionCheckError,
  ])

  // ── Panel title ──
  const panelTitle = useMemo(() => {
    switch (operator) {
      case 'edit':
        return t('field:fieldSettingPanel.titleEdit', { defaultValue: '编辑字段' })
      case 'insert':
        return t('field:fieldSettingPanel.titleInsert', { defaultValue: '插入字段' })
      default:
        return t('field:fieldSettingPanel.titleAdd', { defaultValue: '新建字段' })
    }
  }, [operator, t])

  const panelDescription = useMemo(() => {
    if (isPrimary) {
      return t('field:fieldSettingPanel.primaryFieldNote', {
        defaultValue: '主字段仅支持：文本、数字、单选、URL、邮箱、电话',
      })
    }
    if (operator === 'insert') {
      const pos = insertPosition === 'before' ? '左侧' : '右侧'
      return t('field:fieldSettingPanel.insertDescription', {
        defaultValue: `在参考字段${pos}插入新字段`,
        position: pos,
      })
    }
    return undefined
  }, [isPrimary, operator, insertPosition, t])

  const submitLabel = useMemo(() => {
    if (operator === 'edit') {
      return t('field:fieldSettingPanel.save', { defaultValue: '保存' })
    }
    return t('field:fieldSettingPanel.create', { defaultValue: '创建' })
  }, [operator, t])

  // ── Handle open change ──
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && isScopedOpen) {
        close()
      }
    },
    [close, isScopedOpen],
  )

  const handleInteractOutside = useCallback((event: Event) => {
    event.preventDefault()
  }, [])

  React.useEffect(() => {
    if (isScopedOpen) {
      announceTableDrawerOpen('field-settings', drawerId)
    }
  }, [drawerId, isScopedOpen])

  useCloseOnOtherTableDrawerOpen('field-settings', drawerId, isScopedOpen, close)

  return (
    <Sheet open={isScopedOpen} onOpenChange={handleOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        className="w-[420px] sm:max-w-[420px] flex flex-col p-0 shadow-2xl"
        onInteractOutside={handleInteractOutside}
        onPointerDownOutside={handleInteractOutside}
      >
        {/* ── Header ── */}
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3">
          <SheetTitle className="text-body">{panelTitle}</SheetTitle>
          <SheetDescription className={panelDescription ? 'text-body' : 'sr-only'}>
            {panelDescription || panelTitle}
          </SheetDescription>
        </SheetHeader>

        {/* ── Scrollable content ── */}
        <ScrollArea className="flex-1">
          <div className="px-4 py-4">
            <FieldConfigFormBody
              {...form}
              handleFieldTypeChange={onFieldTypeChange}
              mode={operator === 'edit' ? 'edit' : 'create'}
              currentTableId={selectedTable?.id ?? ''}
              editingFieldId={editingField?.id}
              isPrimary={isPrimary}
              originalFieldType={editingField?.field_type as FieldType | undefined}
              tableFields={tableFields}
              organizationMembers={defaultUserOptions}
              onLoadTables={onLoadTables}
              onLoadForeignMeta={onLoadForeignMeta}
              isTypeOptionDisabled={isTypeSwitchBlockedInEdit}
              fieldNameInputRef={fieldNameInputRef}
              afterTypeSelector={
                <>
                  {conversionCheckError && (
                    <p className="text-body text-destructive">{conversionCheckError}</p>
                  )}
                  {operator === 'edit' && (
                    <p className="text-body text-muted-foreground">
                      {t('field:fieldSettingPanel.typeSwitchBlockedTip', {
                        defaultValue: '编辑已有字段时，关联/查找引用需新建字段后迁移数据。',
                      })}
                    </p>
                  )}
                </>
              }
              renderChoicesEditor={(choices, onChange) => (
                <SelectChoicesEditor choices={choices} onChange={onChange} />
              )}
            />

          </div>
        </ScrollArea>

        {/* ── Footer ── */}
        <SheetFooter className="shrink-0 border-t border-border/40 px-4 py-3 sm:justify-end">
          <Button variant="outline" size="sm" onClick={close} disabled={isSubmitting}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={isSubmitting || conversionCheckPending}>
            {isSubmitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            {submitLabel}
          </Button>
        </SheetFooter>
      </SheetContent>

      <ConversionPreviewDialog
        open={conversionPreviewOpen}
        onOpenChange={(open) => {
          setConversionPreviewOpen(open)
          if (!open) setForceConversion(false)
        }}
        preview={conversionPreview}
        isLoading={conversionPreviewLoading}
        isConverting={conversionConverting}
        force={forceConversion}
        onForceChange={setForceConversion}
        onCancel={() => {
          cancelPreview()
          setForceConversion(false)
        }}
        onConfirm={() => void handleConversionConfirm()}
      />
    </Sheet>
  )
}

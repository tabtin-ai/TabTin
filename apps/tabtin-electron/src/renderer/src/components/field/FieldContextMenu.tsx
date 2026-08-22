/**
 * FieldContextMenu - 字段右键菜单组件
 * 使用通用 ContextMenu 组件
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ContextMenu,
  ContextMenuSection,
  ContextMenuDivider,
  ContextMenuItem,
  ContextMenuInput,
  ContextMenuTextarea,
  ContextMenuCheckbox,
  ContextMenuSubMenu,
  ContextMenuCustom,
  SelectChoicesEditor,
  normalizeSelectChoices,
  SELECT_CHOICE_PRESET_COLORS,
  type SelectChoiceOption,
  toast,
} from '@tabtin/smartsheet-ui'
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Settings,
  Trash2,
  Check,
  Pencil,
  ArrowUpAZ,
  ArrowDownAZ,
  Star,
} from 'lucide-react'
import type { Field, FieldType } from '@tabtin/table-core'
import { FieldApiService, isPrimaryFieldAllowedType } from '@tabtin/table-core'
import { FieldTypeIcon } from './FieldTypeIcon'
import { useTranslation } from 'react-i18next'
import { createLogger } from '@/utils/logger'
import { useTableStore } from '@stores/useTableStore'
import { useFieldSettingStore } from '@/stores/useFieldSettingStore'

const log = createLogger('FieldMenu')

/** 需要侧栏完整配置的字段类型：右键快捷创建不能直调 API */
const FIELD_TYPES_NEED_CONFIG_PANEL = new Set(['link'])

export interface FieldContextMenuProps {
  field: Field | null
  position: { x: number; y: number } | null
  onEdit: (field: Field, updates: Partial<Field>) => Promise<void>
  onDelete: (field: Field) => void
  onSort?: (direction: 'asc' | 'desc') => void
  onHide?: (field: Field) => void
  onShow?: (field: Field) => void
  onClose: () => void
  onFieldCreated?: () => void
  onFieldUpdated?: () => void  // 字段更新后的回调（包括类型转换）
}

// 与 FieldTypeSelector 共用同一组已支持字段类型。
const FIELD_TYPE_OPTIONS = [
  'text',
  'long_text',
  'number',
  'rating',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
  'checkbox',
  'user',
  'attachment',
  'link',
  'created_time',
  'last_modified_time',
  'created_by',
  'last_modified_by',
] as const

type MenuMode = 'main' | 'config' | 'create-before' | 'create-after'

export const FieldContextMenu: React.FC<FieldContextMenuProps> = ({
  field,
  position,
  onEdit,
  onDelete,
  onSort,
  onHide,
  onShow,
  onClose,
  onFieldCreated,
  onFieldUpdated,
}) => {
  const { t } = useTranslation(['field', 'common'])
  const [menuMode, setMenuMode] = useState<MenuMode>('main')
  const [editingName, setEditingName] = useState('')
  const [editingDescription, setEditingDescription] = useState('')
  const [editingChoices, setEditingChoices] = useState<SelectChoiceOption[]>([])

  const [newFieldType, setNewFieldType] = useState<string>('text')
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldDescription, setNewFieldDescription] = useState('')
  const [newFieldChoices, setNewFieldChoices] = useState<SelectChoiceOption[]>([
    { value: '', label: '', color: SELECT_CHOICE_PRESET_COLORS[0] },
  ])

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const selectedTable = useTableStore((state) => state.selectedTable)
  const getTable = useTableStore((state) => state.getTable)

  useEffect(() => {
    if (field) {
      setEditingName(field.name)
      setEditingDescription(field.description || '')
      setEditingChoices(normalizeSelectChoices(field.options?.choices || []))
    }
  }, [field])

  useEffect(() => {
    if (!position) {
      setMenuMode('main')
    }
  }, [position])

  const handleResetCreateState = useCallback((mode: MenuMode) => {
    setMenuMode(mode)
    setNewFieldName('')
    setNewFieldDescription('')
    setNewFieldChoices([{ value: '', label: '', color: SELECT_CHOICE_PRESET_COLORS[0] }])
    setNewFieldType('text')
    setCreateError(null)
  }, [])

  const handleCloseMenu = useCallback(() => {
    setMenuMode('main')
    setConfigError(null)
    setCreateError(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (menuMode === 'config') {
      setConfigError(null)
    } else if (menuMode === 'create-before' || menuMode === 'create-after') {
      setCreateError(null)
    }
  }, [menuMode])

  // 如果没有 field 或 position，不渲染菜单（但不 early return，让 ContextMenu 自己控制）
  const isSelectField = field?.field_type === 'select' || field?.field_type === 'multi_select'
  const isNewSelectField = newFieldType === 'select' || newFieldType === 'multi_select'

  const handleSaveName = async () => {
    if (!field || !editingName.trim() || editingName === field.name || isSubmitting) return
    setIsSubmitting(true)
    try {
      await onEdit(field, { name: editingName.trim() })
      setConfigError(null)
    } catch (error) {
      log.error(error)
      setConfigError(error instanceof Error ? error.message : t('field:contextMenu.errors.nameUpdateFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSaveDescription = async () => {
    if (!field || editingDescription === (field.description || '') || isSubmitting) return
    setIsSubmitting(true)
    try {
      await onEdit(field, {
        description: editingDescription.trim() || undefined,
      })
      setConfigError(null)
    } catch (error) {
      log.error(error)
      setConfigError(error instanceof Error ? error.message : t('field:contextMenu.errors.descriptionUpdateFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSaveChoices = async () => {
    if (!field) return

    log.debug('Current state:', {
      editingChoices,
      fieldChoices: field.options?.choices,
    })

    const validChoices = editingChoices
      .map((choice) => ({ ...choice, value: choice.value.trim(), label: choice.label.trim() }))
      .filter((choice) => choice.value)

    log.debug('Valid choices:', validChoices)

    if (
      JSON.stringify(validChoices) === JSON.stringify(normalizeSelectChoices(field.options?.choices || [])) ||
      isSubmitting
    ) {
      log.debug('No changes or already submitting, skipping')
      return
    }

    setIsSubmitting(true)

    const updates = {
      options: { ...field.options, choices: validChoices },
    }

    log.debug('Sending update:', updates)

    try {
      await onEdit(field, updates)
      setConfigError(null)
      log.info('Save successful')
    } catch (error) {
      log.error('Error:', error)
      setConfigError(error instanceof Error ? error.message : t('field:contextMenu.errors.optionsUpdateFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleChangeType = async (targetType: string) => {
    if (!field || targetType === field.field_type || isSubmitting) return

    if (FIELD_TYPES_NEED_CONFIG_PANEL.has(targetType)) {
      toast({
        title: t('field:contextMenu.structuralConvertBlockedTitle', {
          defaultValue: '请新建关联字段',
        }),
        description: t('field:contextMenu.structuralConvertBlockedDesc', {
          defaultValue: '关联字段和查找引用字段需要新建后迁移数据，不支持通过类型转换直接修改。',
        }),
      })
      return
    }

    log.debug('Converting field type:', {
      fieldName: field.name,
      from: field.field_type,
      to: targetType,
    })

    setIsSubmitting(true)
    try {
      // 注：FieldApiService.convertField 走 HTTP（不是 IPC）；返 Django 响应
      // `{success?, error?, forced_null_count?}`。contract W2-β 同步迁离字面
      // result.success 形态——legacy fail 路径主动转 throw 走外层 catch。
      const convertRes = await FieldApiService.convertField(field.id, {
        target_type: targetType as any,
        force: false,
        async_mode: false,
      })

      log.debug('Conversion result:', convertRes)

      if (convertRes.success === false) {
        // 业务 fail 路径：保留原 setConfigError 语义（不 throw 因为 caller 用 inline error 显示）
        setConfigError(convertRes.error || t('field:contextMenu.errors.typeConvertFailed'))
      } else {
        const forcedNullCount = convertRes.forced_null_count ?? 0
        if (forcedNullCount > 0) {
          setConfigError(
            `${t('field:contextMenu.convert.failedCount', { count: forcedNullCount })}\n${t(
              'field:contextMenu.convert.moreRecords',
              { count: forcedNullCount },
            )}`,
          )
        } else {
          setConfigError(null)
        }
        await onFieldUpdated?.()

        handleCloseMenu()
      }
    } catch (error) {
      log.error(error)
      setConfigError(error instanceof Error ? error.message : t('field:contextMenu.errors.typeConvertFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = () => {
    if (!field) return
    onDelete(field)
    handleCloseMenu()
  }

  const handleHide = () => {
    if (!field) return
    onHide?.(field)
    handleCloseMenu()
  }

  const handleShow = () => {
    if (!field) return
    onShow?.(field)
    handleCloseMenu()
  }

  const handleSetPrimaryField = async () => {
    if (!field || field.is_primary || !isPrimaryFieldAllowedType(field.field_type) || isSubmitting) return

    setIsSubmitting(true)
    try {
      let schemaVersion =
        selectedTable?.id === field.table_id && typeof selectedTable.schema_version === 'number'
          ? selectedTable.schema_version
          : undefined
      await FieldApiService.setPrimaryField(field.id, {
        getExpectedSchemaVersion: () => schemaVersion,
        refreshSchemaVersion: async () => {
          const table = await getTable(field.table_id)
          if (typeof table?.schema_version === 'number') {
            schemaVersion = table.schema_version
          }
        },
      })
      await getTable(field.table_id)
      await onFieldUpdated?.()
      toast({
        title: t('field:actions.setPrimarySuccess'),
      })
      handleCloseMenu()
    } catch (error) {
      log.error(error)
      toast({
        title: t('field:errors.setPrimaryFailedTitle'),
        description: error instanceof Error ? error.message : t('field:errors.setPrimaryFailedDesc'),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const isSystemReadOnlyField =
    newFieldType === 'created_time' ||
    newFieldType === 'last_modified_time' ||
    newFieldType === 'created_by' ||
    newFieldType === 'last_modified_by'

  const handleCreateField = async () => {
    if (!field || !newFieldName.trim() || isSubmitting) return

    const isSelect = newFieldType === 'select' || newFieldType === 'multi_select'
    const validChoices = isSelect
      ? newFieldChoices
          .map((choice) => ({ ...choice, value: choice.value.trim(), label: choice.label.trim() }))
          .filter((choice) => choice.value)
      : []

    if (isSelect && validChoices.length === 0) {
      setCreateError(t('field:contextMenu.errors.selectRequiresOption'))
      return
    }

    // link 必须走侧栏配置（目标表、双向等），不能无 options 直建
    if (FIELD_TYPES_NEED_CONFIG_PANEL.has(newFieldType)) {
      useFieldSettingStore.getState().openForInsert(
        field.id,
        menuMode === 'create-before' ? 'before' : 'after',
        field.table_id,
        null,
        {
          fieldType: newFieldType,
          fieldName: newFieldName.trim(),
        },
      )
      setCreateError(null)
      handleCloseMenu()
      return
    }

    setIsSubmitting(true)
    try {
      await FieldApiService.createField({
        table_id: field.table_id,
        name: newFieldName.trim(),
        field_type: newFieldType as FieldType,
        description: newFieldDescription.trim() || undefined,
        options: isSelect ? { choices: validChoices } : undefined,
        insert_position: menuMode === 'create-before' ? 'before' : 'after',
        reference_field_id: field.id,
      })
      setCreateError(null)
      onFieldCreated?.()
      handleCloseMenu()
    } catch (error) {
      log.error(error)
      setCreateError(error instanceof Error ? error.message : t('field:contextMenu.errors.createFieldFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const renderTypeSubMenu = (currentType: string, onSelect: (value: string) => void, disabled?: boolean) => {
    if (!field) return null

    return (
    <ContextMenuSubMenu
      label={t('field:contextMenu.typeLabel')}
      icon={<FieldTypeIcon type={currentType} size={20} />}
      suffix={<span className="text-body text-muted-foreground">{t(`field:types.${currentType}`, { defaultValue: currentType })}</span>}
      disabled={disabled}
    >
      {FIELD_TYPE_OPTIONS.map((option) => {
        // 仅编辑现有主字段时限制类型；插入新字段不能借用参考列的 is_primary
        const typeBlockedForPrimary =
          menuMode === 'config' &&
          field.is_primary &&
          option !== currentType &&
          !isPrimaryFieldAllowedType(option)
        return (
          <ContextMenuItem
            key={option}
            icon={<FieldTypeIcon type={option} size={20} />}
            label={t(`field:types.${option}`, { defaultValue: option })}
            selected={option === currentType}
            disabled={Boolean(disabled || typeBlockedForPrimary)}
            onClick={() => {
              log.debug('Type option clicked:', option)
              onSelect(option)
            }}
          />
        )
      })}
    </ContextMenuSubMenu>
    )
  }

  const renderMainMenu = () => (
    <>
      <ContextMenuInput
        key={field?.id}
        icon={<Pencil className="h-4 w-4" />}
        placeholder={t('field:contextMenu.fieldNamePlaceholder')}
        defaultValue={editingName}
        onSubmit={handleSaveName}
        onBlur={handleSaveName}
        onChange={(value) => setEditingName(value)}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<ArrowUpAZ className="h-4 w-4"  />}
        label={t('field:contextMenu.sortAsc')}
        onClick={() => {
          onSort?.('asc')
          handleCloseMenu()
        }}
      />
      <ContextMenuItem
        icon={<ArrowDownAZ className="h-4 w-4"  />}
        label={t('field:contextMenu.sortDesc')}
        onClick={() => {
          onSort?.('desc')
          handleCloseMenu()
        }}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<ChevronLeft className="h-4 w-4"  />}
        label={t('field:contextMenu.insertLeft')}
        closeOnClick={false}
        onClick={() => handleResetCreateState('create-before')}
      />
      <ContextMenuItem
        icon={<ChevronRight className="h-4 w-4"  />}
        label={t('field:contextMenu.insertRight')}
        closeOnClick={false}
        onClick={() => handleResetCreateState('create-after')}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<Settings className="h-4 w-4"  />}
        label={t('field:contextMenu.editConfig')}
        suffix={<ChevronRight className="h-3.5 w-3.5"  />}
        closeOnClick={false}
        onClick={() => setMenuMode('config')}
      />
      {field?.is_primary ? (
        <ContextMenuItem
          icon={<Star className="h-4 w-4" />}
          label={t('field:contextMenu.primaryField')}
          disabled
        />
      ) : field && isPrimaryFieldAllowedType(field.field_type) ? (
        <ContextMenuItem
          icon={<Star className="h-4 w-4" />}
          label={t('field:contextMenu.setPrimaryField')}
          disabled={isSubmitting}
          onClick={handleSetPrimaryField}
        />
      ) : null}
      {onHide && (
        <ContextMenuItem
          icon={<EyeOff className="h-4 w-4"  />}
          label={t('field:contextMenu.hide')}
          onClick={handleHide}
        />
      )}
      {onShow && (
        <ContextMenuItem
          icon={<Eye className="h-4 w-4"  />}
          label={t('field:contextMenu.show')}
          onClick={handleShow}
        />
      )}
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<Trash2 className="h-4 w-4"  />}
        label={t('field:contextMenu.delete')}
        danger
        disabled={field?.is_primary ?? false}
        onClick={handleDelete}
      />
    </>
  )

  const renderConfigMenu = () => {
    if (!field) return null

    return (
    <>
      {configError && (
        <div className="px-1 text-body text-destructive whitespace-pre-line mb-2">
          {configError}
        </div>
      )}
      {renderTypeSubMenu(field.field_type, handleChangeType, isSubmitting)}
      {isSelectField && (
        <>
          <ContextMenuDivider />
          <ContextMenuCustom>
            <div className="text-body font-medium text-muted-foreground px-1 mb-2">{t('field:contextMenu.optionsContent')}</div>
            <SelectChoicesEditor
              choices={editingChoices}
              onChange={setEditingChoices}
            />
          </ContextMenuCustom>
          <ContextMenuItem
            icon={<Check className="h-4 w-4"  />}
            label={t('field:contextMenu.saveOptions')}
            onClick={handleSaveChoices}
          />
        </>
      )}
      <ContextMenuDivider />
      <ContextMenuTextarea
        placeholder={t('field:contextMenu.descriptionPlaceholder')}
        defaultValue={editingDescription}
        rows={3}
        onBlur={(value) => {
          setEditingDescription(value)
          handleSaveDescription()
        }}
         onChange={(value) => setEditingDescription(value)}
       />
     </>
    )
  }

  const renderCreateMenu = (placement: 'before' | 'after') => (
    <>
      {createError && (
        <div className="px-1 text-body text-destructive whitespace-pre-line mb-2">
          {createError}
        </div>
      )}
      <ContextMenuInput
        icon={<Plus className="h-4 w-4"  />}
        placeholder={t('field:contextMenu.createFieldPlaceholder')}
        defaultValue={newFieldName}
        autoFocus
        onChange={(value) => setNewFieldName(value)}
      />
      <ContextMenuDivider />
      {renderTypeSubMenu(newFieldType, (value) => {
        setNewFieldType(value)
        if (value === 'select' || value === 'multi_select') {
          setNewFieldChoices((prev) => (
            prev.length === 0
              ? [{ value: '', label: '', color: SELECT_CHOICE_PRESET_COLORS[0] }]
              : prev
          ))
        }
      })}
      {isNewSelectField && (
        <>
          <ContextMenuDivider />
          <ContextMenuCustom>
            <div className="text-body font-medium text-muted-foreground px-1 mb-2">{t('field:contextMenu.optionsContent')}</div>
            <SelectChoicesEditor
              choices={newFieldChoices}
              onChange={setNewFieldChoices}
            />
          </ContextMenuCustom>
        </>
      )}
      <ContextMenuDivider />
      <ContextMenuTextarea
        placeholder={t('field:contextMenu.descriptionPlaceholderOptional')}
        defaultValue={newFieldDescription}
        rows={2}
        onChange={(value) => setNewFieldDescription(value)}
      />
      <ContextMenuDivider />
      <ContextMenuItem
        icon={<Plus className="h-4 w-4"  />}
        label={t('field:contextMenu.createField')}
        disabled={!newFieldName.trim() || (isNewSelectField && newFieldChoices.filter((choice) => choice.value.trim()).length === 0)}
        onClick={handleCreateField}
      />
    </>
  )

  // 根据菜单模式构建标题
  const getHeader = () => {
    if (!field) return undefined

    // 主菜单：不显示 header，输入框即标题
    if (menuMode === 'main') {
      return undefined
    }

    // 编辑配置子菜单
    if (menuMode === 'config') {
      return {
        title: t('field:contextMenu.editFieldConfig'),
        icon: <Settings className="h-4 w-4" />,
        onBack: () => setMenuMode('main'),
      }
    }

    // 插入字段子菜单
    if (menuMode === 'create-before' || menuMode === 'create-after') {
      return {
        title: menuMode === 'create-before'
          ? t('field:contextMenu.insertLeft')
          : t('field:contextMenu.insertRight'),
        icon: <Plus className="h-4 w-4" />,
        onBack: () => setMenuMode('main'),
      }
    }

    return undefined
  }

  const isOpen = Boolean(field && position)

  return (
    <ContextMenu
      open={isOpen}
      onClose={handleCloseMenu}
      anchorPosition={position || undefined}
      header={getHeader()}
    >
      {menuMode === 'main' && renderMainMenu()}
      {menuMode === 'config' && renderConfigMenu()}
      {menuMode === 'create-before' && renderCreateMenu('before')}
      {menuMode === 'create-after' && renderCreateMenu('after')}
    </ContextMenu>
  )
}

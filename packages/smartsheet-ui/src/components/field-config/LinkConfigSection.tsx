/**
 * LinkConfigSection - 关联字段配置区域（平台无关）
 *
 * 从 Electron 版本重构：将 useSpaceStore / TableApiService / FieldApiService
 * 等平台依赖替换为 props + 回调注入，使组件可同时用于 Electron 和 Web。
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { Label } from '../label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select'
import { Switch } from '../switch'
import { Button } from '../button'
import { Separator } from '../separator'
import { Checkbox } from '../checkbox'
import { ConfirmDialog } from '../confirm-dialog'
import { ScrollArea } from '../scroll-area'
import { cn } from '../../utils/cn'
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LinkRelationship, LookupFilterConfig } from '../../hooks/useFieldConfigForm'

export interface LinkableFieldItem {
  id: string
  name: string
  field_type: string
  is_primary: boolean
}

export interface LinkTableOption {
  id: string
  name: string
  /** 当前用户对目标表的角色；用于对称字段创建权限门禁 */
  currentUserRole?: string | null
}

const SYMMETRIC_EDIT_ROLES = new Set(['owner', 'admin', 'editor'])

export interface LinkForeignMeta {
  fields: LinkableFieldItem[]
  views: Array<{ id: string; name: string }>
}

export interface LinkConfigSectionProps {
  foreignTableId: string
  relationship: LinkRelationship
  isOneWay: boolean
  lookupFieldId: string
  filterByViewId: string
  filter: LookupFilterConfig | null
  visibleFieldIds: string[]
  onForeignTableChange: (id: string) => void
  onRelationshipChange: (rel: LinkRelationship) => void
  onIsOneWayChange: (v: boolean) => void
  onLookupFieldIdChange: (id: string) => void
  onFilterByViewIdChange: (id: string) => void
  onFilterChange: (filter: LookupFilterConfig | null) => void
  onVisibleFieldIdsChange: (ids: string[]) => void
  currentTableId: string
  fieldId?: string
  error?: string

  /** 可选的目标表列表（由宿主提供）。若不传则需 onLoadTables 动态加载 */
  tables?: LinkTableOption[]
  /** 动态加载表列表的回调 */
  onLoadTables?: () => Promise<LinkTableOption[]>
  /** 动态加载目标表元数据（字段+视图）的回调 */
  onLoadForeignMeta?: (tableId: string, fieldId?: string) => Promise<LinkForeignMeta>
}

// ── Relationship helpers ──

const PRIMARY_FIELD_VALUE = '__primary__'

const isLeftMulti = (rel: LinkRelationship) => rel === 'ManyMany' || rel === 'OneMany'
const isRightMulti = (rel: LinkRelationship) => rel === 'ManyMany' || rel === 'ManyOne'

const deriveRelationship = (leftMulti: boolean, rightMulti: boolean): LinkRelationship => {
  if (leftMulti && rightMulti) return 'ManyMany'
  if (leftMulti && !rightMulti) return 'OneMany'
  if (!leftMulti && rightMulti) return 'ManyOne'
  return 'OneOne'
}

const RELATIONSHIP_DESCRIPTIONS: Record<LinkRelationship, { zhCN: string; enUS: string }> = {
  ManyMany: {
    zhCN: '当前表的一条记录可以关联目标表的多条记录，反之亦然。',
    enUS: 'A record in this table can link to many records in the target table, and vice versa.',
  },
  OneMany: {
    zhCN: '当前表的一条记录可以关联目标表的多条记录，但目标表的每条记录只能被关联一次。',
    enUS: 'A record in this table can link to many records in the target table, but each target record can only be linked once.',
  },
  ManyOne: {
    zhCN: '当前表的多条记录可以关联目标表的同一条记录，但每条源记录只能关联一条。',
    enUS: 'Many records in this table can link to the same target record, but each source record can only link to one.',
  },
  OneOne: {
    zhCN: '当前表的一条记录只能关联目标表的一条记录，一一对应。',
    enUS: 'A record in this table can only link to one record in the target table, one-to-one.',
  },
}

export const LinkConfigSection: React.FC<LinkConfigSectionProps> = ({
  foreignTableId,
  relationship,
  isOneWay,
  lookupFieldId,
  filterByViewId,
  filter,
  visibleFieldIds,
  onForeignTableChange,
  onRelationshipChange,
  onIsOneWayChange,
  onLookupFieldIdChange,
  onFilterByViewIdChange,
  onFilterChange,
  onVisibleFieldIdsChange,
  currentTableId,
  fieldId,
  error,
  tables: externalTables,
  onLoadTables,
  onLoadForeignMeta,
}) => {
  const { t, i18n } = useTranslation('field')
  const [internalTables, setInternalTables] = useState<LinkTableOption[]>([])
  const tables = externalTables ?? internalTables
  const [loading, setLoading] = useState(false)
  const [originalForeignTableId] = useState(foreignTableId)
  const isTableChanged = fieldId && foreignTableId && originalForeignTableId && foreignTableId !== originalForeignTableId

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [foreignFields, setForeignFields] = useState<LinkableFieldItem[]>([])
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [showTableChangeConfirm, setShowTableChangeConfirm] = useState(false)
  const [pendingForeignTableId, setPendingForeignTableId] = useState<string | null>(null)
  const [showOneWayConfirm, setShowOneWayConfirm] = useState(false)

  const relationshipLabel = useMemo(() => {
    const labels: Record<LinkRelationship, string> = {
      ManyMany: t('fieldSettingPanel.link.manyMany', { defaultValue: 'Many-to-many' }),
      OneMany: t('fieldSettingPanel.link.oneMany', { defaultValue: 'One-to-many' }),
      ManyOne: t('fieldSettingPanel.link.manyOne', { defaultValue: 'Many-to-one' }),
      OneOne: t('fieldSettingPanel.link.oneOne', { defaultValue: 'One-to-one' }),
    }
    return labels[relationship]
  }, [relationship, t])

  const relationshipDescription = useMemo(() => {
    const desc = RELATIONSHIP_DESCRIPTIONS[relationship]
    return i18n.language?.startsWith('zh') ? desc.zhCN : desc.enUS
  }, [relationship, i18n.language])

  const selectedForeignTable = useMemo(
    () => tables.find((table) => table.id === foreignTableId) ?? null,
    [tables, foreignTableId],
  )

  // 目标表有明确角色且低于 editor 时禁用双向；角色未知时不前端拦截（后端仍会校验）
  const canCreateSymmetric = useMemo(() => {
    if (!foreignTableId || !selectedForeignTable) return true
    const role = selectedForeignTable.currentUserRole
    if (role == null || role === '') return true
    return SYMMETRIC_EDIT_ROLES.has(role)
  }, [foreignTableId, selectedForeignTable])

  // 无对称创建权限时强制单向，避免 UI 显示双向但落库被静默降级
  useEffect(() => {
    if (!foreignTableId || canCreateSymmetric || isOneWay) return
    onIsOneWayChange(true)
  }, [foreignTableId, canCreateSymmetric, isOneWay, onIsOneWayChange])

  // 加载表列表
  useEffect(() => {
    if (externalTables || !onLoadTables) return
    let cancelled = false
    setLoading(true)
    onLoadTables()
      .then((result) => {
        if (!cancelled) setInternalTables(result)
      })
      .catch(() => {
        if (!cancelled) setInternalTables([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [externalTables, onLoadTables])

  // 选中关联表后立刻预加载字段（不依赖是否展开高级设置）
  useEffect(() => {
    if (!foreignTableId || !onLoadForeignMeta) {
      setForeignFields([])
      setMetaError(null)
      setLoadingMeta(false)
      return
    }

    let cancelled = false
    setForeignFields([])
    setMetaError(null)
    setLoadingMeta(true)

    void onLoadForeignMeta(foreignTableId, fieldId)
      .then((meta) => {
        if (cancelled) return
        setForeignFields(Array.isArray(meta?.fields) ? meta.fields : [])
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setForeignFields([])
        setMetaError(
          err instanceof Error && err.message.trim()
            ? err.message
            : 'Failed to load linked table fields',
        )
      })
      .finally(() => {
        if (!cancelled) setLoadingMeta(false)
      })

    return () => {
      cancelled = true
    }
  }, [foreignTableId, fieldId, onLoadForeignMeta])

  const retryLoadForeignMeta = useCallback(() => {
    if (!foreignTableId || !onLoadForeignMeta) return
    setMetaError(null)
    setLoadingMeta(true)
    void onLoadForeignMeta(foreignTableId, fieldId)
      .then((meta) => {
        setForeignFields(Array.isArray(meta?.fields) ? meta.fields : [])
      })
      .catch((err: unknown) => {
        setForeignFields([])
        setMetaError(
          err instanceof Error && err.message.trim()
            ? err.message
            : 'Failed to load linked table fields',
        )
      })
      .finally(() => setLoadingMeta(false))
  }, [foreignTableId, fieldId, onLoadForeignMeta])

  useEffect(() => {
    if (lookupFieldId || filterByViewId || visibleFieldIds.length > 0 || (filter && filter.filterSet.length > 0)) {
      setShowAdvanced(true)
    }
  }, [lookupFieldId, filterByViewId, visibleFieldIds, filter])

  const toggleVisibleField = (fid: string) => {
    const current = new Set(visibleFieldIds)
    if (current.has(fid)) current.delete(fid)
    else current.add(fid)
    onVisibleFieldIdsChange(Array.from(current))
  }

  const applyForeignTableSelectionChange = useCallback(
    (nextTableId: string) => {
      onForeignTableChange(nextTableId)
      onLookupFieldIdChange('')
      onFilterByViewIdChange('')
      onVisibleFieldIdsChange([])
      onFilterChange(null)
    },
    [onForeignTableChange, onLookupFieldIdChange, onFilterByViewIdChange, onVisibleFieldIdsChange, onFilterChange],
  )

  const handleForeignTableSelectionChange = useCallback(
    (nextTableId: string) => {
      if (!nextTableId || nextTableId === foreignTableId) return
      if (fieldId && foreignTableId && nextTableId !== foreignTableId) {
        setPendingForeignTableId(nextTableId)
        setShowTableChangeConfirm(true)
        return
      }
      applyForeignTableSelectionChange(nextTableId)
    },
    [fieldId, foreignTableId, applyForeignTableSelectionChange],
  )

  const currentForeignTableName = useMemo(() =>
    tables.find((table) => table.id === foreignTableId)?.name ?? '',
  [tables, foreignTableId])

  const pendingForeignTableName = useMemo(() =>
    pendingForeignTableId ? tables.find((table) => table.id === pendingForeignTableId)?.name ?? '' : '',
  [tables, pendingForeignTableId])

  return (
    <>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label>{t('fieldSettingPanel.link.foreignTable', { defaultValue: 'Linked table' })}</Label>
          <Select value={foreignTableId} onValueChange={handleForeignTableSelectionChange} disabled={loading}>
            <SelectTrigger className={cn(error && 'border-destructive')}>
              <SelectValue
                placeholder={
                  loading
                    ? t('fieldSettingPanel.link.loading', { defaultValue: 'Loading...' })
                    : t('fieldSettingPanel.link.selectTable', { defaultValue: 'Select table' })
                }
              />
            </SelectTrigger>
            <SelectContent>
              {tables.map((table) => (
                <SelectItem key={table.id} value={table.id}>
                  {table.name}
                  {table.id === currentTableId && (
                    <span className="ml-1 text-body text-muted-foreground">
                      ({t('fieldSettingPanel.link.selfTable', { defaultValue: 'This table' })})
                    </span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p className="text-body text-destructive">{error}</p>}
          {isTableChanged && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-body text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {t('fieldSettingPanel.link.tableChangeWarning', {
                  defaultValue: 'Changing the linked table will clear all existing link data for this field. This action cannot be undone.',
                })}
              </span>
            </div>
          )}
        </div>

        {foreignTableId && (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <div className="flex h-8 items-center space-x-2">
                  <Switch
                    id="link-create-symmetric"
                    checked={!isOneWay}
                    disabled={!canCreateSymmetric}
                    onCheckedChange={(checked) => {
                      if (!canCreateSymmetric) return
                      if (!checked && fieldId && !isOneWay) setShowOneWayConfirm(true)
                      else onIsOneWayChange(!checked)
                    }}
                  />
                  <Label
                    htmlFor="link-create-symmetric"
                    className={cn(
                      'font-normal leading-tight',
                      !canCreateSymmetric && 'text-muted-foreground',
                    )}
                  >
                    {t('fieldSettingPanel.link.createSymmetricLink', { defaultValue: 'Create symmetric link' })}
                  </Label>
                </div>
                {!canCreateSymmetric && (
                  <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {t('fieldSettingPanel.link.symmetricPermissionDenied', {
                        defaultValue: '你对目标表没有编辑权限，无法创建对称关联字段，将仅创建单向关联。',
                      })}
                    </span>
                  </p>
                )}
              </div>

              <div className="flex h-8 items-center space-x-2">
                <Switch
                  id="link-self-multi"
                  checked={isLeftMulti(relationship)}
                  onCheckedChange={(checked) =>
                    onRelationshipChange(deriveRelationship(checked, isRightMulti(relationship)))
                  }
                />
                <Label htmlFor="link-self-multi" className="font-normal leading-tight">
                  {t('fieldSettingPanel.link.allowLinkMultiple', { defaultValue: 'Allow linking to multiple records' })}
                </Label>
              </div>

              <div className="flex h-8 items-center space-x-2">
                <Switch
                  id="link-sym-multi"
                  checked={isRightMulti(relationship)}
                  onCheckedChange={(checked) =>
                    onRelationshipChange(deriveRelationship(isLeftMulti(relationship), checked))
                  }
                />
                <Label htmlFor="link-sym-multi" className="font-normal leading-tight">
                  {isOneWay
                    ? t('fieldSettingPanel.link.allowLinkDuplicate', { defaultValue: 'Allow linking to duplicate records' })
                    : t('fieldSettingPanel.link.allowSymmetricMultiple', { defaultValue: 'Allow symmetric field to link multiple records' })}
                </Label>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 rounded-md border bg-secondary/50 p-3 text-body">
              <div className="flex items-center gap-1.5 font-medium">
                <Info className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{relationshipLabel}</span>
              </div>
              <p className="text-body text-muted-foreground leading-relaxed">{relationshipDescription}</p>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-1 px-0 text-body font-medium text-muted-foreground"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {t('fieldSettingPanel.link.advancedSettings', { defaultValue: '关联表高级设置' })}
            </Button>

            {showAdvanced && (
              <div className="space-y-4 pl-1">
                {metaError && (
                  <div className="flex items-start justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
                    <p className="text-body text-destructive">{metaError}</p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-1.5 text-body"
                      onClick={retryLoadForeignMeta}
                      disabled={loadingMeta}
                    >
                      {t('fieldSettingPanel.link.retryLoadMeta', { defaultValue: 'Retry' })}
                    </Button>
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-body">
                    {t('fieldSettingPanel.link.showByField', { defaultValue: 'Show by field' })}
                  </Label>
                  <Select
                    value={lookupFieldId || PRIMARY_FIELD_VALUE}
                    onValueChange={(v) => onLookupFieldIdChange(v === PRIMARY_FIELD_VALUE ? '' : v)}
                    disabled={loadingMeta || Boolean(metaError)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={
                        loadingMeta
                          ? t('fieldSettingPanel.link.loadingFields', { defaultValue: 'Loading...' })
                          : t('fieldSettingPanel.link.primaryFieldDefault', { defaultValue: 'Primary field (default)' })
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={PRIMARY_FIELD_VALUE}>
                        {t('fieldSettingPanel.link.primaryFieldDefault', { defaultValue: 'Primary field (default)' })}
                      </SelectItem>
                      {foreignFields.filter((f) => !f.is_primary).map((f) => (
                        <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-body text-muted-foreground">
                    {t('fieldSettingPanel.link.showByFieldHint', { defaultValue: 'Choose which field from the linked table to display as the record title' })}
                  </p>
                </div>

                {/* 「按视图过滤」「自定义过滤条件」暂隐藏：当前不可用/有问题，待修好后再放开 */}

                <div className="space-y-2">
                  <Label className="text-body">
                    {t('fieldSettingPanel.link.visibleFields', { defaultValue: 'Editor display fields' })}
                  </Label>
                  {loadingMeta ? (
                    <p className="text-body text-muted-foreground">{t('fieldSettingPanel.link.loadingFields', { defaultValue: 'Loading...' })}</p>
                  ) : !foreignTableId ? (
                    <p className="text-body text-muted-foreground">
                      {t('fieldSettingPanel.link.noFieldsYet', { defaultValue: 'Select a linked table first' })}
                    </p>
                  ) : metaError ? (
                    <p className="text-body text-muted-foreground">
                      {t('fieldSettingPanel.link.loadMetaFailedHint', {
                        defaultValue: 'Linked table fields are unavailable. Retry after the error is resolved.',
                      })}
                    </p>
                  ) : foreignFields.length === 0 ? (
                    <p className="text-body text-muted-foreground">
                      {t('fieldSettingPanel.link.noForeignFields', {
                        defaultValue: 'No fields found in the linked table',
                      })}
                    </p>
                  ) : (
                    <ScrollArea className="max-h-[200px] rounded-md border">
                      <div className="space-y-1 p-2">
                        {foreignFields.map((ff) => (
                          <label key={ff.id} className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-body hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08] cursor-pointer">
                            <Checkbox checked={visibleFieldIds.includes(ff.id)} onCheckedChange={() => toggleVisibleField(ff.id)} />
                            <span className="truncate">
                              {ff.name}
                              {ff.is_primary && <span className="ml-1 text-body text-muted-foreground">(primary)</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={showTableChangeConfirm}
        onOpenChange={(open) => { setShowTableChangeConfirm(open); if (!open) setPendingForeignTableId(null) }}
        title={t('fieldSettingPanel.link.tableChangeConfirmTitle', { defaultValue: '确认切换关联表' })}
        description={t('fieldSettingPanel.link.tableChangeConfirmDescription', {
          from: currentForeignTableName || '当前表',
          to: pendingForeignTableName || '目标表',
          defaultValue: '将关联表从"{{from}}"切换到"{{to}}"后，系统会清空该字段的关联数据与高级配置。此操作不可撤销。',
        })}
        confirmText={t('fieldSettingPanel.link.tableChangeConfirmAction', { defaultValue: '继续切换' })}
        cancelText={t('common:cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={() => { if (pendingForeignTableId) applyForeignTableSelectionChange(pendingForeignTableId); setPendingForeignTableId(null) }}
      />

      <ConfirmDialog
        open={showOneWayConfirm}
        onOpenChange={setShowOneWayConfirm}
        title={t('fieldSettingPanel.link.oneWayConfirmTitle', { defaultValue: '确认关闭对称关联' })}
        description={t('fieldSettingPanel.link.oneWayConfirmDescription', {
          defaultValue: '关闭对称关联后，保存时将删除目标表中的对称字段及其数据。此操作不可撤销。',
        })}
        confirmText={t('fieldSettingPanel.link.oneWayConfirmAction', { defaultValue: '继续关闭' })}
        cancelText={t('common:cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={() => onIsOneWayChange(true)}
      />
    </>
  )
}

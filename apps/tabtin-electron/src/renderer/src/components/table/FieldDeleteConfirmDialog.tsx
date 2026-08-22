import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  PanelLoadingState,
  ScrollArea,
  Separator,
  StatusNotice,
} from '@tabtin/smartsheet-ui'
import { restoreTableGridFocus } from '@tabtin/table-ui'
import {
  AlertTriangle,
  Link2,
  Eye,
  Columns3,
  Undo2,
  History,
  Info,
} from 'lucide-react'
import type {
  DependentFieldInfo,
  FieldExplainResponse,
  FieldUndoCapability,
  FieldUndoReasonCode,
} from '@tabtin/table-core'
import { FieldApiService } from '@tabtin/table-core'
import { useTranslation } from 'react-i18next'

interface FieldDeleteConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fieldId: string
  fieldName: string
  fieldType: string
  isPrimary?: boolean
  onConfirm: () => void | Promise<void>
  /** C1 / W1.4:用户点「查看版本历史」时的回调,由 caller(DataGrid)注入 */
  onOpenVersionHistory?: () => void
}

function groupDependentFields(fields: DependentFieldInfo[]) {
  const groups: Record<string, DependentFieldInfo[]> = {}
  for (const f of fields) {
    ;(groups[f.type] ??= []).push(f)
  }
  return groups
}

const VIEW_USAGE_I18N_KEYS: Record<string, string> = {
  filter: 'view:actions.filter',
  sort: 'view:actions.sort',
  group: 'view:actions.group',
}

/** W1.4 / C1:warning_level → 视觉 tone(对应 design-system 的 status 色) */
const WARNING_TONE: Record<'low' | 'medium' | 'high', 'info' | 'warning' | 'danger'> = {
  low: 'info',
  medium: 'warning',
  high: 'danger',
}

/** undo_capability.reason_code → i18n 文案 key */
const UNDO_HINT_KEY: Record<FieldUndoReasonCode, string> = {
  simple_supported: 'tabdata:field.deleteImpactDialog.undoSimpleHint',
  complex_supported: 'tabdata:field.deleteImpactDialog.undoComplexHint',
  complex_dependency: 'tabdata:field.deleteImpactDialog.undoComplexHint',
  not_in_wave1: 'tabdata:field.deleteImpactDialog.undoNotInWaveHint',
  unknown_type: 'tabdata:field.deleteImpactDialog.undoUnknownHint',
}

export const FieldDeleteConfirmDialog: React.FC<FieldDeleteConfirmDialogProps> = ({
  open,
  onOpenChange,
  fieldId,
  fieldName,
  fieldType,
  isPrimary = false,
  onConfirm,
  onOpenVersionHistory,
}) => {
  const { t } = useTranslation(['field', 'view', 'tabdata'])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [explain, setExplain] = useState<FieldExplainResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorSource, setErrorSource] = useState<'fetch' | 'delete' | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const fetchExplain = useCallback(() => {
    if (!fieldId) return
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    const { signal } = controller

    setLoading(true)
    setError(null)
    setErrorSource(null)

    FieldApiService.explainFieldAction(fieldId, 'delete')
      .then((data) => {
        if (!signal.aborted) setExplain(data)
      })
      .catch(() => {
        // P0 Review 修复:屏蔽原始 err.message,避免英文异常名(如 NetworkError /
        // TypeError)直接暴露给用户,统一用三段式 fetchErrorFallback 文案。
        if (!signal.aborted) {
          setError(t('tabdata:field.deleteImpactDialog.fetchErrorFallback'))
          setErrorSource('fetch')
        }
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false)
      })
  }, [fieldId, t])

  useEffect(() => {
    if (!open || !fieldId) {
      setExplain(null)
      setError(null)
      setErrorSource(null)
      return
    }
    fetchExplain()
    return () => { abortControllerRef.current?.abort() }
  }, [open, fieldId, fetchExplain])

  const handleConfirm = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    setErrorSource(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('field:deleteImpact.deleteFailed'))
      setErrorSource('delete')
    } finally {
      setSubmitting(false)
    }
  }, [onConfirm, t])

  const impact = explain?.impact ?? null
  const undoCapability: FieldUndoCapability | null = explain?.undo_capability ?? null
  const warningLevel = explain?.warning_level ?? 'low'

  const hasDependencies =
    impact &&
    (impact.dependent_fields.length > 0 ||
      impact.affected_views.length > 0 ||
      impact.symmetric_link_field !== null)

  const fieldTypeLabel = useCallback(
    (type: string) => t(`field:types.${type}`, { defaultValue: t('field:deleteImpact.otherType') }),
    [t],
  )

  const localizeUsage = useCallback(
    (usage: string[]) =>
      usage.map((u) => t(VIEW_USAGE_I18N_KEYS[u] ?? u, { defaultValue: u })).join(', '),
    [t],
  )

  const dependentGroups = impact ? groupDependentFields(impact.dependent_fields) : {}

  const handleCloseAutoFocus = (event: Event) => {
    event.preventDefault()
    restoreTableGridFocus()
  }

  if (isPrimary) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" onCloseAutoFocus={handleCloseAutoFocus}>
          <DialogHeader>
            <DialogTitle>{t('field:deleteImpact.title', { name: fieldName })}</DialogTitle>
            <DialogDescription>
              {t('field:deleteImpact.primaryFieldBlocked')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('field:deleteImpact.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // ── 渲染 W1.4 新增模块:warning_level banner + undo_capability hint ──
  // PRD §3.5.2 反馈分级:high / medium / low 对应不同 tone
  const renderWarningBanner = () => {
    if (loading || !explain) return null
    const tone = WARNING_TONE[warningLevel]
    const titleKey =
      warningLevel === 'high'
        ? 'tabdata:field.deleteImpactDialog.warningHigh'
        : warningLevel === 'medium'
          ? 'tabdata:field.deleteImpactDialog.warningMedium'
          : 'tabdata:field.deleteImpactDialog.warningLow'
    return (
      <StatusNotice
        tone={tone}
        size="sm"
        title={t(titleKey)}
      />
    )
  }

  // ── 渲染撤销引导(W0-7 c5 词表:撤销 = undo / Ctrl+Z) ──
  const renderUndoHint = () => {
    if (loading || !undoCapability) return null
    const hintKey = UNDO_HINT_KEY[undoCapability.reason_code] ?? UNDO_HINT_KEY.unknown_type
    const canUndo = undoCapability.can_undo
    const tone = canUndo ? 'info' : 'warning'
    const Icon = canUndo ? Undo2 : History
    const showVersionHistoryButton =
      !canUndo &&
      undoCapability.deferred_to === 'version_history' &&
      onOpenVersionHistory
    return (
      <StatusNotice
        tone={tone}
        size="sm"
        icon={<Icon className="h-4 w-4 shrink-0" />}
        description={t(hintKey)}
        actions={
          showVersionHistoryButton ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenVersionHistory?.()}
            >
              {t('tabdata:field.deleteImpactDialog.openVersionHistory')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={handleCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {warningLevel === 'high' && <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />}
            {warningLevel === 'medium' && <Info className="h-5 w-5 text-warning shrink-0" />}
            {t('field:deleteImpact.title', { name: fieldName })}
          </DialogTitle>
          {/*
            P0 Review 修复:`field:deleteImpact.noImpact` 旧文案是「此操作不可撤销」,
            与下方 undoSimpleHint「可 Ctrl+Z 撤销」直接矛盾。
            当无依赖时主描述使用 `noImpactSafe` 中性确认句,撤销可行性完全交给
            undoCapability StatusNotice 负责,避免同屏冲突。
          */}
          <DialogDescription>
            {loading
              ? t('field:deleteImpact.loading')
              : hasDependencies
                ? t('field:deleteImpact.cascadeWarning')
                : t('tabdata:field.deleteImpactDialog.noImpactSafe', { name: fieldName })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <PanelLoadingState variant="detail" rows={3} showHeader={false} className="px-0 py-2" />
        ) : null}

        {renderWarningBanner()}
        {renderUndoHint()}

        {error ? (
          <StatusNotice
            tone="danger"
            size="sm"
            title={errorSource === 'delete' ? t('field:deleteImpact.deleteFailed') : t('field:deleteImpact.fetchError')}
            description={error}
            actions={errorSource === 'fetch' ? (
              <Button type="button" variant="outline" size="sm" onClick={() => fetchExplain()}>
                {t('field:deleteImpact.fetchErrorRetry')}
              </Button>
            ) : undefined}
          />
        ) : null}

        {!loading && impact && hasDependencies && (
          <ScrollArea className="max-h-[320px] pr-2">
            <div className="space-y-4 text-body">
              {impact.symmetric_link_field && (
                <section>
                  <div className="flex items-center gap-1.5 font-medium text-destructive mb-1.5">
                    <Link2 className="h-4 w-4 shrink-0" />
                    {t('field:deleteImpact.symmetricLinkTitle')}
                  </div>
                  <div className="ml-5.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
                    <span className="font-medium">
                      {impact.symmetric_link_field.table_name}
                    </span>
                    <span className="text-muted-foreground mx-1">→</span>
                    {impact.symmetric_link_field.name}
                  </div>
                </section>
              )}

              {impact.dependent_fields.length > 0 && (
                <section>
                  <div className="flex items-center gap-1.5 font-medium mb-1.5">
                    <Columns3 className="h-4 w-4 shrink-0 text-type-cron" />
                    {t('field:deleteImpact.dependentFieldsTitle', {
                      count: impact.dependent_fields.length,
                    })}
                  </div>
                  <div className="ml-5.5 space-y-2">
                    {Object.entries(dependentGroups).map(([type, items]) => (
                      <div key={type}>
                        <span className="text-body text-muted-foreground uppercase tracking-wide">
                          {fieldTypeLabel(type)}
                        </span>
                        <ul className="mt-1 space-y-1">
                          {items.map((f) => (
                            <li
                              key={f.id}
                              className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5"
                            >
                              <span className="truncate font-medium">{f.name}</span>
                              {f.table_name && (
                                <span className="text-body text-muted-foreground shrink-0">
                                  ({f.table_name})
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {impact.affected_views.length > 0 && (
                <section>
                  <div className="flex items-center gap-1.5 font-medium mb-1.5">
                    <Eye className="h-4 w-4 shrink-0 text-info" />
                    {t('field:deleteImpact.affectedViewsTitle', {
                      count: impact.affected_views.length,
                    })}
                  </div>
                  <ul className="ml-5.5 space-y-1">
                    {impact.affected_views.map((v) => (
                      <li
                        key={v.id}
                        className="flex items-center justify-between rounded-md bg-muted/60 px-2.5 py-1.5"
                      >
                        <span className="truncate font-medium">{v.name}</span>
                        {v.usage.length > 0 && (
                          <span className="text-body text-muted-foreground shrink-0 ml-2">
                            {localizeUsage(v.usage)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </ScrollArea>
        )}

        {!loading && hasDependencies && <Separator />}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('field:deleteImpact.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading || submitting}
          >
            {submitting ? t('field:deleteImpact.deleting') : t('field:deleteImpact.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// 类型导出方便 caller 使用(向后兼容旧调用方)
export type { FieldDeleteConfirmDialogProps }

/**
 * FieldRecycleBin
 *
 * W3.5 / D2: 字段回收站 UI（管理员可见），展示当前表的软删除字段列表，
 * 支持按行恢复。后端端点在 `api_admin_integrity.py`。
 *
 * 入口: TableSettingsDialog → 已删除字段 tab
 */
import { joinApiPath } from '@tabtin/config'
import React, { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  Button,
  ScrollArea,
  toast,
  cn,
  PanelLoadingState,
  StatusNotice,
  Badge,
} from '@tabtin/smartsheet-ui'
import { RotateCcw, RefreshCw, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { apiRequest as adapterApiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { API_CONFIG } from '@/config/api'

// ── Types ──────────────────────────────────────────────────

interface DeletedField {
  id: string
  name: string
  field_type: string
  is_deleted: boolean
  deleted_at: string | null
  days_remaining: number | null
  config: Record<string, unknown>
}

interface DeletedFieldListResponse {
  table_id: string
  fields: DeletedField[]
  ttl_days: number
}

interface RestoreFieldResponse {
  success: boolean
  field_id: string
  message: string
}

// ── Helpers ────────────────────────────────────────────────

const FIELD_TYPE_ALIASES: Record<string, string> = {
  longtext: 'long_text',
  single_select: 'select',
}

const formatTime = (iso?: string | null): string => {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString()
}

// ── Component ──────────────────────────────────────────────

export interface FieldRecycleBinProps {
  isOpen: boolean
  onClose: () => void
  tableId: string
}

export const FieldRecycleBin: React.FC<FieldRecycleBinProps> = ({
  isOpen,
  onClose,
  tableId,
}) => {
  const { t } = useTranslation('tabdata')
  const { t: tField } = useTranslation('field')
  const tt = useCallback(
    (key: string, opts?: Record<string, unknown>) => String(t(key as any, opts as any)),
    [t],
  )
  const fieldTypeLabel = useCallback(
    (fieldType: string) => {
      const normalized = FIELD_TYPE_ALIASES[fieldType] ?? fieldType
      return String(tField(`types.${normalized}` as any, { defaultValue: fieldType }))
    },
    [tField],
  )

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<DeletedField[]>([])
  const [ttlDays, setTtlDays] = useState(30)
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set())

  const fetchFields = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await getAuthToken()
      const resp = await adapterApiRequest({
        url: joinApiPath(API_CONFIG.baseURL, `/auth/admin/tabdata/tables/${tableId}/deleted-fields`),
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = resp.data as DeletedFieldListResponse
      setFields(data.fields ?? [])
      setTtlDays(data.ttl_days ?? 30)
    } catch (err) {
      setError(err instanceof Error ? err.message : tt('admin.fieldRecycleBin.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [tableId, tt])

  useEffect(() => {
    if (isOpen) void fetchFields()
  }, [isOpen, fetchFields])

  const handleRestore = useCallback(async (field: DeletedField) => {
    setRestoringIds(prev => new Set(prev).add(field.id))
    try {
      const token = await getAuthToken()
      const resp = await adapterApiRequest({
        url: joinApiPath(API_CONFIG.baseURL, `/auth/admin/tabdata/tables/${tableId}/deleted-fields/${field.id}/restore`),
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = resp.data as RestoreFieldResponse
      if (data.success) {
        toast({ title: tt('admin.fieldRecycleBin.restoreSuccess', { name: field.name }) })
        setFields(prev => prev.filter(f => f.id !== field.id))
      } else {
        toast({
          title: tt('admin.fieldRecycleBin.restoreFailed', { reason: data.message }),
          variant: 'destructive',
        })
      }
    } catch (err) {
      toast({
        title: tt('admin.fieldRecycleBin.restoreFailed', {
          reason: err instanceof Error ? err.message : '',
        }),
        variant: 'destructive',
      })
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev)
        next.delete(field.id)
        return next
      })
    }
  }, [tableId, tt])

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl p-0">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-6 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h2 className="text-title font-semibold text-foreground">
                {tt('admin.fieldRecycleBin.title')}
              </h2>
              <p className="text-caption text-muted-foreground">
                {tt('admin.fieldRecycleBin.description', { days: ttlDays })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void fetchFields()}
              className="h-7 px-2"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <ScrollArea className="max-h-[60vh]">
          <div className="p-6">
            {error && (
              <StatusNotice tone="danger" className="mb-4" title={error} actions={(
                <Button variant="ghost" size="sm" onClick={() => void fetchFields()}>
                  {tt('admin.fieldRecycleBin.refresh')}
                </Button>
              )}
              />
            )}

            {loading && fields.length === 0 ? (
              <div className="space-y-2">
                <p className="text-body text-muted-foreground">{tt('admin.fieldRecycleBin.loading')}</p>
                <PanelLoadingState />
              </div>
            ) : fields.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                <Trash2 className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-body">{tt('admin.fieldRecycleBin.empty')}</p>
                <p className="text-caption text-muted-foreground/60">
                  {tt('admin.fieldRecycleBin.ttlHint', { days: ttlDays })}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {fields.map((field) => (
                  <div
                    key={field.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-body font-medium truncate">
                          {field.name}
                        </span>
                        <Badge variant="outline" className="text-caption shrink-0">
                          {fieldTypeLabel(field.field_type)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-caption text-muted-foreground/60">
                        <span>{formatTime(field.deleted_at)}</span>
                        {field.days_remaining !== null && (
                          <span className={cn(
                            field.days_remaining <= 3 && 'text-destructive',
                          )}>
                            {tt('admin.fieldRecycleBin.daysRemainingValue', {
                              days: field.days_remaining,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-caption shrink-0"
                      disabled={restoringIds.has(field.id)}
                      onClick={() => void handleRestore(field)}
                    >
                      <RotateCcw className={cn(
                        'h-3 w-3',
                        restoringIds.has(field.id) && 'animate-spin',
                      )} />
                      {tt('admin.fieldRecycleBin.restoreAction')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

/**
 * useFieldConversion — 字段类型转换的状态管理 + API 调用 hook
 *
 * 封装预览、确认、执行转换的完整流程，
 * 供 Web (TablePaneView) 和 Electron (FieldSettingPanel) 共用，消除重复逻辑。
 */

import { useCallback, useRef, useState } from 'react'
import {
  FieldApiService,
  type FieldType,
  type FieldConversionPreviewResponse,
  type FieldConversionResponse,
  type FieldConversionCheckResponse,
  type FieldDefaultValue,
} from '@tabtin/table-core'
import type { ConversionPreviewData } from '../components/field/conversion-preview-dialog'

const STRUCTURAL_TYPES: ReadonlySet<string> = new Set(['link'])

export interface FieldConversionUpdatePayload {
  name?: string
  description?: string
  default_value?: FieldDefaultValue | null
  width?: number
  validation_rules?: Record<string, unknown>
  visibility_roles?: string[]
}

export interface UseFieldConversionOptions {
  onSuccess?: (result: FieldConversionResponse) => void | Promise<void>
  onError?: (error: unknown) => void
  /** 类型转换成功但属性更新失败时的回调 */
  onUpdateFieldError?: (error: unknown) => void
}

export interface UseFieldConversionReturn {
  previewOpen: boolean
  preview: ConversionPreviewData | null
  previewLoading: boolean
  converting: boolean

  isStructuralType: (type: string) => boolean

  /** 轻量预检：判断从当前字段到目标类型是否可转换（不加载采样数据） */
  checkConversion: (
    fieldId: string,
    targetType: string,
  ) => Promise<FieldConversionCheckResponse | null>

  startPreview: (
    fieldId: string,
    fieldName: string,
    fromType: string,
    targetType: string,
    targetOptions?: Record<string, unknown>,
  ) => Promise<void>

  executeConversion: (
    fieldId: string,
    targetType: FieldType,
    targetOptions: Record<string, unknown> | undefined,
    updatePayload: FieldConversionUpdatePayload,
    opts?: { force?: boolean; async_mode?: boolean },
  ) => Promise<FieldConversionResponse | null>

  cancelPreview: () => void
  setPreviewOpen: (open: boolean) => void

  formatResultParts: (
    result: FieldConversionResponse,
    tFn: (key: string, opts?: Record<string, unknown>) => string,
  ) => string[]
}

export function useFieldConversion(
  options?: UseFieldConversionOptions,
): UseFieldConversionReturn {
  const [previewOpen, setPreviewOpenRaw] = useState(false)
  const [preview, setPreview] = useState<ConversionPreviewData | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [converting, setConverting] = useState(false)
  const { onSuccess, onError, onUpdateFieldError } = options ?? {}

  const isStructuralType = useCallback(
    (type: string) => STRUCTURAL_TYPES.has(type),
    [],
  )

  const CHECK_CACHE_TTL = 60_000
  const checkCache = useRef<Map<string, { data: FieldConversionCheckResponse; ts: number }>>(new Map())

  const checkConversion = useCallback(
    async (
      fieldId: string,
      targetType: string,
    ): Promise<FieldConversionCheckResponse | null> => {
      const key = `${fieldId}:${targetType}`
      const cached = checkCache.current.get(key)
      if (cached && Date.now() - cached.ts < CHECK_CACHE_TTL) return cached.data

      try {
        const resp = await FieldApiService.checkConversion(fieldId, {
          target_type: targetType,
        })
        checkCache.current.set(key, { data: resp, ts: Date.now() })
        return resp
      } catch {
        return null
      }
    },
    [],
  )

  const cancelPreview = useCallback(() => {
    setPreviewOpenRaw(false)
    setPreview(null)
  }, [])

  const setPreviewOpen = useCallback(
    (open: boolean) => {
      setPreviewOpenRaw(open)
      if (!open) setPreview(null)
    },
    [],
  )

  const startPreview = useCallback(
    async (
      fieldId: string,
      fieldName: string,
      fromType: string,
      targetType: string,
      targetOptions?: Record<string, unknown>,
    ) => {
      setPreviewLoading(true)
      setPreviewOpenRaw(true)

      try {
        const resp: FieldConversionPreviewResponse =
          await FieldApiService.previewConversion(fieldId, {
            target_type: targetType,
            target_options: targetOptions,
            sample_size: 10,
          })
        setPreview(resp)
      } catch {
        setPreview({
          can_convert: true,
          field_name: fieldName,
          from_type: fromType,
          to_type: targetType,
          success_rate: undefined,
          error: 'preview_load_failed',
        })
      } finally {
        setPreviewLoading(false)
      }
    },
    [],
  )

  const executeConversion = useCallback(
    async (
      fieldId: string,
      targetType: FieldType,
      targetOptions: Record<string, unknown> | undefined,
      updatePayload: FieldConversionUpdatePayload,
      opts?: { force?: boolean; async_mode?: boolean },
    ): Promise<FieldConversionResponse | null> => {
      setConverting(true)
      try {
        const result = await FieldApiService.convertField(fieldId, {
          target_type: targetType,
          target_options: targetOptions,
          force: opts?.force,
          async_mode: opts?.async_mode,
        })

        try {
          await FieldApiService.updateField(fieldId, {
            name: updatePayload.name,
            description: updatePayload.description,
            default_value: updatePayload.default_value,
            width: updatePayload.width,
            validation_rules: updatePayload.validation_rules,
            visibility_roles: updatePayload.visibility_roles,
          })
        } catch (updateError: unknown) {
          setPreviewOpenRaw(false)
          setPreview(null)
          await onSuccess?.(result)
          onUpdateFieldError?.(updateError)
          return result
        }

        setPreviewOpenRaw(false)
        setPreview(null)

        await onSuccess?.(result)
        return result
      } catch (error: unknown) {
        onError?.(error)
        return null
      } finally {
        setConverting(false)
      }
    },
    [onSuccess, onError, onUpdateFieldError],
  )

  const formatResultParts = useCallback(
    (
      result: FieldConversionResponse,
      tFn: (key: string, opts?: Record<string, unknown>) => string,
    ): string[] => {
      const parts: string[] = []
      if (result.affected_records) {
        parts.push(
          tFn('fieldConversion.affected', {
            defaultValue: '影响 {{count}} 条记录',
            count: result.affected_records,
          }),
        )
      }
      const clearedCount =
        (result as FieldConversionResponse & { cleared_count?: number }).cleared_count ??
        result.forced_null_count
      if (clearedCount && clearedCount > 0) {
        parts.push(
          tFn('fieldConversion.nulled', {
            defaultValue: '{{count}} 条记录因无法转换被置为空值',
            count: clearedCount,
          }),
        )
      }
      return parts
    },
    [],
  )

  return {
    previewOpen,
    preview,
    previewLoading,
    converting,
    isStructuralType,
    checkConversion,
    startPreview,
    executeConversion,
    cancelPreview,
    setPreviewOpen,
    formatResultParts,
  }
}

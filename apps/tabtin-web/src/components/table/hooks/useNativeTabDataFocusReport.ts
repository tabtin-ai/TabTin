/**
 * embedded 表格壳：把 tableId + ViewStore.currentViewId 回传原生焦点。
 * debounce ≤100ms；首帧有值也会报一次。
 */

import { useEffect } from 'react'
import {
  NATIVE_FOCUS_REPORT_DEBOUNCE_MS,
  reportNativeFocus,
  resolveTabDataNativeFocusReport,
} from '@/platform/native-focus-bridge'

export function useNativeTabDataFocusReport(input: {
  isEmbedded: boolean
  tableId: string
  viewTableId: string | null
  currentViewId: string | null
}): void {
  const { isEmbedded, tableId, viewTableId, currentViewId } = input

  useEffect(() => {
    const payload = resolveTabDataNativeFocusReport({
      isEmbedded,
      tableId,
      viewTableId,
      currentViewId,
    })
    if (!payload) return

    const timer = window.setTimeout(() => {
      reportNativeFocus(payload)
    }, NATIVE_FOCUS_REPORT_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [isEmbedded, tableId, viewTableId, currentViewId])
}

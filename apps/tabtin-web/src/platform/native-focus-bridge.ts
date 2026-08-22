/**
 * Native Focus Bridge — Web → iOS/Android 工作台焦点回传。
 *
 * 与 Auth bridge 分离。原生在 WebView 注入 `window.__TABTIN_NATIVE_FOCUS__`；
 * 未注入时 report 为 no-op，不影响浏览器直开。
 */

export type NativeFocusAppType = 'tabdata'

export interface NativeFocusPayload {
  appType: NativeFocusAppType
  /** table id，必填 */
  resourceId: string
  /** 当前视图；未知时 null，不要传空串 */
  viewId: string | null
}

interface NativeFocusHost {
  report(payload: NativeFocusPayload): void
}

declare global {
  interface Window {
    __TABTIN_NATIVE_FOCUS__?: NativeFocusHost
  }
}

export const NATIVE_FOCUS_REPORT_DEBOUNCE_MS = 100

export function hasNativeFocusHost(): boolean {
  return typeof window !== 'undefined'
    && typeof window.__TABTIN_NATIVE_FOCUS__?.report === 'function'
}

export function buildTabDataNativeFocusPayload(
  resourceId: string,
  viewId: string | null | undefined,
): NativeFocusPayload {
  return {
    appType: 'tabdata',
    resourceId,
    viewId: viewId ?? null,
  }
}

/**
 * 决定是否应向原生上报，以及上报内容。
 * - 仅 embedded shell 上报
 * - viewStore 尚未对齐当前 table 时 viewId 置 null（避免串表陈旧视图）
 */
export function resolveTabDataNativeFocusReport(input: {
  isEmbedded: boolean
  tableId: string | null | undefined
  viewTableId: string | null | undefined
  currentViewId: string | null | undefined
}): NativeFocusPayload | null {
  if (!input.isEmbedded) return null
  const tableId = typeof input.tableId === 'string' ? input.tableId.trim() : ''
  if (!tableId) return null

  const viewTableId =
    typeof input.viewTableId === 'string' ? input.viewTableId.trim() : ''
  const trimmedViewId =
    typeof input.currentViewId === 'string' ? input.currentViewId.trim() : ''
  const viewId =
    viewTableId === tableId
      ? (trimmedViewId || null)
      : null

  return buildTabDataNativeFocusPayload(tableId, viewId)
}

/** 探测宿主并上报；无 host 时 no-op。 */
export function reportNativeFocus(payload: NativeFocusPayload): void {
  if (typeof window === 'undefined') return
  const report = window.__TABTIN_NATIVE_FOCUS__?.report
  if (typeof report !== 'function') return
  try {
    report(payload)
  } catch {
    // 宿主异常不影响 Web 表格主路径
  }
}

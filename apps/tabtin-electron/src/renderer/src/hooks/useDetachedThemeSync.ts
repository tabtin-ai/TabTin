import { useEffect } from 'react'

import { applyOverlayLocale } from '@/utils/overlayLocaleSync'
import { applyThemeSnapshot, type OverlayThemeSnapshot } from '@/utils/overlayThemeSync'

/**
 * 独立窗口（私信 / 分离聊天）是独立的 renderer 进程，其 documentElement 只在冷启动时
 * 通过共享 localStorage 对齐一次主题，主窗口运行时切换主题 / 配色后不会自动跟随。
 *
 * 这里复用 overlay 子窗口同一套主题 / 语言快照机制：订阅主窗口广播的
 * `overlay:sync-theme` 与 `overlay:sync-locale`，镜像到自己的 documentElement 与 i18n。
 */
export function useDetachedThemeSync(): void {
  useEffect(() => {
    const offTheme = window.tabtin?.overlay?.onSyncTheme?.((raw) => {
      applyThemeSnapshot(raw as OverlayThemeSnapshot)
    })
    const offLocale = window.tabtin?.overlay?.onSyncLocale?.((raw) => {
      applyOverlayLocale(raw)
    })
    return () => {
      offTheme?.()
      offLocale?.()
    }
  }, [])
}

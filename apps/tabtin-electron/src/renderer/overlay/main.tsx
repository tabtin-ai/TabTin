import React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'

import { queryClient } from '@/lib/query-client'
import { useUIStore } from '@stores/useUIStore'
import { applyOverlayLocale } from '@/utils/overlayLocaleSync'
import { applyThemeSnapshot, type OverlayThemeSnapshot } from '@/utils/overlayThemeSync'
import { OverlayApp } from './OverlayApp'

import '@/i18n'
import '@styles/globals.css'
import '@tabtin/smartsheet-ui/styles'

/**
 * overlay renderer 必须保持透明：globals.css 有 `body { background: hsl(--canvas) !important }`，
 * 会盖掉 overlay.html 的 transparent。元素 inline style + important 优先级最高，强制透明，
 * 否则 toast view / modal 子窗口都会显示不透明底色（见 ）。
 */
function forceTransparentSurface(): void {
  document.documentElement.style.setProperty('background', 'transparent', 'important')
  document.body.style.setProperty('background', 'transparent', 'important')
}

/**
 * 主题跟随：先用本地 store（localStorage 恢复）兜底应用一次，再订阅主 renderer
 * 广播的精确快照（含运行时切换 / 自定义 accent）。
 */
function setupThemeSync(): void {
  const ui = useUIStore.getState()
  applyThemeSnapshot({
    isDark: ui.resolvedTheme === 'dark',
    colorScheme: ui.colorScheme ?? null,
    accent: null,
    ring: null,
  })
  window.tabtin?.overlay?.onSyncTheme?.((raw) => {
    applyThemeSnapshot(raw as OverlayThemeSnapshot)
  })
}

function setupLocaleSync(): void {
  window.tabtin?.overlay?.onSyncLocale?.((raw) => {
    applyOverlayLocale(raw)
  })
}

async function bootstrap(): Promise<void> {
  forceTransparentSurface()
  setupThemeSync()
  setupLocaleSync()

  const [
    { initializeElectronApiAdapter },
    { initAppShellForElectron },
  ] = await Promise.all([
    import('@/adapters/api-adapter-instance'),
    import('@/adapters/app-shell-init'),
  ])

  initializeElectronApiAdapter()
  initAppShellForElectron()

  const container = document.getElementById('root')
  if (!container) {
    throw new Error('Overlay root element not found')
  }

  createRoot(container).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <OverlayApp />
      </QueryClientProvider>
    </React.StrictMode>,
  )
}

bootstrap().catch((error) => {
  console.error('[Overlay] bootstrap failed:', error)
})

import { useState, useEffect } from 'react'

/**
 * 读取 `documentElement.classList.contains('dark')` + 监听 DOM class 变化。
 *
 * **Widget Wave 7 补丁**：变化时通过 `window.tabtin.uiTheme.report(...)` 把当前
 * theme 同步给 Electron main 进程。main 的 UIThemeAPI bridge 维护最新值让
 * `show-widget/bake-upload.ts` 烤图时 `resolveUITheme()` 拿到，从而把烤出来的
 * PNG 的主题跟 renderer 看到的 chat widget 对齐——修 Wave 4 烤图一路走默认
 * `'light'` 导致移动端 dark 模式用户看到 light 图片的跨端视觉分裂。
 *
 * **非阻塞契约**：`report(...)` 失败不影响 renderer 任何行为（fire-and-forget）。
 * preload API 不存在时（例如测试环境 mock 掉全部 window.tabtin）直接 no-op。
 */
export function useIsDarkMode(): boolean {
  const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'))

  useEffect(() => {
    reportThemeToMain(isDarkMode ? 'dark' : 'light')
  }, [isDarkMode])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isDarkMode
}

function reportThemeToMain(theme: 'light' | 'dark'): void {
  try {
    const report = (window as unknown as {
      tabtin?: { uiTheme?: { report?: (t: 'light' | 'dark') => Promise<unknown> } }
    })?.tabtin?.uiTheme?.report
    if (typeof report === 'function') {
      void report(theme).catch(() => {
        /* fire-and-forget — 失败不阻塞 renderer */
      })
    }
  } catch {
    /* preload 未注入或 renderer unit test 环境，noop */
  }
}

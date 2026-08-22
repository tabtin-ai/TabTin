import { useEffect, useState } from 'react'

/**
 * 当前窗口是否处于系统全屏（Electron `BrowserWindow.isFullScreen()`）。
 *
 * macOS 全屏时系统红绿灯隐藏，依赖红绿灯安全区的布局（折叠态
 * 「展开侧栏」入口的左侧避让等）需要据此收回间距。状态来源：
 * 初值走 `window:isFullScreen` IPC，变更走 `window:fullscreen-changed`
 * 推送（绿灯、系统快捷键等任意来源触发都会同步）。
 *
 * preload 缺失时（测试 / 异常环境）恒为 false。
 */
export function useWindowFullScreen(): boolean {
  const [isFullScreen, setIsFullScreen] = useState(false)

  useEffect(() => {
    const controls = typeof window !== 'undefined' ? window.tabtin?.windowControls : undefined
    if (!controls?.isFullScreen) return
    let active = true
    controls
      .isFullScreen()
      .then((value) => {
        if (active) setIsFullScreen(Boolean(value))
      })
      .catch(() => {})
    const unsubscribe = controls.onFullScreenChange?.((value) => {
      setIsFullScreen(value)
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  return isFullScreen
}

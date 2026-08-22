import { useEffect, useRef } from 'react'

import { shouldIgnoreToastOverlayMouse } from './toast-overlay-hit-test'

/**
 * toast 子窗口整窗 `setIgnoreMouseEvents(true, { forward: true })` 时，
 * 用转发来的 mousemove 在命中卡片上临时取消穿透，让关闭钮可点。
 *
 * 无可见 toast 或指针离开命中区时必须恢复穿透，否则透明全屏会挡住主窗口。
 *
 * ：toast 刚出现时指针可能已停在卡片上（删除组织成功等场景常见），
 * 此时没有 mousemove，需在 paint 后主动查主进程光标坐标做一次命中同步。
 */
export function useToastOverlayMousePassthrough(hasVisibleToasts: boolean): void {
  const ignoringRef = useRef(true)

  useEffect(() => {
    const setIgnoring = (ignore: boolean) => {
      if (ignoringRef.current === ignore) return
      ignoringRef.current = ignore
      void window.tabtin?.overlay?.setToastIgnoreMouseEvents?.(ignore)
    }

    if (!hasVisibleToasts) {
      setIgnoring(true)
      return
    }

    const syncFromPointer = (clientX: number, clientY: number) => {
      setIgnoring(shouldIgnoreToastOverlayMouse(clientX, clientY))
    }

    const onMove = (event: MouseEvent) => {
      syncFromPointer(event.clientX, event.clientY)
    }

    const onLeaveWindow = () => {
      setIgnoring(true)
    }

    let cancelled = false
    const syncFromMainCursor = () => {
      void window.tabtin?.overlay?.getToastCursorClientPoint?.().then((point) => {
        if (cancelled || !point) return
        syncFromPointer(point.clientX, point.clientY)
      })
    }

    // 双 rAF：等 OverlayToaster 把 data-overlay-track 卡片画进 DOM 再命中。
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        syncFromMainCursor()
      })
    })

    document.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onLeaveWindow)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      document.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeaveWindow)
      setIgnoring(true)
    }
  }, [hasVisibleToasts])
}

import React from 'react'
import { MessageHost, getMessageController } from '@tabtin/smartsheet-ui/toast'

import { useToastOverlayMousePassthrough } from '../hooks/useToastOverlayMousePassthrough'

/**
 * Toast 子窗口 Host。
 * 默认整窗穿透；悬停/静止指针命中卡片时临时取消穿透。
 *
 * 注意：不要再用「贴卡片收窗 + 整窗捕获」——viewport 曾被量成接近全屏，
 * 导致透明 toast 子窗挡住整个主窗口（全局点不动）。
 */
export function OverlayToaster() {
  const [hasVisible, setHasVisible] = React.useState(
    () => getMessageController().getVisibleItems().length > 0,
  )

  React.useEffect(() => {
    return getMessageController().subscribe((items) => {
      setHasVisible(items.some((item) => item.open !== false))
    })
  }, [])

  // 从错误 hug 态恢复：挂载即清掉主进程 toastStackSize，强制全屏穿透。
  React.useEffect(() => {
    void window.tabtin?.overlay?.setToastStackSize?.(null)
  }, [])

  // Windows：无可见卡片时隐藏 toast 子窗，避免全屏穿透 HWND 打断 OLE HTML5 拖拽。
  React.useEffect(() => {
    void window.tabtin?.overlay?.setToastContentVisible?.(hasVisible)
  }, [hasVisible])

  useToastOverlayMousePassthrough(hasVisible)

  return <MessageHost overlay />
}

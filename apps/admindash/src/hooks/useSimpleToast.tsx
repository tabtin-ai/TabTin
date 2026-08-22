/**
 * AdminDash 短暂反馈 — 统一到 @tabtin/smartsheet-ui/message。
 * 保留旧 hook 形状（show + element），element 恒为 null（由根级 MessageHost 渲染）。
 */
import { useCallback, type ReactNode } from 'react'
import { message } from '@tabtin/smartsheet-ui/message'

type ToastType = 'success' | 'error'

export function useSimpleToast(duration = 3000) {
  const show = useCallback(
    (text: string, type: ToastType = 'success') => {
      if (type === 'error') {
        message.error(text, { duration })
        return
      }
      message.success(text, { duration })
    },
    [duration],
  )

  return { show, element: null as ReactNode }
}

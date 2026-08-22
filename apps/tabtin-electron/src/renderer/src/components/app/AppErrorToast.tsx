/**
 * AppErrorToast — 将 useUIStore.error 桥接到统一 message 模块。
 * 不再自绘第二套全局错误浮层。
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { message } from '@tabtin/smartsheet-ui/message'
import { useUIStore } from '@stores/useUIStore'

export function AppErrorToast() {
  const { t } = useTranslation('common')
  const error = useUIStore((state) => state.error)
  const clearError = useUIStore((state) => state.clearError)
  const lastKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!error) return

    console.error(t('logs.appError'), error)
    if (lastKeyRef.current) {
      message.destroy(lastKeyRef.current)
    }
    const handle = message.error({
      content: t('errorTitle'),
      description: error,
      duration: 3000,
    })
    lastKeyRef.current = handle.key

    const timer = setTimeout(() => {
      clearError()
      lastKeyRef.current = null
    }, 3000)

    return () => {
      clearTimeout(timer)
    }
  }, [error, clearError, t])

  return null
}

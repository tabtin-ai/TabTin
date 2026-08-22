import { useEffect, useRef } from 'react'
import { ToastAction, toast } from '@tabtin/smartsheet-ui/toast'

export function useAppUpdater() {
  const handledKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!window.tabtin?.updater?.onUpdateEvent) return

    return window.tabtin.updater.onUpdateEvent((payload) => {
      const event = payload?.event
      const data = payload?.data ?? {}
      const version = typeof data?.version === 'string' ? data.version : ''
      const dedupeKey = `${event}:${version || String(data)}`

      if (handledKeysRef.current.has(dedupeKey)) {
        return
      }

      if (event === 'update-available') return

      if (event === 'update-downloaded') {
        if (data?.mandatory) return
        handledKeysRef.current.add(dedupeKey)
        toast({
          title: version ? `v${version} 已准备就绪` : '更新已准备就绪',
          description: '重启应用即可完成安装。',
          duration: 15_000,
          action: (
            <ToastAction
              altText="立即重启并安装"
              onClick={() => {
                window.tabtin.updater.quitAndInstall()
              }}
            >
              立即安装
            </ToastAction>
          ),
        })
        return
      }

      if (event === 'update-error') {
        handledKeysRef.current.add(dedupeKey)
        toast({
          title: '更新失败',
          description: typeof data === 'string' ? data : '请稍后重试',
          variant: 'destructive',
          duration: 8_000,
        })
      }
    })
  }, [])
}

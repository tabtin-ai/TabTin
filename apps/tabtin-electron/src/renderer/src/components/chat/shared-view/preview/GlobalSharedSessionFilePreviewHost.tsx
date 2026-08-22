/**
 * 全局共享会话文件预览 Drawer 宿主。
 *
 * 挂在 App / Detached IM 顶层，避免 SharedSessionPane 子树 Dialog 被画布裁切。
 */
import React from 'react'
import { useSharedSessionPreviewStore } from './useSharedSessionPreviewStore'

const LazySharedSessionFilePreviewDrawer = React.lazy(() =>
  import('./SharedSessionFilePreviewDrawer').then((m) => ({
    default: m.SharedSessionFilePreviewDrawer,
  })),
)

export const GlobalSharedSessionFilePreviewHost: React.FC = () => {
  const target = useSharedSessionPreviewStore((s) => s.target)

  if (!target) return null

  return (
    <React.Suspense fallback={null}>
      <LazySharedSessionFilePreviewDrawer target={target} />
    </React.Suspense>
  )
}

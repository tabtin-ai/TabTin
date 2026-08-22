import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'

const LazyAgentSettingsSheet = React.lazy(() =>
  import('./AgentSettingsSheet').then(m => ({ default: m.AgentSettingsSheet })),
)

/**
 * 全局 Agent / Space 设置抽屉宿主。
 *
 * 挂在 AppLayout（Space 工作台 OverlayContainerProvider 之外），避免从侧边栏等
 * 全局入口打开时被画布 scoped overlay 限制在内容区内。
 */
export const GlobalAgentSettingsSheetHost: React.FC = () => {
  const { isOpen, spaceId } = useAgentSettingsSheetStore(
    useShallow(s => ({ isOpen: s.isOpen, spaceId: s.spaceId })),
  )

  if (!isOpen || !spaceId) return null

  return (
    <React.Suspense fallback={null}>
      <LazyAgentSettingsSheet spaceId={spaceId} />
    </React.Suspense>
  )
}

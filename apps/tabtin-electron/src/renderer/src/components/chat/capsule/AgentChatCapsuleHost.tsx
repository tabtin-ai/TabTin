/**
 * AgentChatCapsuleHost —— app-focus 聊天胶囊/悬浮面板的状态编排。
 * 展开态在 useUIStore（临时态，按 scopeKey 隔离）；未读基线在本组件（进入
 * app-focus 时初始化，收起面板时刷新）。
 *
 * 草稿→正式会话的展开态 / taskViewMode 由 rehomeConversationScopeLayout 在
 * provision 写指针前同步迁移；Host 不再在 scopeKey 变化后补迁，避免草稿偏好
 * 已清理时把正式会话的 app-focus 反向覆盖为默认 chat-focus。
 *
 * 网页标签与文档等页统一走主窗 fixed 层叠：依赖浏览器容器为
 * webview（DOM 合成）。WCV 原生层盖不住主窗浮层——不再为胶囊开 overlay 支线。
 */
import React, { useCallback, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useUIStore } from '@stores/useUIStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { AgentChatCapsule } from './AgentChatCapsule'
import { AgentChatOverlay } from './AgentChatOverlay'
import {
  AgentChatCapsulePositioner,
  AgentChatOverlayPositioner,
} from './AgentChatFloatingPositioners'
import { captureTaskViewModeMorph } from './chatCapsuleMorph'
import type { CapsuleSize } from './agentChatCapsulePlacement'

export interface AgentChatCapsuleHostProps {
  scopeKey: string
  sessionId: string | null
  agentId: string | null
  agentName: string | null
  spaceContext: SpaceContext
  organizationId?: string | null
}

export const AgentChatCapsuleHost: React.FC<AgentChatCapsuleHostProps> = ({
  scopeKey,
  sessionId,
  agentId,
  agentName,
  spaceContext,
  organizationId,
}) => {
  const overlayOpen = useUIStore(s => !!s.appFocusChatOverlayOpenByScopeKey[scopeKey])
  const setOverlayOpen = useUIStore(s => s.setAppFocusChatOverlayOpen)
  const capsulePlacement = useUIStore(s => s.agentChatCapsulePlacement)
  const setCapsulePlacement = useUIStore(s => s.setAgentChatCapsulePlacement)
  const [seenUntilTs, setSeenUntilTs] = useState(() => Date.now())
  const [capsuleSize, setCapsuleSize] = useState<CapsuleSize>({
    width: 240,
    height: 48,
  })
  const handleExpand = useCallback(() => {
    setOverlayOpen(scopeKey, true)
  }, [scopeKey, setOverlayOpen])

  const handleCollapse = useCallback(() => {
    setSeenUntilTs(Date.now())
    setOverlayOpen(scopeKey, false)
  }, [scopeKey, setOverlayOpen])

  const handleCapsuleSizeChange = useCallback((next: CapsuleSize) => {
    setCapsuleSize(current => (
      Math.abs(current.width - next.width) < 0.5
      && Math.abs(current.height - next.height) < 0.5
        ? current
        : next
    ))
  }, [])

  const handleBackToSplit = useCallback(() => {
    // 必须在关面板 / 切布局之前 capture（此时 overlay 仍在 DOM）
    captureTaskViewModeMorph('app-focus', 'split')
    setOverlayOpen(scopeKey, false)
    useSpaceViewPrefsStore.getState().setTaskViewModeForScope(scopeKey, 'split')
  }, [scopeKey, setOverlayOpen])

  return (
    <AnimatePresence>
      {overlayOpen ? (
        <AgentChatOverlayPositioner
          key="overlay"
          placement={capsulePlacement}
          capsuleSize={capsuleSize}
        >
          {({ transformOrigin }) => (
            <AgentChatOverlay
              spaceContext={spaceContext}
              organizationId={organizationId}
              transformOrigin={transformOrigin}
              onCollapse={handleCollapse}
              onBackToSplit={handleBackToSplit}
            />
          )}
        </AgentChatOverlayPositioner>
      ) : (
        <AgentChatCapsulePositioner
          key="capsule"
          placement={capsulePlacement}
          onPlacementChange={setCapsulePlacement}
          onActivate={handleExpand}
          onCapsuleSizeChange={handleCapsuleSizeChange}
        >
          {({ dragging, onActivate, resolveMorphTargetRect }) => (
            <AgentChatCapsule
              sessionId={sessionId}
              agentId={agentId}
              agentName={agentName}
              seenUntilTs={seenUntilTs}
              dragging={dragging}
              resolveMorphTargetRect={resolveMorphTargetRect}
              onExpand={onActivate}
            />
          )}
        </AgentChatCapsulePositioner>
      )}
    </AnimatePresence>
  )
}

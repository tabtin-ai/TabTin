import type { ReactNode } from 'react'
import type { AskUserAnswer, AskUserQuestion } from '@tabtin/chat-client'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { LoginRelayAction } from './LoginRelayAction'

interface LoginWallDevicePanelProps {
  spaceId: string
  threadId: string
  domain: string
  tabId?: string
  questions: AskUserQuestion[]
  onRelayComplete: (answers: AskUserAnswer[]) => void
  onSkip?: () => void
  children: ReactNode
}

/** 登录墙操作按设备职责互斥展示：遥控端接力，执行端原地处理。 */
export function LoginWallDevicePanel({
  spaceId,
  threadId,
  domain,
  tabId,
  questions,
  onRelayComplete,
  onSkip,
  children,
}: LoginWallDevicePanelProps): ReactNode {
  const { isRemoteViewer, isResolving } = useIsRemoteViewer(spaceId)

  if (isResolving) return null
  if (!isRemoteViewer) return children

  return (
    <LoginRelayAction
      spaceId={spaceId}
      threadId={threadId}
      domain={domain}
      tabId={tabId}
      questions={questions}
      onRelayComplete={onRelayComplete}
      onSkip={onSkip}
    />
  )
}

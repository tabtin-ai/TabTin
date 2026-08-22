/**
 * 消息相对时间叶子 —— 订阅 MessageTimeTickContext，tick 变化时只重渲本节点。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { formatTime } from '@utils/chat/messageTime'
import { useMessageTimeTick } from '../../MessageTimeTickContext'

export const MessageRelativeTimestamp = React.memo(function MessageRelativeTimestamp({
  createdAt,
}: {
  createdAt: string
}): React.ReactElement | null {
  useMessageTimeTick()
  const { t, i18n } = useTranslation('chat')
  if (!createdAt) return null
  const label = formatTime(createdAt, t, i18n.language)
  if (!label) return null
  return <span className="shrink-0">{label}</span>
})

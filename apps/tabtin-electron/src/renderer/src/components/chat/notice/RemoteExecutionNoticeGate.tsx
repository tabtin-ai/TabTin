/**
 * 遥控器 / 执行设备不可达时再挂 RemoteExecutionNotice。
 * 主对话与分屏共用同一门闩，避免两处手写 isRemoteViewer || isBlocked。
 */

import React from 'react'
import { RemoteExecutionNotice } from './RemoteExecutionNotice'
import type { useRemoteExecutionGate } from '../hooks/useRemoteExecutionGate'

type RemoteGate = ReturnType<typeof useRemoteExecutionGate>

interface RemoteExecutionNoticeGateProps {
  gate: RemoteGate
  compact?: boolean
}

export const RemoteExecutionNoticeGate: React.FC<RemoteExecutionNoticeGateProps> = ({
  gate,
  compact,
}) => {
  if (!gate.isRemoteViewer && !gate.isBlocked) return null
  return (
    <RemoteExecutionNotice
      controlDeviceName={gate.controlDeviceName}
      isOffline={gate.controlDeviceOffline}
      compact={compact}
    />
  )
}

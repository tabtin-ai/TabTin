import React, { useCallback } from 'react'
import {
  useTrackerEventStream,
  type UseTrackerEventStreamOptions,
} from '@hooks/useTrackerEventStream'
import { useTrackerStore } from '@/stores/useTrackerStore'
import { useSpaceStore } from '@stores/useSpaceStore'

// Module F 决策 3：每个可访问 Space 起一个独立 hook 实例订阅 tracker.events.{spaceId}。
// 用子组件 map 是因为 React hook 不能在循环里直接调用——把每个 Space 包成
// `<TrackerSpaceStreamSubscription />`，让 React 按 spaceId 稳定挂载/卸载。
export type TrackerRunTerminalHandlers = Pick<
  UseTrackerEventStreamOptions,
  'onProgress' | 'onRunCompleted' | 'onRunFailed' | 'onRunCancelled'
>

interface TrackerSpaceStreamsProps {
  spaceIds: string[]
  enabled: boolean
  handlers: TrackerRunTerminalHandlers
}

export function TrackerSpaceStreams({ spaceIds, enabled, handlers }: TrackerSpaceStreamsProps) {
  if (!enabled || spaceIds.length === 0) {
    return null
  }

  return (
    <>
      {spaceIds.map(sid => (
        <TrackerSpaceStreamSubscription
          key={sid}
          spaceId={sid}
          enabled={enabled}
          handlers={handlers}
        />
      ))}
    </>
  )
}

interface TrackerSpaceStreamSubscriptionProps {
  spaceId: string
  enabled: boolean
  handlers: TrackerRunTerminalHandlers
}

function TrackerSpaceStreamSubscription({
  spaceId,
  enabled,
  handlers,
}: TrackerSpaceStreamSubscriptionProps) {
  const patchTaskFromWS = useTrackerStore.getState().patchTaskFromWS
  const removeTaskFromWS = useTrackerStore.getState().removeTaskFromWS

  const handleTrackerChanged = useCallback(
    (payload: { tracker_id?: string }) => {
      if (payload.tracker_id) {
        const organizationId = useSpaceStore.getState().spaces
          .find(space => space.id === spaceId)?.organization_id
        void patchTaskFromWS(
          payload.tracker_id,
          organizationId ? { organizationId } : undefined,
        )
      }
    },
    [patchTaskFromWS, spaceId],
  )
  const handleTrackerDeleted = useCallback(
    (payload: { tracker_id?: string }) => {
      if (payload.tracker_id) {
        removeTaskFromWS(payload.tracker_id)
      }
    },
    [removeTaskFromWS],
  )

  useTrackerEventStream({
    spaceId,
    enabled,
    onTrackerCreated: handleTrackerChanged,
    onTrackerUpdated: handleTrackerChanged,
    onTrackerDeleted: handleTrackerDeleted,
    onProgress: handlers.onProgress,
    onRunCompleted: handlers.onRunCompleted,
    onRunFailed: handlers.onRunFailed,
    onRunCancelled: handlers.onRunCancelled,
  })
  return null
}

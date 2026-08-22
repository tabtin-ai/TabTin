import React, { createContext, useContext, useMemo } from 'react'
import { useWorkbenchSceneStore, type SpaceSceneActivity, type WorkbenchSceneId, toWorkbenchSceneId } from '@/stores/useWorkbenchSceneStore'

interface WorkbenchLifecycleValue {
  foregroundSceneId: WorkbenchSceneId | null
  hotSceneIds: WorkbenchSceneId[]
  activateForegroundSpace: (spaceId: string) => void
  syncForegroundSpace: (spaceId: string | null) => void
  getActivityForSpace: (spaceId: string) => SpaceSceneActivity
}

const WorkbenchLifecycleContext = createContext<WorkbenchLifecycleValue | null>(null)

export const WorkbenchLifecycleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const foregroundSceneId = useWorkbenchSceneStore(state => state.foregroundSceneId)
  const hotSceneIds = useWorkbenchSceneStore(state => state.hotSceneIds)
  const activateForegroundSpace = useWorkbenchSceneStore(state => state.activateForegroundSpace)
  const syncForegroundSpace = useWorkbenchSceneStore(state => state.syncForegroundSpace)
  const getSceneActivity = useWorkbenchSceneStore(state => state.getSceneActivity)

  const value = useMemo<WorkbenchLifecycleValue>(() => ({
    foregroundSceneId,
    hotSceneIds,
    activateForegroundSpace,
    syncForegroundSpace,
    getActivityForSpace: (spaceId: string) => getSceneActivity(toWorkbenchSceneId(spaceId)),
  }), [
    foregroundSceneId,
    hotSceneIds,
    activateForegroundSpace,
    syncForegroundSpace,
    getSceneActivity,
  ])

  return (
    <WorkbenchLifecycleContext.Provider value={value}>
      {children}
    </WorkbenchLifecycleContext.Provider>
  )
}

export function useWorkbenchLifecycle(): WorkbenchLifecycleValue {
  const value = useContext(WorkbenchLifecycleContext)
  if (!value) {
    throw new Error('useWorkbenchLifecycle must be used within WorkbenchLifecycleProvider')
  }
  return value
}

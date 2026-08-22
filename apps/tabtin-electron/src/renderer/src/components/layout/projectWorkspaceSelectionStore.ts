import { create } from 'zustand'

export interface PendingProjectTaskFocus {
  projectId: string
  taskId: string
  requestId: number
}

let nextTaskFocusRequestId = 1

interface ProjectWorkspaceSelectionState {
  selectedProjectId: string | null
  activeTaskSessionId: string | null
  pendingTaskFocus: PendingProjectTaskFocus | null
  orchestrationSessionByProjectId: Record<string, {
    sessionId: string
    started: boolean
  }>
  setSelectedProjectId: (projectId: string | null) => void
  openTaskSession: (sessionId: string) => void
  closeTaskSession: () => void
  requestTaskFocus: (projectId: string, taskId: string) => void
  consumePendingTaskFocus: (projectId: string, requestId?: number) => string | null
  setOrchestrationSession: (projectId: string, sessionId: string) => void
  setOrchestrationStarted: (projectId: string, sessionId: string, started: boolean) => void
  /** ：切组织时清 Project 沉浸 / 任务焦点，避免新组织仍挂旧 projectId */
  resetForOrganizationSwitch: () => void
}

export const useProjectWorkspaceSelectionStore = create<ProjectWorkspaceSelectionState>((set, get) => ({
  selectedProjectId: null,
  activeTaskSessionId: null,
  pendingTaskFocus: null,
  orchestrationSessionByProjectId: {},
  setSelectedProjectId: (selectedProjectId) => set((state) => ({
    selectedProjectId,
    activeTaskSessionId: state.selectedProjectId === selectedProjectId
      ? state.activeTaskSessionId
      : null,
  })),
  openTaskSession: (activeTaskSessionId) => set({ activeTaskSessionId }),
  closeTaskSession: () => set({ activeTaskSessionId: null }),
  requestTaskFocus: (projectId, taskId) => {
    if (!projectId || !taskId) return
    set({
      pendingTaskFocus: {
        projectId,
        taskId,
        requestId: nextTaskFocusRequestId++,
      },
    })
  },
  consumePendingTaskFocus: (projectId, requestId) => {
    const current = get().pendingTaskFocus
    if (!current || current.projectId !== projectId) return null
    if (requestId !== undefined && current.requestId !== requestId) return null
    set({ pendingTaskFocus: null })
    return current.taskId
  },
  setOrchestrationSession: (projectId, sessionId) => set((state) => ({
    orchestrationSessionByProjectId: {
      ...state.orchestrationSessionByProjectId,
      [projectId]: { sessionId, started: false },
    },
  })),
  setOrchestrationStarted: (projectId, sessionId, started) => set((state) => {
    const current = state.orchestrationSessionByProjectId[projectId]
    if (!current || current.sessionId !== sessionId) return state
    return {
      orchestrationSessionByProjectId: {
        ...state.orchestrationSessionByProjectId,
        [projectId]: { sessionId, started },
      },
    }
  }),
  resetForOrganizationSwitch: () => set({
    selectedProjectId: null,
    activeTaskSessionId: null,
    pendingTaskFocus: null,
    orchestrationSessionByProjectId: {},
  }),
}))

/** @store-category ui */

/**
 * useSpaceAgentDialogStore — 全局「创建 / 编辑 Space」Dialog 状态
 *
 * CreateSpaceDialog 通过 AppLayout 全局宿主渲染，避免落在画布 scoped overlay 内。
 */

import { create } from 'zustand'
import { useSpaceStore } from '@stores/useSpaceStore'

export type SpaceAgentDialogMode = 'create' | 'edit'

export interface DaemonWorkspaceCreateTarget {
  installationId: string
  deviceName: string
}

/** 创建成功后由调用方接管结果；提供时不再自动打开新任务。 */
export interface SpaceCreateRequestOptions {
  onCreated?: (spaceId: string) => void
}

export interface SpaceAgentDialogStore {
  isOpen: boolean
  mode: SpaceAgentDialogMode
  spaceId: string | null
  daemonTarget: DaemonWorkspaceCreateTarget | null
  createOptions: SpaceCreateRequestOptions | null

  openCreate: (options?: SpaceCreateRequestOptions) => void
  openCreateForDaemon: (
    target: DaemonWorkspaceCreateTarget,
    options?: SpaceCreateRequestOptions,
  ) => void
  openEdit: (spaceId: string) => void
  close: () => void
  setOpen: (open: boolean) => void
}

const CLOSED_CREATE_STATE = {
  isOpen: false,
  mode: 'create' as const,
  spaceId: null,
  daemonTarget: null,
  createOptions: null,
}

export const useSpaceAgentDialogStore = create<SpaceAgentDialogStore>()((set) => ({
  isOpen: false,
  mode: 'create',
  spaceId: null,
  daemonTarget: null,
  createOptions: null,

  openCreate: (options) =>
    set({
      isOpen: true,
      mode: 'create',
      spaceId: null,
      daemonTarget: null,
      createOptions: options ?? null,
    }),

  openCreateForDaemon: (daemonTarget, options) =>
    set({
      isOpen: true,
      mode: 'create',
      spaceId: null,
      daemonTarget,
      createOptions: options ?? null,
    }),

  openEdit: (spaceId) => {
    //  / ：编辑弹窗预拉当前身份，不再从 Workspace.agent 推导
    const selectedAgentId = useSpaceStore.getState().selectedAgent?.id ?? null
    if (selectedAgentId) {
      void useSpaceStore.getState().loadAgent(selectedAgentId, { force: true })
    }
    set({ isOpen: true, mode: 'edit', spaceId, daemonTarget: null, createOptions: null })
  },

  close: () => set(CLOSED_CREATE_STATE),

  setOpen: (open) => {
    if (!open) {
      set(CLOSED_CREATE_STATE)
    } else {
      set({ isOpen: true })
    }
  },
}))

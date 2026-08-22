/** @store-category domain */

/**
 * Tins Store (Zustand)
 *
 * 管理 Tin 列表、实例、激活状态和 UI 状态。
 */

import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import * as tinsApi from '../services/tinsApi'
import type { TinDefinition, TinListItem, TinInstance } from '../services/tinsApi'
import { useOrganizationStore } from './useOrganizationStore'
import { registerResetAction } from './sessionResetRegistry'
import { onOrganizationSelected as onOrganizationSelected } from './organizationLifecycleEvents'
import { clearTinsSessionCache } from '@/services/tinsAgentSessionCache'
import { createLogger } from '@/utils/logger'

const log = createLogger('Tins')

// ─── 激活状态（来自主进程 TinManager）────────────

export interface TinActivationState {
  instanceId: string
  tinId: string
  name: string
  isActive: boolean
  activatedAt?: number
  panelVisible: boolean
}

// ─── Store 类型 ──────────────────────────────────

function getOrganizationId(): string {
  return useOrganizationStore.getState().getEffectiveOrganizationId() || ''
}

interface TinsState {
  tins: TinListItem[]
  instances: TinInstance[]
  isLoading: boolean
  loadError: string | null
  _loadSeq: number
  _detailSeq: number

  selectedTinId: string | null
  tinDetail: TinDefinition | null

  activationStates: TinActivationState[]

  editorOpen: boolean
  editorTinId: string | null

  resetForOrganizationSwitch: () => void
  loadTins: (organizationId: string, spaceId?: string) => Promise<void>
  loadInstances: (organizationId: string, spaceId: string) => Promise<void>
  loadTinDetail: (tinId: string) => Promise<void>

  selectTin: (tinId: string | null) => void
  openEditor: (tinId: string | null) => void
  closeEditor: () => void

  activateTin: (tinId: string) => Promise<void>
  disableTin: (tinId: string) => Promise<void>
  deleteTin: (tinId: string) => Promise<void>

  installTin: (tinId: string, spaceId: string) => Promise<void>
  uninstallTin: (instanceId: string) => Promise<void>
  toggleInstanceEnabled: (instanceId: string, enabled: boolean) => Promise<void>
  toggleInstancePinned: (instanceId: string, pinned: boolean) => Promise<void>

  setActivationStates: (states: TinActivationState[]) => void
  togglePanel: (instanceId: string) => void
  syncInstancesToMain: () => void
}

export const useTinsStore = create<TinsState>((set, get) => ({
  tins: [],
  instances: [],
  isLoading: false,
  loadError: null,
  _loadSeq: 0,
  _detailSeq: 0,

  selectedTinId: null,
  tinDetail: null,

  activationStates: [],

  editorOpen: false,
  editorTinId: null,

  resetForOrganizationSwitch: () => {
    set({
      tins: [],
      instances: [],
      activationStates: [],
      tinDetail: null,
      selectedTinId: null,
      isLoading: false,
      loadError: null,
      _loadSeq: 0,
      _detailSeq: 0,
      editorOpen: false,
      editorTinId: null,
    })
    window.tabtin?.tins?.setInstances([])
  },

  // ── 数据加载 ──────────────────────────────

  loadTins: async (organizationId, spaceId) => {
    const seq = get()._loadSeq + 1
    set({ tins: [], isLoading: true, loadError: null, _loadSeq: seq })
    try {
      const result = await tinsApi.listTins(organizationId, { spaceId })
      if (get()._loadSeq !== seq) return
      set({ tins: result.tins, isLoading: false })
    } catch (e) {
      if (get()._loadSeq !== seq) return
      log.error('Failed to load tins:', { organizationId, spaceId: spaceId ?? null, error: e })
      set({ loadError: (e as Error).message, isLoading: false })
    }
  },

  loadInstances: async (organizationId, spaceId) => {
    const seq = get()._loadSeq
    set({ instances: [] })
    try {
      const result = await tinsApi.listInstances(organizationId, spaceId)
      if (get()._loadSeq !== seq) return
      set({ instances: result.instances })
      get().syncInstancesToMain()
    } catch (e) {
      log.error('Failed to load instances:', { organizationId, spaceId, error: e })
    }
  },

  loadTinDetail: async (tinId) => {
    const seq = get()._detailSeq + 1
    set({ _detailSeq: seq })
    try {
      const wsId = getOrganizationId()
      const detail = await tinsApi.getTin(wsId, tinId)
      if (get()._detailSeq !== seq) return
      set({ tinDetail: detail, selectedTinId: tinId })
    } catch (e) {
      log.error('Failed to load tin detail:', { tinId, error: e })
    }
  },

  // ── 选择/编辑器 ──────────────────────────

  selectTin: (tinId) => set({ selectedTinId: tinId }),

  openEditor: (tinId) => set({ editorOpen: true, editorTinId: tinId }),

  closeEditor: () => set({ editorOpen: false, editorTinId: null }),

  // ── 状态管理 ──────────────────────────────

  activateTin: async (tinId) => {
    try {
      const wsId = getOrganizationId()
      const updated = await tinsApi.activateTin(wsId, tinId)
      set((s) => ({
        tins: s.tins.map((t) => (t.id === tinId ? { ...t, status: updated.status } : t)),
      }))
      const tin = get().tins.find((t) => t.id === tinId)
      toast({ title: i18n.t('tins:toast.activateSuccess', { name: tin?.name ?? '' }) })
    } catch (e) {
      log.error('Failed to activate tin:', { tinId, error: e })
      toast({ title: i18n.t('tins:toast.activateFailed'), variant: 'destructive' })
    }
  },

  disableTin: async (tinId) => {
    try {
      const wsId = getOrganizationId()
      const updated = await tinsApi.disableTin(wsId, tinId)
      set((s) => ({
        tins: s.tins.map((t) => (t.id === tinId ? { ...t, status: updated.status } : t)),
      }))
      const tin = get().tins.find((t) => t.id === tinId)
      toast({ title: i18n.t('tins:toast.disableSuccess', { name: tin?.name ?? '' }) })
    } catch (e) {
      log.error('Failed to disable tin:', { tinId, error: e })
      toast({ title: i18n.t('tins:toast.disableFailed'), variant: 'destructive' })
    }
  },

  deleteTin: async (tinId) => {
    try {
      const wsId = getOrganizationId()
      const tin = get().tins.find((t) => t.id === tinId)
      await tinsApi.deleteTin(wsId, tinId)
      set((s) => ({
        tins: s.tins.filter((t) => t.id !== tinId),
        instances: s.instances.filter((i) => i.tin_id !== tinId),
      }))
      toast({ title: i18n.t('tins:toast.deleteSuccess', { name: tin?.name ?? '' }) })
    } catch (e) {
      log.error('Failed to delete tin:', { tinId, error: e })
      toast({ title: i18n.t('tins:toast.deleteFailed'), variant: 'destructive' })
    }
  },

  // ── 实例管理 ──────────────────────────────

  installTin: async (tinId, spaceId) => {
    try {
      const wsId = getOrganizationId()
      const instance = await tinsApi.installTin(wsId, {
        tin_id: tinId,
        spaceId,
      })
      set((s) => ({
        instances: [...s.instances.filter((i) => i.id !== instance.id), instance],
      }))
      get().syncInstancesToMain()
      toast({ title: i18n.t('tins:toast.installSuccess', { name: instance.tin?.name ?? '' }) })
    } catch (e) {
      log.error('Failed to install tin:', { tinId, spaceId, error: e })
      toast({ title: i18n.t('tins:toast.installFailed'), variant: 'destructive' })
    }
  },

  uninstallTin: async (instanceId) => {
    try {
      const wsId = getOrganizationId()
      const instance = get().instances.find((i) => i.id === instanceId)
      await tinsApi.uninstallTin(wsId, instanceId)
      set((s) => ({
        instances: s.instances.filter((i) => i.id !== instanceId),
      }))
      get().syncInstancesToMain()
      toast({ title: i18n.t('tins:toast.uninstallSuccess', { name: instance?.tin?.name ?? '' }) })
    } catch (e) {
      log.error('Failed to uninstall tin:', { instanceId, error: e })
      toast({ title: i18n.t('tins:toast.uninstallFailed'), variant: 'destructive' })
    }
  },

  toggleInstanceEnabled: async (instanceId, enabled) => {
    try {
      const wsId = getOrganizationId()
      await tinsApi.updateInstance(wsId, instanceId, { is_enabled: enabled })
      set((s) => ({
        instances: s.instances.map((i) =>
          i.id === instanceId ? { ...i, is_enabled: enabled } : i
        ),
      }))
      get().syncInstancesToMain()
      const name = get().instances.find((i) => i.id === instanceId)?.tin?.name ?? ''
      toast({
        title: enabled
          ? i18n.t('tins:toast.activateSuccess', { name })
          : i18n.t('tins:toast.disableSuccess', { name }),
      })
    } catch (e) {
      log.error('Failed to toggle instance:', { instanceId, enabled, error: e })
      toast({
        title: enabled
          ? i18n.t('tins:toast.enableFailed')
          : i18n.t('tins:toast.disableFailed'),
        variant: 'destructive',
      })
    }
  },

  toggleInstancePinned: async (instanceId, pinned) => {
    try {
      const wsId = getOrganizationId()
      await tinsApi.updateInstance(wsId, instanceId, { pinned })
      set((s) => ({
        instances: s.instances.map((i) =>
          i.id === instanceId ? { ...i, pinned } : i
        ),
      }))
      get().syncInstancesToMain()
    } catch (e) {
      log.error('Failed to toggle pin:', { instanceId, pinned, error: e })
      toast({ title: i18n.t('tins:toast.pinFailed'), variant: 'destructive' })
    }
  },

  // ── 激活状态同步 ──────────────────────────

  setActivationStates: (states) => set({ activationStates: states }),

  togglePanel: (instanceId) => {
    window.tabtin?.tins?.togglePanel(instanceId)
  },

  // ── 主进程同步 ─────────────────────────────

  syncInstancesToMain: () => {
    const { instances } = get()
    window.tabtin?.tins?.setInstances(instances)
  },
}))

registerResetAction('tins', 'reset', () => {
  useTinsStore.setState({
    tins: [],
    instances: [],
    isLoading: false,
    loadError: null,
    _loadSeq: 0,
    _detailSeq: 0,
    selectedTinId: null,
    tinDetail: null,
    activationStates: [],
    editorOpen: false,
    editorTinId: null,
  })
  window.tabtin?.tins?.setInstances([])
  clearTinsSessionCache()
})

onOrganizationSelected(() => {
  useTinsStore.getState().resetForOrganizationSwitch()
})

/** @store-category domain */

/**
 * Zustand store for Extension management state.
 *
 * connections 按 scope key 分离存储，避免 Organization 面板和 Space 面板
 * 切换时看到旧数据闪烁。
 */

import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'
import { dedupAsync } from '@/stores/organization/helpers'
import {
  listExtensions,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listEventLogs,
  probeConnection as probeConnectionApi,
  ensureBuiltinConnections,
  type ExtensionManifest,
  type ExtensionConnection,
  type WebhookSubscription,
  type EventLog,
  type EventLogListParams,
  type ProbeResult,
  type CreateConnectionPayload,
  type UpdateConnectionPayload,
  type CreateWebhookPayload,
  type UpdateWebhookPayload,
} from '@/services/extensionApi'

interface ScopedConnections {
  connections: ExtensionConnection[]
  loading: boolean
}

interface EventLogState {
  logs: EventLog[]
  total: number
  loading: boolean
}

interface ExtensionState {
  extensions: ExtensionManifest[]
  extensionsLoading: boolean

  /** Connections keyed by scope: "ws:{organizationId}" or "as:{organizationId}:{spaceId}" */
  connectionsByScope: Record<string, ScopedConnections>

  webhooks: WebhookSubscription[]
  webhooksLoading: boolean

  eventLogs: EventLogState

  extensionsError: string | null
  connectionsError: string | null
  webhooksError: string | null

  fetchExtensions: (organizationId: string) => Promise<void>

  /** Fetch organization-level connections (no spaceId filter). */
  fetchConnections: (organizationId: string) => Promise<void>

  /** Fetch both organization-level and space-level connections, merged. */
  fetchConnectionsBothLevels: (organizationId: string, spaceId: string) => Promise<void>

  /** Get connections for a scope. Returns empty array if not loaded. */
  getConnections: (organizationId: string, spaceId?: string) => ExtensionConnection[]
  getConnectionsLoading: (organizationId: string, spaceId?: string) => boolean

  fetchWebhooks: (organizationId: string) => Promise<void>
  fetchEventLogs: (organizationId: string, params?: EventLogListParams) => Promise<void>

  addConnection: (organizationId: string, payload: CreateConnectionPayload) => Promise<ExtensionConnection>
  editConnection: (organizationId: string, id: string, payload: UpdateConnectionPayload) => Promise<void>
  removeConnection: (organizationId: string, id: string) => Promise<void>
  probeConnection: (organizationId: string, connectionId: string) => Promise<ProbeResult>

  addWebhook: (organizationId: string, payload: CreateWebhookPayload) => Promise<WebhookSubscription>
  editWebhook: (organizationId: string, id: string, payload: UpdateWebhookPayload) => Promise<void>
  removeWebhook: (organizationId: string, id: string) => Promise<void>

  clearAll: () => void
}

export function wsScope(organizationId: string) { return `ws:${organizationId}` }
export function asScope(organizationId: string, spaceId: string) { return `as:${organizationId}:${spaceId}` }

const _extInFlight = new Map<string, Promise<void>>()

export const useExtensionStore = create<ExtensionState>((set, get) => ({
  extensions: [],
  extensionsLoading: false,
  connectionsByScope: {},
  webhooks: [],
  webhooksLoading: false,
  eventLogs: { logs: [], total: 0, loading: false },
  extensionsError: null,
  connectionsError: null,
  webhooksError: null,

  fetchExtensions: async (organizationId) => {
    await dedupAsync(_extInFlight, `ext:${organizationId}`, async () => {
      set({ extensionsLoading: true, extensionsError: null })
      try {
        const res = await listExtensions(organizationId)
        set({ extensions: res.extensions, extensionsLoading: false })
        ensureBuiltinConnections(organizationId)
          .then((r) => {
            if (r.created > 0) {
              get().fetchConnections(organizationId)
              const prefix = `as:${organizationId}:`
              for (const key of Object.keys(get().connectionsByScope)) {
                if (key.startsWith(prefix)) {
                  const spaceId = key.slice(prefix.length)
                  get().fetchConnectionsBothLevels(organizationId, spaceId)
                }
              }
            }
          })
          .catch(() => { /* silent */ })
      } catch (err) {
        set({ extensionsError: err instanceof Error ? err.message : 'Failed to load extensions', extensionsLoading: false })
      }
    })
  },

  fetchConnections: async (organizationId) => {
    await dedupAsync(_extInFlight, `conn:${wsScope(organizationId)}`, async () => {
      const key = wsScope(organizationId)
      set((s) => ({
        connectionsByScope: { ...s.connectionsByScope, [key]: { connections: s.connectionsByScope[key]?.connections ?? [], loading: true } },
        connectionsError: null,
      }))
      try {
        const res = await listConnections(organizationId)
        set((s) => ({
          connectionsByScope: { ...s.connectionsByScope, [key]: { connections: res.connections, loading: false } },
        }))
      } catch (err) {
        set((s) => ({
          connectionsByScope: { ...s.connectionsByScope, [key]: { connections: s.connectionsByScope[key]?.connections ?? [], loading: false } },
          connectionsError: err instanceof Error ? err.message : 'Failed to load connections',
        }))
      }
    })
  },

  fetchConnectionsBothLevels: async (organizationId, spaceId) => {
    await dedupAsync(_extInFlight, `conn:${asScope(organizationId, spaceId)}`, async () => {
      const key = asScope(organizationId, spaceId)
      set((s) => ({
        connectionsByScope: { ...s.connectionsByScope, [key]: { connections: s.connectionsByScope[key]?.connections ?? [], loading: true } },
        connectionsError: null,
      }))
      try {
        const [wsRes, asRes] = await Promise.all([
          listConnections(organizationId),
          listConnections(organizationId, spaceId),
        ])
        const seen = new Set<string>()
        const merged: ExtensionConnection[] = []
        for (const c of [...asRes.connections, ...wsRes.connections]) {
          if (!seen.has(c.id)) { seen.add(c.id); merged.push(c) }
        }
        set((s) => ({
          connectionsByScope: { ...s.connectionsByScope, [key]: { connections: merged, loading: false } },
        }))
      } catch (err) {
        set((s) => ({
          connectionsByScope: { ...s.connectionsByScope, [key]: { connections: s.connectionsByScope[key]?.connections ?? [], loading: false } },
          connectionsError: err instanceof Error ? err.message : 'Failed to load connections',
        }))
      }
    })
  },

  getConnections: (organizationId, spaceId?) => {
    const key = spaceId ? asScope(organizationId, spaceId) : wsScope(organizationId)
    return get().connectionsByScope[key]?.connections ?? []
  },

  getConnectionsLoading: (organizationId, spaceId?) => {
    const key = spaceId ? asScope(organizationId, spaceId) : wsScope(organizationId)
    return get().connectionsByScope[key]?.loading ?? false
  },

  fetchWebhooks: async (organizationId) => {
    set({ webhooksLoading: true, webhooksError: null })
    try {
      const res = await listWebhooks(organizationId)
      set({ webhooks: res.webhooks, webhooksLoading: false })
    } catch (err) {
      set({ webhooksError: err instanceof Error ? err.message : 'Failed to load webhooks', webhooksLoading: false })
    }
  },

  fetchEventLogs: async (organizationId, params?) => {
    set((s) => ({ eventLogs: { ...s.eventLogs, loading: true } }))
    try {
      const res = await listEventLogs(organizationId, params)
      set({ eventLogs: { logs: res.logs, total: res.total, loading: false } })
    } catch {
      set((s) => ({
        eventLogs: { ...s.eventLogs, loading: false },
      }))
    }
  },

  addConnection: async (organizationId, payload) => {
    const res = await createConnection(organizationId, payload)
    const conn = res.connection
    const key = conn.space_id ? asScope(organizationId, conn.space_id) : wsScope(organizationId)
    set((s) => {
      const existing = s.connectionsByScope[key]?.connections ?? []
      return { connectionsByScope: { ...s.connectionsByScope, [key]: { connections: [...existing, conn], loading: false } } }
    })
    return conn
  },

  editConnection: async (organizationId, id, payload) => {
    const res = await updateConnection(organizationId, id, payload)
    const updated = res.connection
    set((s) => {
      const next = { ...s.connectionsByScope }
      for (const [scopeKey, scopeData] of Object.entries(next)) {
        const idx = scopeData.connections.findIndex((c) => c.id === id)
        if (idx !== -1) {
          next[scopeKey] = { ...scopeData, connections: scopeData.connections.map((c) => (c.id === id ? updated : c)) }
        }
      }
      return { connectionsByScope: next }
    })
  },

  probeConnection: async (organizationId, connectionId) => {
    const res = await probeConnectionApi(organizationId, connectionId)
    const updated = res.connection
    set((s) => {
      const next = { ...s.connectionsByScope }
      for (const [scopeKey, scopeData] of Object.entries(next)) {
        const idx = scopeData.connections.findIndex((c) => c.id === connectionId)
        if (idx !== -1) {
          next[scopeKey] = { ...scopeData, connections: scopeData.connections.map((c) => (c.id === connectionId ? updated : c)) }
        }
      }
      return { connectionsByScope: next }
    })
    return res.probe
  },

  removeConnection: async (organizationId, id) => {
    await deleteConnection(organizationId, id)
    set((s) => {
      const next = { ...s.connectionsByScope }
      for (const [scopeKey, scopeData] of Object.entries(next)) {
        if (scopeData.connections.some((c) => c.id === id)) {
          next[scopeKey] = { ...scopeData, connections: scopeData.connections.filter((c) => c.id !== id) }
        }
      }
      return { connectionsByScope: next }
    })
  },

  addWebhook: async (organizationId, payload) => {
    const res = await createWebhook(organizationId, payload)
    set((s) => ({ webhooks: [...s.webhooks, res.webhook] }))
    return res.webhook
  },

  editWebhook: async (organizationId, id, payload) => {
    const res = await updateWebhook(organizationId, id, payload)
    set((s) => ({
      webhooks: s.webhooks.map((w) => (w.id === id ? res.webhook : w)),
    }))
  },

  removeWebhook: async (organizationId, id) => {
    await deleteWebhook(organizationId, id)
    set((s) => ({ webhooks: s.webhooks.filter((w) => w.id !== id) }))
  },

  clearAll: () => {
    _extInFlight.clear()
    set({
      extensions: [],
      extensionsLoading: false,
      connectionsByScope: {},
      webhooks: [],
      webhooksLoading: false,
      eventLogs: { logs: [], total: 0, loading: false },
      extensionsError: null,
      connectionsError: null,
      webhooksError: null,
    })
  },
}))

registerResetAction('extension', 'reset', () => useExtensionStore.getState().clearAll())

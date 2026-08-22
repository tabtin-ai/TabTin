/**
 * Selector hook for extension connections.
 * Uses shallow equality on the connections array reference to prevent unnecessary re-renders
 * when unrelated slices of useExtensionStore change.
 *
 * Prepared for upcoming consumer migration (Round 7+). Currently AgentExtensionsPanel and
 * OrganizationExtensionsPanel still use useExtensionStore() directly.
 */
import { useShallow } from 'zustand/react/shallow'
import { useExtensionStore, wsScope, asScope } from '@stores/useExtensionStore'
import type { ExtensionConnection } from '@/services/extensionApi'

const EMPTY_CONNECTIONS: ExtensionConnection[] = []

export function useConnections(organizationId: string, spaceId?: string): {
  connections: ExtensionConnection[]
  loading: boolean
} {
  return useExtensionStore(
    useShallow((s) => {
      const key = spaceId
        ? asScope(organizationId, spaceId)
        : wsScope(organizationId)
      const scoped = s.connectionsByScope[key]
      return {
        connections: scoped?.connections ?? EMPTY_CONNECTIONS,
        loading: scoped?.loading ?? false,
      }
    }),
  )
}

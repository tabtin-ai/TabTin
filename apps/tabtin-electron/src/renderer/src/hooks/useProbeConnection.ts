/**
 * Shared hook for probing extension connections.
 * Eliminates duplicated probe state in AgentExtensionsPanel and ExtensionCatalogSection.
 */
import { useState, useCallback } from 'react'
import { useExtensionStore } from '@stores/useExtensionStore'

export interface ProbeResultState {
  connId: string
  ok: boolean
  error?: string | null
  latency?: number | null
}

export function useProbeConnection(organizationId: string) {
  const probeConnection = useExtensionStore((s) => s.probeConnection)

  const [probingConnId, setProbingConnId] = useState<string | null>(null)
  const [probeResult, setProbeResult] = useState<ProbeResultState | null>(null)

  const handleProbe = useCallback(
    async (connId: string) => {
      setProbingConnId(connId)
      setProbeResult(null)
      try {
        const result = await probeConnection(organizationId, connId)
        setProbeResult({ connId, ok: result.ok, error: result.error, latency: result.latency_ms })
      } catch (err) {
        setProbeResult({
          connId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setProbingConnId((prev) => (prev === connId ? null : prev))
      }
    },
    [organizationId, probeConnection],
  )

  return { probingConnId, probeResult, handleProbe }
}

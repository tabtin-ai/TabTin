import type { HostRuntimeSnapshot } from '@tabtin/shared'
import type { CoreCliNamespaceSummary } from '@/services/runtimeSnapshot'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'

export interface CapabilityDiscoveryBackendSummary {
  space_id: string
  organization_id: string
  generated_at: string
  backend_type: string
  space_device_binding: {
    bound_device_id?: string | null
    control_device_id?: string | null
    execution_agent_id?: string | null
  }
  execution_binding: {
    bound: boolean
    binding_source: string
    device_id?: string | null
    device_fingerprint?: string | null
    device_name?: string | null
    device_type?: string | null
    device_status?: string | null
    last_heartbeat_at?: string | null
    refresh_transport: string
    can_refresh_via_backend: boolean
    can_refresh_locally: boolean
    reason_codes: string[]
  }
  execution_snapshot: {
    available: boolean
    observed_at?: string | null
    freshness_state: string
    stale_reason?: string | null
    reason_codes: string[]
    snapshot_version?: number | null
    snapshot_source?: string | null
    runtime_tools_count: number
    mcp_tools_count: number
    snapshot?: HostRuntimeSnapshot | null
  }
}

export interface CapabilityDiscoverySummary {
  generated_at: string
  backend: CapabilityDiscoveryBackendSummary | null
  local_host: {
    fingerprint: string
    runtime_snapshot: HostRuntimeSnapshot
    core_cli: CoreCliNamespaceSummary[]
    local_mcp_connections: LocalMcpConnectionSummary[]
  }
}

export interface CapabilityRefreshSummary {
  local: boolean
  result: {
    status?: string
    reason_code?: string
  }
  summary?: CapabilityDiscoverySummary
}

export interface RuntimeToolGroup {
  label: string
  tools: string[]
}

export interface ExtensionCliGroup {
  extensionId: string
  extensionName: string
  commands: import('@/services/extensionApi').ExtensionCliCommandDescriptor[]
  connected: boolean
}

export type OutcomeState = 'available' | 'fallback' | 'blocked' | 'unknown'

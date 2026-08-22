type JsonContract = {
  version: number
  namespaces: {
    leaf: string[]
    container: string[]
  }
  discoverySources: string[]
  snapshotSources: string[]
  mountStates: string[]
  availabilityStates: string[]
  freshnessStates: string[]
  policyStates: string[]
  reasonCodes: string[]
}

export const CAPABILITY_DISCOVERY_CONTRACT: JsonContract = {
  version: 1,
  namespaces: {
    leaf: [
      'runtime_tool',
      'core_cli',
      'extension_cli',
      'mcp_tool',
    ],
    container: [
      'skill',
      'subagent',
      'extension',
      'mcp_attachment',
    ],
  },
  discoverySources: [
    'declared_catalog',
    'observed_registry',
    'observed_health',
    'space_config',
    'execution_snapshot',
    'local_discovery',
  ],
  snapshotSources: [
    'electron',
    'daemon',
    'android',
    'ios',
    'unknown',
  ],
  mountStates: [
    'mounted',
    'unmounted',
    'partial',
    'unknown',
  ],
  availabilityStates: [
    'available',
    'degraded',
    'unavailable',
    'unknown',
  ],
  freshnessStates: [
    'fresh',
    'refreshing',
    'stale',
    'expired',
    'unknown',
  ],
  policyStates: [
    'allowed',
    'restricted',
    'blocked',
    'unknown',
  ],
  reasonCodes: [
    'ok',
    'space_unbound',
    'binding_missing',
    'binding_switched',
    'backend_external',
    'snapshot_missing',
    'snapshot_stale',
    'snapshot_expired',
    'refresh_supported',
    'refresh_requested',
    'refresh_inflight',
    'refresh_timeout',
    'refresh_forbidden',
    'refresh_unsupported',
    'refresh_offline',
    'refresh_failed',
    'device_offline',
    'device_busy',
    'device_unknown',
    'device_mismatch',
    'policy_restricted',
    'policy_blocked',
    'mount_missing',
    'connection_missing',
    'attachment_missing',
    'visibility_filtered',
    'runtime_not_registered',
    'mcp_not_running',
    'cli_not_installed',
    'unsupported_version',
    'source_partial_error',
    'legacy_snapshot',
    'unknown',
  ],
}

export type CapabilityLeafNamespace =
  | 'runtime_tool'
  | 'core_cli'
  | 'extension_cli'
  | 'mcp_tool'

export type CapabilityContainerNamespace =
  | 'skill'
  | 'subagent'
  | 'extension'
  | 'mcp_attachment'

export type CapabilityNamespace =
  | CapabilityLeafNamespace
  | CapabilityContainerNamespace

export type CapabilityDiscoverySource =
  | 'declared_catalog'
  | 'observed_registry'
  | 'observed_health'
  | 'space_config'
  | 'execution_snapshot'
  | 'local_discovery'

export type RuntimeSnapshotSource =
  | 'electron'
  | 'daemon'
  | 'android'
  | 'ios'
  | 'unknown'

export type CapabilityMountState =
  | 'mounted'
  | 'unmounted'
  | 'partial'
  | 'unknown'

export type CapabilityAvailabilityState =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown'

export type CapabilityFreshnessState =
  | 'fresh'
  | 'refreshing'
  | 'stale'
  | 'expired'
  | 'unknown'

export type CapabilityPolicyState =
  | 'allowed'
  | 'restricted'
  | 'blocked'
  | 'unknown'

export type CapabilityDiscoveryReasonCode =
  | 'ok'
  | 'space_unbound'
  | 'binding_missing'
  | 'binding_switched'
  | 'backend_external'
  | 'snapshot_missing'
  | 'snapshot_stale'
  | 'snapshot_expired'
  | 'refresh_supported'
  | 'refresh_requested'
  | 'refresh_inflight'
  | 'refresh_timeout'
  | 'refresh_forbidden'
  | 'refresh_unsupported'
  | 'refresh_offline'
  | 'refresh_failed'
  | 'device_offline'
  | 'device_busy'
  | 'device_unknown'
  | 'device_mismatch'
  | 'policy_restricted'
  | 'policy_blocked'
  | 'mount_missing'
  | 'connection_missing'
  | 'attachment_missing'
  | 'visibility_filtered'
  | 'runtime_not_registered'
  | 'mcp_not_running'
  | 'cli_not_installed'
  | 'unsupported_version'
  | 'source_partial_error'
  | 'legacy_snapshot'
  | 'unknown'

export type CapabilityId = `${CapabilityNamespace}:${string}`

export interface RuntimeSnapshotToolItem {
  capability_id: CapabilityId
  name: string
  observed_at?: string
  reason_codes?: CapabilityDiscoveryReasonCode[]
  metadata?: Record<string, unknown>
}

export interface RuntimeSnapshotMcpToolItem {
  capability_id: CapabilityId
  name: string
  source_name?: string
  observed_at?: string
  reason_codes?: CapabilityDiscoveryReasonCode[]
  metadata?: Record<string, unknown>
}

export interface RuntimeSnapshotMcpStatus {
  running: boolean
  subtype?: string
  tools: RuntimeSnapshotMcpToolItem[]
  port?: number
  endpoint?: string
  error?: string
  observed_at?: string
  reason_codes?: CapabilityDiscoveryReasonCode[]
  metadata?: Record<string, unknown>
}

export interface CreativeEngineStatus {
  ready?: boolean
  /** Module is loaded but has no direct tool invocations (e.g. doc_editor). */
  module_loaded?: boolean
}

export interface CreativeEnginesSnapshot {
  design_export: CreativeEngineStatus
  doc_editor: CreativeEngineStatus
  video_export: CreativeEngineStatus
  /**
   * Motion-graphics video rendering capability (action-tools
   * `tabvideo_render_mg`). Distinct from `video_export` because the headless
   * tool registry gates on this key separately —
   * see `packages/action-tools/src/tools/tabvideo-headless/_meta.ts`.
   */
  video_render_mg?: CreativeEngineStatus
}

export interface HostRuntimeSnapshot {
  version: number
  source: RuntimeSnapshotSource
  reported_at: string
  runtime_tools: RuntimeSnapshotToolItem[]
  mcp_server?: RuntimeSnapshotMcpStatus
  reason_codes?: CapabilityDiscoveryReasonCode[]
  metadata?: Record<string, unknown>
  creative_engines?: CreativeEnginesSnapshot
}

export interface CapabilityDiscoveryItem {
  capability_id: CapabilityId
  namespace: CapabilityNamespace
  name: string
  title?: string
  description?: string
  leaf: boolean
  source: CapabilityDiscoverySource
  mount_state: CapabilityMountState
  availability_state: CapabilityAvailabilityState
  freshness_state: CapabilityFreshnessState
  policy_state: CapabilityPolicyState
  reason_codes: CapabilityDiscoveryReasonCode[]
  observed_at?: string
  can_refresh?: boolean
  metadata?: Record<string, unknown>
}

export interface CapabilityDiscoverySummary {
  items: CapabilityDiscoveryItem[]
  generated_at: string
  execution_device_id?: string | null
  execution_device_name?: string | null
  backend_type?: string
  reason_codes?: CapabilityDiscoveryReasonCode[]
}

export const CAPABILITY_DISCOVERY_SNAPSHOT_VERSION = CAPABILITY_DISCOVERY_CONTRACT.version
export const CAPABILITY_LEAF_NAMESPACES = CAPABILITY_DISCOVERY_CONTRACT.namespaces.leaf as CapabilityLeafNamespace[]
export const CAPABILITY_CONTAINER_NAMESPACES = CAPABILITY_DISCOVERY_CONTRACT.namespaces.container as CapabilityContainerNamespace[]
export const CAPABILITY_DISCOVERY_SOURCES = CAPABILITY_DISCOVERY_CONTRACT.discoverySources as CapabilityDiscoverySource[]
export const CAPABILITY_RUNTIME_SOURCES = CAPABILITY_DISCOVERY_CONTRACT.snapshotSources as RuntimeSnapshotSource[]
export const CAPABILITY_MOUNT_STATES = CAPABILITY_DISCOVERY_CONTRACT.mountStates as CapabilityMountState[]
export const CAPABILITY_AVAILABILITY_STATES = CAPABILITY_DISCOVERY_CONTRACT.availabilityStates as CapabilityAvailabilityState[]
export const CAPABILITY_FRESHNESS_STATES = CAPABILITY_DISCOVERY_CONTRACT.freshnessStates as CapabilityFreshnessState[]
export const CAPABILITY_POLICY_STATES = CAPABILITY_DISCOVERY_CONTRACT.policyStates as CapabilityPolicyState[]
export const CAPABILITY_REASON_CODES = CAPABILITY_DISCOVERY_CONTRACT.reasonCodes as CapabilityDiscoveryReasonCode[]

const CAPABILITY_NAMESPACE_SET = new Set<string>([
  ...CAPABILITY_LEAF_NAMESPACES,
  ...CAPABILITY_CONTAINER_NAMESPACES,
])
const CAPABILITY_REASON_CODE_SET = new Set<string>(CAPABILITY_REASON_CODES)
const CAPABILITY_RUNTIME_SOURCE_SET = new Set<string>(CAPABILITY_RUNTIME_SOURCES)

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .replace(/^tabtin:/, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')
}

function normalizeReasonCodes(value: unknown): CapabilityDiscoveryReasonCode[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((code): code is string => typeof code === 'string' && CAPABILITY_REASON_CODE_SET.has(code))
    .map(code => code as CapabilityDiscoveryReasonCode)
}

function parseCapabilityToolItem(
  namespace: CapabilityLeafNamespace,
  raw: unknown,
  observedAt: string,
  owner?: string,
): RuntimeSnapshotToolItem | RuntimeSnapshotMcpToolItem | null {
  if (typeof raw === 'string') {
    const name = sanitizeSegment(raw)
    if (!name) return null
    const capabilityId = buildCapabilityId(namespace, name, owner)
    return {
      capability_id: capabilityId,
      name,
      observed_at: observedAt || undefined,
    }
  }

  if (!raw || typeof raw !== 'object') return null

  const record = raw as Record<string, unknown>
  const rawName = typeof record.name === 'string'
    ? record.name
    : typeof record.tool === 'string'
      ? record.tool
      : typeof record.id === 'string'
        ? record.id
        : ''
  const name = sanitizeSegment(rawName)
  if (!name) return null

  const capabilityId = typeof record.capability_id === 'string' && isCapabilityId(record.capability_id)
    ? record.capability_id
    : buildCapabilityId(namespace, name, owner)

  const base = {
    capability_id: capabilityId,
    name,
    observed_at: typeof record.observed_at === 'string' ? record.observed_at : (observedAt || undefined),
    reason_codes: normalizeReasonCodes(record.reason_codes),
    metadata: isPlainObject(record.metadata) ? record.metadata : undefined,
  }

  if (namespace === 'mcp_tool') {
    return {
      ...base,
      source_name: typeof record.source_name === 'string' ? record.source_name : undefined,
    }
  }

  return base
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRuntimeToolItems(value: unknown, reportedAt: string): RuntimeSnapshotToolItem[] {
  if (!Array.isArray(value)) return []

  const items: RuntimeSnapshotToolItem[] = []
  for (const raw of value) {
    const item = parseCapabilityToolItem('runtime_tool', raw, reportedAt)
    if (item) {
      items.push(item as RuntimeSnapshotToolItem)
    }
  }
  return dedupeToolItems(items)
}

function normalizeMcpToolItems(value: unknown, reportedAt: string, owner?: string): RuntimeSnapshotMcpToolItem[] {
  if (!Array.isArray(value)) return []

  const items: RuntimeSnapshotMcpToolItem[] = []
  for (const raw of value) {
    const item = parseCapabilityToolItem('mcp_tool', raw, reportedAt, owner)
    if (item) {
      items.push(item as RuntimeSnapshotMcpToolItem)
    }
  }
  return dedupeToolItems(items)
}

function dedupeToolItems<T extends { capability_id: CapabilityId }>(items: T[]): T[] {
  const seen = new Set<CapabilityId>()
  const result: T[] = []
  for (const item of items) {
    if (seen.has(item.capability_id)) continue
    seen.add(item.capability_id)
    result.push(item)
  }
  return result
}

export function isCapabilityId(value: string): value is CapabilityId {
  const index = value.indexOf(':')
  if (index <= 0) return false
  const namespace = value.slice(0, index)
  const key = value.slice(index + 1)
  return CAPABILITY_NAMESPACE_SET.has(namespace) && Boolean(key)
}

export function isLeafCapabilityNamespace(value: string): value is CapabilityLeafNamespace {
  return CAPABILITY_LEAF_NAMESPACES.includes(value as CapabilityLeafNamespace)
}

export function isContainerCapabilityNamespace(value: string): value is CapabilityContainerNamespace {
  return CAPABILITY_CONTAINER_NAMESPACES.includes(value as CapabilityContainerNamespace)
}

export function buildCapabilityId(
  namespace: CapabilityNamespace,
  name: string,
  owner?: string | null,
): CapabilityId {
  const normalizedName = sanitizeSegment(name)
  if (!normalizedName) {
    throw new Error(`capability name is required for namespace ${namespace}`)
  }

  const normalizedOwner = sanitizeSegment(owner ?? '')
  const suffix = normalizedOwner ? `${normalizedOwner}/${normalizedName}` : normalizedName
  return `${namespace}:${suffix}`
}

export function parseCapabilityId(value: string): {
  namespace: CapabilityNamespace
  owner?: string
  name: string
} | null {
  if (!isCapabilityId(value)) return null

  const [namespace, suffix] = value.split(':', 2)
  const lastSlash = suffix.lastIndexOf('/')
  if (lastSlash === -1) {
    return {
      namespace: namespace as CapabilityNamespace,
      name: suffix,
    }
  }

  return {
    namespace: namespace as CapabilityNamespace,
    owner: suffix.slice(0, lastSlash) || undefined,
    name: suffix.slice(lastSlash + 1),
  }
}

export const capabilityIdBuilders = {
  runtimeTool(name: string): CapabilityId {
    return buildCapabilityId('runtime_tool', name)
  },
  coreCli(name: string): CapabilityId {
    return buildCapabilityId('core_cli', name)
  },
  extensionCli(extensionId: string, name: string): CapabilityId {
    return buildCapabilityId('extension_cli', name, extensionId)
  },
  mcpTool(sourceName: string, name: string): CapabilityId {
    return buildCapabilityId('mcp_tool', name, sourceName)
  },
  skill(skillId: string): CapabilityId {
    return buildCapabilityId('skill', skillId)
  },
  subagent(templateId: string): CapabilityId {
    return buildCapabilityId('subagent', templateId)
  },
  extension(extensionId: string): CapabilityId {
    return buildCapabilityId('extension', extensionId)
  },
  mcpAttachment(connectionId: string): CapabilityId {
    return buildCapabilityId('mcp_attachment', connectionId)
  },
}

export function createRuntimeToolItems(names: string[], reportedAt = ''): RuntimeSnapshotToolItem[] {
  return normalizeRuntimeToolItems(names, reportedAt)
}

export function createMcpToolItems(
  names: string[],
  reportedAt = '',
  owner = 'builtin',
): RuntimeSnapshotMcpToolItem[] {
  return normalizeMcpToolItems(names, reportedAt, owner)
}

export function normalizeHostRuntimeSnapshot(
  raw: unknown,
  fallbackSource: RuntimeSnapshotSource = 'unknown',
): HostRuntimeSnapshot | null {
  if (!isPlainObject(raw)) return null

  const record = raw as Record<string, unknown>
  const reportedAt = typeof record.reported_at === 'string' ? record.reported_at : ''
  const source = typeof record.source === 'string' && CAPABILITY_RUNTIME_SOURCE_SET.has(record.source)
    ? record.source as RuntimeSnapshotSource
    : fallbackSource
  const version = typeof record.version === 'number' && Number.isFinite(record.version)
    ? Math.max(0, Math.trunc(record.version))
    : 0
  const reasonCodes = normalizeReasonCodes(record.reason_codes)
  if (version === 0 && !reasonCodes.includes('legacy_snapshot')) {
    reasonCodes.push('legacy_snapshot')
  }

  const runtimeTools = normalizeRuntimeToolItems(record.runtime_tools, reportedAt)

  let mcpServer: RuntimeSnapshotMcpStatus | undefined
  if (isPlainObject(record.mcp_server)) {
    const rawMcp = record.mcp_server as Record<string, unknown>
    const toolOwner = typeof rawMcp.subtype === 'string' ? rawMcp.subtype : 'builtin'
    mcpServer = {
      running: rawMcp.running === true,
      subtype: typeof rawMcp.subtype === 'string' ? rawMcp.subtype : undefined,
      tools: normalizeMcpToolItems(rawMcp.tools, reportedAt, toolOwner),
      port: typeof rawMcp.port === 'number' ? rawMcp.port : undefined,
      endpoint: typeof rawMcp.endpoint === 'string' ? rawMcp.endpoint : undefined,
      error: typeof rawMcp.error === 'string' ? rawMcp.error : undefined,
      observed_at: typeof rawMcp.observed_at === 'string' ? rawMcp.observed_at : (reportedAt || undefined),
      reason_codes: normalizeReasonCodes(rawMcp.reason_codes),
      metadata: isPlainObject(rawMcp.metadata) ? rawMcp.metadata : undefined,
    }
  }

  return {
    version,
    source,
    reported_at: reportedAt,
    runtime_tools: runtimeTools,
    ...(mcpServer ? { mcp_server: mcpServer } : {}),
    ...(reasonCodes.length > 0 ? { reason_codes: reasonCodes } : {}),
    ...(isPlainObject(record.metadata) ? { metadata: record.metadata } : {}),
    ...(isPlainObject(record.creative_engines) ? { creative_engines: record.creative_engines as unknown as CreativeEnginesSnapshot } : {}),
  }
}

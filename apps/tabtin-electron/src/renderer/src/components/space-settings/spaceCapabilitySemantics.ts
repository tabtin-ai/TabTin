import {
  capabilityIdBuilders,
  type CapabilityAvailabilityState,
  type CapabilityDiscoveryItem,
  type CapabilityDiscoveryReasonCode,
} from '@tabtin/shared'
import type { SkillIndexEntry } from '@/skills/types'
import type { SubAgentTemplate } from '@/services/subagentTemplateApi'
import type {
  ExtensionConnection,
  ExtensionManifest,
} from '@/services/extensionApi'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'

type ContainerNamespace = 'skill' | 'subagent' | 'extension' | 'mcp_attachment'

export type SpaceCapabilityItem = CapabilityDiscoveryItem & {
  namespace: ContainerNamespace
  title: string
}

export interface SpaceCapabilitySemanticsResult {
  items: SpaceCapabilityItem[]
  skills: SpaceCapabilityItem[]
  visibleSkills: SpaceCapabilityItem[]
  subagents: SpaceCapabilityItem[]
  enabledSubagents: SpaceCapabilityItem[]
  disabledSubagents: SpaceCapabilityItem[]
  extensions: SpaceCapabilityItem[]
  connectedExtensions: SpaceCapabilityItem[]
  inheritedConnectedExtensions: SpaceCapabilityItem[]
  partiallyConnectedExtensions: SpaceCapabilityItem[]
  disconnectedExtensions: SpaceCapabilityItem[]
  mcpAttachments: SpaceCapabilityItem[]
  attachedMcpAttachments: SpaceCapabilityItem[]
  activeAttachedMcpAttachments: SpaceCapabilityItem[]
  inactiveAttachedMcpAttachments: SpaceCapabilityItem[]
}

interface BuildSpaceCapabilitySemanticsOptions {
  spaceId: string
  agentId?: string
  skills: SkillIndexEntry[]
  subagents: SubAgentTemplate[]
  extensions: ExtensionManifest[]
  connections: ExtensionConnection[]
  localMcpConnections: LocalMcpConnectionSummary[]
}

function dedupeReasonCodes(codes: CapabilityDiscoveryReasonCode[]): CapabilityDiscoveryReasonCode[] {
  return Array.from(new Set(codes))
}

function buildBaseItem({
  capabilityId,
  namespace,
  name,
  title,
  description,
  mountState,
  availabilityState,
  reasonCodes = [],
  observedAt,
  metadata,
}: {
  capabilityId: CapabilityDiscoveryItem['capability_id']
  namespace: ContainerNamespace
  name: string
  title: string
  description?: string
  mountState: CapabilityDiscoveryItem['mount_state']
  availabilityState: CapabilityAvailabilityState
  reasonCodes?: CapabilityDiscoveryReasonCode[]
  observedAt?: string
  metadata?: Record<string, unknown>
}): SpaceCapabilityItem {
  return {
    capability_id: capabilityId,
    namespace,
    name,
    title,
    description,
    leaf: false,
    source: 'space_config',
    mount_state: mountState,
    availability_state: availabilityState,
    freshness_state: 'fresh',
    policy_state: 'allowed',
    reason_codes: dedupeReasonCodes(reasonCodes),
    observed_at: observedAt,
    metadata,
  }
}

function formatSkillTitle(skill: SkillIndexEntry): string {
  return `${skill.emoji ? `${skill.emoji} ` : ''}${skill.name || skill.skill_id}`.trim()
}

function formatSubagentTitle(template: SubAgentTemplate): string {
  return `${template.icon ? `${template.icon} ` : ''}${template.name}`.trim()
}

function formatExtensionTitle(extension: ExtensionManifest): string {
  return `${extension.icon ? `${extension.icon} ` : ''}${extension.name}`.trim()
}

function formatMcpAttachmentTitle(connection: LocalMcpConnectionSummary): string {
  return `${connection.name} · ${connection.source.label}`.trim()
}

function resolveExtensionAvailability(connection: ExtensionConnection | null): CapabilityAvailabilityState {
  if (!connection) return 'unavailable'
  if (!connection.enabled) return 'unavailable'
  if (connection.status === 'error' || connection.status === 'connecting' || connection.status === 'disconnected') {
    return 'degraded'
  }
  return 'available'
}

function resolveExtensionMountState(connection: ExtensionConnection | null): CapabilityDiscoveryItem['mount_state'] {
  if (!connection) return 'unmounted'
  if (!connection.enabled) return 'unmounted'
  if (!connection.status || connection.status === 'connected') return 'mounted'
  return 'partial'
}

export function buildSpaceCapabilitySemantics({
  spaceId,
  agentId,
  skills,
  subagents,
  extensions,
  connections,
  localMcpConnections,
}: BuildSpaceCapabilitySemanticsOptions): SpaceCapabilitySemanticsResult {
  const skillItems = skills.map(skill => buildBaseItem({
    capabilityId: capabilityIdBuilders.skill(skill.skill_id),
    namespace: 'skill',
    name: skill.skill_id,
    title: formatSkillTitle(skill),
    description: skill.description,
    mountState: 'mounted',
    availabilityState: 'available',
    metadata: {
      source: skill.source,
      status: skill.status ?? null,
      skill_key: skill.skill_key ?? null,
      app_id: skill.app_id ?? null,
      visible: true,
    },
  }))

  const subagentItems = subagents.map(template => buildBaseItem({
    capabilityId: capabilityIdBuilders.subagent(template.id),
    namespace: 'subagent',
    name: template.id,
    title: formatSubagentTitle(template),
    description: template.description,
    mountState: template.is_enabled ? 'mounted' : 'unmounted',
    availabilityState: template.is_enabled ? 'available' : 'unavailable',
    observedAt: template.updated_at ?? template.created_at ?? undefined,
    metadata: {
      enabled: template.is_enabled,
      subagent_type: template.subagent_type,
      model_id: template.model_id,
      default_mode: template.default_mode,
    },
  }))

  const organizationConnectionsByExtensionId = new Map(
    connections
      .filter(connection => !connection.space_id)
      .map(connection => [connection.extension_id, connection] as const),
  )
  const spaceConnectionsByExtensionId = new Map(
    connections
      .filter(connection => connection.space_id === spaceId)
      .map(connection => [connection.extension_id, connection] as const),
  )

  const extensionItems = extensions
    .filter(extension => extension.type !== 'channel')
    .map(extension => {
      const organizationConnection = organizationConnectionsByExtensionId.get(extension.id) ?? null
      const spaceConnection = spaceConnectionsByExtensionId.get(extension.id) ?? null
      const effectiveConnection = spaceConnection ?? organizationConnection
      const inherited = !spaceConnection && Boolean(organizationConnection)
      const mountState = resolveExtensionMountState(effectiveConnection)
      const availabilityState = resolveExtensionAvailability(effectiveConnection)
      const reasonCodes: CapabilityDiscoveryReasonCode[] = []

      if (!effectiveConnection) {
        reasonCodes.push('connection_missing')
      } else if (
        effectiveConnection.last_error
        || effectiveConnection.status === 'error'
        || effectiveConnection.status === 'disconnected'
        || effectiveConnection.status === 'connecting'
      ) {
        reasonCodes.push('source_partial_error')
      }

      return buildBaseItem({
        capabilityId: capabilityIdBuilders.extension(extension.id),
        namespace: 'extension',
        name: extension.id,
        title: formatExtensionTitle(extension),
        description: extension.description,
        mountState,
        availabilityState,
        reasonCodes,
        observedAt: effectiveConnection?.updated_at ?? undefined,
        metadata: {
          inherited,
          extension_name: extension.name,
          extension_type: extension.type,
          connection_id: effectiveConnection?.id ?? null,
          connection_scope: spaceConnection ? 'space' : organizationConnection ? 'organization' : 'none',
          connection_enabled: effectiveConnection?.enabled ?? false,
          connection_status: effectiveConnection?.status ?? null,
          last_error: effectiveConnection?.last_error ?? null,
          has_cli: extension.capabilities?.has_cli ?? false,
        },
      })
    })

  const mcpAttachmentItems = localMcpConnections.map(connection => {
    const attached = Boolean(agentId && connection.attachedAgentIds.includes(agentId))
    const enabled = connection.enabled
    const probeOk = connection.lastProbe?.ok
    const reasonCodes: CapabilityDiscoveryReasonCode[] = []

    if (!attached) reasonCodes.push('attachment_missing')
    if (enabled && probeOk === false) reasonCodes.push('source_partial_error')

    return buildBaseItem({
      capabilityId: capabilityIdBuilders.mcpAttachment(connection.id),
      namespace: 'mcp_attachment',
      name: connection.id,
      title: formatMcpAttachmentTitle(connection),
      description: connection.transportKind === 'http'
        ? connection.url || undefined
        : connection.command || undefined,
      mountState: attached ? 'mounted' : 'unmounted',
      availabilityState: !enabled
        ? 'unavailable'
        : !connection.lastProbe
          ? 'unknown'
        : probeOk === false
          ? 'degraded'
          : 'available',
      reasonCodes,
      observedAt: connection.updatedAt,
      metadata: {
        attached,
        enabled,
        source_label: connection.source.label,
        transport_kind: connection.transportKind,
        tool_count: connection.lastProbe?.tools.length ?? 0,
        last_probe_ok: probeOk ?? null,
      },
    })
  })

  const enabledSubagents = subagentItems.filter(item => item.mount_state === 'mounted')
  const disabledSubagents = subagentItems.filter(item => item.mount_state !== 'mounted')
  const connectedExtensions = extensionItems.filter(item => item.mount_state === 'mounted')
  const inheritedConnectedExtensions = connectedExtensions.filter(item => item.metadata?.inherited === true)
  const partiallyConnectedExtensions = extensionItems.filter(item => item.mount_state === 'partial')
  const disconnectedExtensions = extensionItems.filter(item => item.mount_state !== 'mounted')
  const attachedMcpAttachments = mcpAttachmentItems.filter(item => item.mount_state === 'mounted')
  const activeAttachedMcpAttachments = attachedMcpAttachments.filter(item => item.availability_state === 'available')
  const inactiveAttachedMcpAttachments = attachedMcpAttachments.filter(item => item.availability_state !== 'available')

  return {
    items: [
      ...skillItems,
      ...subagentItems,
      ...extensionItems,
      ...mcpAttachmentItems,
    ],
    skills: skillItems,
    visibleSkills: skillItems,
    subagents: subagentItems,
    enabledSubagents,
    disabledSubagents,
    extensions: extensionItems,
    connectedExtensions,
    inheritedConnectedExtensions,
    partiallyConnectedExtensions,
    disconnectedExtensions,
    mcpAttachments: mcpAttachmentItems,
    attachedMcpAttachments,
    activeAttachedMcpAttachments,
    inactiveAttachedMcpAttachments,
  }
}

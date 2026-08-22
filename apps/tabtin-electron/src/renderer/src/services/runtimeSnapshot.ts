import type { Device } from '@tabtin/app-shell'
import {
  CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
  capabilityIdBuilders,
  createRuntimeToolItems,
  normalizeHostRuntimeSnapshot,
  type CapabilityId,
  type HostRuntimeSnapshot,
} from '@tabtin/shared'

export interface CoreCliNamespaceSummary {
  capability_id: CapabilityId
  name: string
  description: string
  examples: string[]
}

export async function fetchCoreCliNamespaces(): Promise<CoreCliNamespaceSummary[]> {
  const catalog = await window.tabtin.cli.getCoreCommandCatalog() as Array<{
    name?: string
    description?: string
    examples?: string[]
  }>

  return (Array.isArray(catalog) ? catalog : []).map(command => ({
    name: typeof command?.name === 'string' ? command.name : '',
    description: typeof command?.description === 'string' ? command.description : '',
    examples: Array.isArray(command?.examples)
      ? command.examples.filter((item): item is string => typeof item === 'string')
      : [],
  })).filter(command => command.name).map(command => ({
    ...command,
    capability_id: capabilityIdBuilders.coreCli(command.name),
  }))
}

export async function collectCurrentHostRuntimeSnapshot(): Promise<HostRuntimeSnapshot> {
  const runtimeTools = await window.tabtin.agent.getRegisteredTools()
  const reportedAt = new Date().toISOString()

  return {
    version: CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
    source: 'electron',
    reported_at: reportedAt,
    runtime_tools: createRuntimeToolItems(
      Array.isArray(runtimeTools) ? runtimeTools : [],
      reportedAt,
    ),
  }
}

export function readDeviceHostRuntimeSnapshot(device: Device | null | undefined): HostRuntimeSnapshot | null {
  const raw = device?.os_info?.runtime?.host_runtime_snapshot
  const fallbackSource = (() => {
    const deviceType = typeof device?.device_type === 'string' ? device.device_type : 'unknown'
    if (deviceType === 'electron' || deviceType === 'daemon') return deviceType
    const osPlatform = typeof device?.os_info?.platform === 'string'
      ? device.os_info.platform.toLowerCase()
      : ''
    if (osPlatform === 'android') return 'android'
    if (osPlatform === 'ios') return 'ios'
    return 'unknown'
  })()
  return normalizeHostRuntimeSnapshot(raw, fallbackSource)
}

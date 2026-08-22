export interface PersonalPluginSourceRef {
  kind: 'codex-compatible-directory' | 'github'
  uri: string
  repoUrl?: string
  ref?: string
  versionPin?: string
  commit?: string
}

export interface PersonalPluginOfficialReleaseMetadata {
  id: string
  version: string
  channel: 'stable' | 'preview'
  catalogVersion?: string
}

export interface PersonalPluginUpstreamMetadata {
  packageName: string
  version: string
  repository?: string
  commit?: string
  sourcePath?: string
}

export interface PersonalPluginOfficialAdapterMetadata {
  id: string
  version: string
}

export interface PersonalPluginCapabilityManifest {
  plugin: {
    id: string
    name?: string
    description?: string
    version?: string
  }
  source: PersonalPluginSourceRef
  skills: Array<{ id: string; path: string; skillMdPath: string }>
  mcp?: { path: string; serverCount: number; raw: unknown }
  declaredHooks: Array<{ id: string; sourcePath: string; event?: string; command?: string; raw: unknown }>
  scripts: string[]
  assets: string[]
  apps: unknown[]
  localServices: unknown[]
  files: {
    codexPluginJson?: string
    mcpJson?: string
    hooksJson?: string
  }
  warnings: string[]
}

export interface InstalledPersonalPluginRecord {
  pluginId: string
  source: PersonalPluginSourceRef
  versionPin?: string
  commit?: string
  upstream?: PersonalPluginUpstreamMetadata
  officialRelease?: PersonalPluginOfficialReleaseMetadata
  adapter?: PersonalPluginOfficialAdapterMetadata
  installPath: string
  installedAt: string
  capabilityManifest: PersonalPluginCapabilityManifest
}

export interface PersonalPluginEnablementRecord extends InstalledPersonalPluginRecord {
  enabled: boolean
  enablementUpdatedAt?: string
}

export interface PersonalPluginRuntimeStatus {
  runtimeId: string
  state: 'running' | 'stopped'
  organizationId: string
  spaceId: string
  agentId?: string
  pluginId: string
  serviceId?: string
  url?: string
  installPath?: string
  projectDir?: string
  process?: {
    pid?: number
    processId?: string
    command: string
    cwd: string
  }
  mcp?: {
    state: 'attached' | 'detached'
    serverCount: number
    tools: PersonalPluginMcpToolMetadata[]
  }
  startedAt?: string
  stoppedAt?: string
  exitCode?: number | null
  signal?: string | null
}

export interface PersonalPluginMcpToolMetadata {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  isReadOnly: boolean
}

export interface PersonalPluginRuntimeScope {
  organizationId: string
  spaceId: string
  agentId?: string
  pluginId: string
}

export interface PersonalPluginRuntimeLaunchInput extends PersonalPluginRuntimeScope {
  serviceId?: string
  title?: string
  openBrowser?: boolean
  requireMcp?: boolean
}

export interface InstallOfficialPersonalPluginResult {
  status: 'installed' | 'already-installed'
  plugin: InstalledPersonalPluginRecord
}

export interface PersonalPluginUpdateCheckResult {
  status: 'not-official' | 'up-to-date' | 'update-available'
  pluginId: string
  current: {
    releaseId?: string
    version?: string
    upstreamVersion?: string
    upstreamCommit?: string
  }
  candidate?: {
    releaseId: string
    version: string
    channel: 'stable' | 'preview'
    upstream: PersonalPluginUpstreamMetadata
  }
}

function ipcRenderer() {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) {
    throw new Error('Personal Plugin marketplace requires Electron IPC')
  }
  return ipc
}

export async function listInstalledPersonalPlugins(
  organizationId: string,
): Promise<InstalledPersonalPluginRecord[]> {
  return await ipcRenderer().invoke('personal-plugins:list-installed', { organizationId })
}

export async function installOfficialPersonalPlugin(
  organizationId: string,
  pluginId: string,
): Promise<InstallOfficialPersonalPluginResult> {
  return await ipcRenderer().invoke('personal-plugins:install-official', { organizationId, pluginId })
}

export async function uninstallPersonalPlugin(
  organizationId: string,
  pluginId: string,
): Promise<{ removed: boolean; plugin?: InstalledPersonalPluginRecord }> {
  return await ipcRenderer().invoke('personal-plugins:uninstall', { organizationId, pluginId })
}

export async function listPersonalPluginEnablement(
  organizationId: string,
  spaceId: string,
): Promise<PersonalPluginEnablementRecord[]> {
  return await ipcRenderer().invoke('personal-plugins:list-enablement', { organizationId, spaceId })
}

export async function setPersonalPluginEnabled(
  organizationId: string,
  spaceId: string,
  pluginId: string,
  enabled: boolean,
): Promise<PersonalPluginEnablementRecord> {
  return await ipcRenderer().invoke('personal-plugins:set-enabled', {
    organizationId,
    spaceId,
    pluginId,
    enabled,
  })
}

export async function launchPersonalPluginRuntime(
  input: PersonalPluginRuntimeLaunchInput,
): Promise<PersonalPluginRuntimeStatus> {
  return await ipcRenderer().invoke('personal-plugins:launch-runtime', input)
}

export async function getPersonalPluginRuntimeStatus(
  input: PersonalPluginRuntimeScope,
): Promise<PersonalPluginRuntimeStatus> {
  return await ipcRenderer().invoke('personal-plugins:get-runtime-status', input)
}

export async function stopPersonalPluginRuntime(
  input: PersonalPluginRuntimeScope,
): Promise<PersonalPluginRuntimeStatus> {
  return await ipcRenderer().invoke('personal-plugins:stop-runtime', input)
}

export async function listPersonalPluginMcpTools(
  input: PersonalPluginRuntimeScope,
): Promise<PersonalPluginMcpToolMetadata[]> {
  return await ipcRenderer().invoke('personal-plugins:list-mcp-tools', input)
}

export async function callPersonalPluginMcpTool(input: PersonalPluginRuntimeScope & {
  toolName: string
  input?: unknown
}): Promise<unknown> {
  return await ipcRenderer().invoke('personal-plugins:call-mcp-tool', input)
}

export async function checkPersonalPluginUpdate(
  organizationId: string,
  pluginId: string,
): Promise<PersonalPluginUpdateCheckResult> {
  return await ipcRenderer().invoke('personal-plugins:check-update', { organizationId, pluginId })
}

export async function confirmPersonalPluginUpdate(
  organizationId: string,
  pluginId: string,
): Promise<InstalledPersonalPluginRecord> {
  return await ipcRenderer().invoke('personal-plugins:confirm-update', { organizationId, pluginId })
}

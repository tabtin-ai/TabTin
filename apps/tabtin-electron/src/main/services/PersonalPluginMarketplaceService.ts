import path from 'node:path'

import { app, BrowserWindow } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  createDefaultPersonalPluginProcessAdapter,
  installPersonalPluginFromCodexDirectory,
  listPersonalPluginEnablement,
  listInstalledPersonalPlugins,
  PersonalPluginRuntimeManager,
  setPersonalPluginEnabled,
  uninstallPersonalPlugin,
  type InstalledPersonalPlugin,
  type PersonalPluginEnablementState,
  type PersonalPluginMcpAttachRequest,
  type PersonalPluginMcpRuntimeAdapter,
  type PersonalPluginMcpRuntimeHandle,
  type PersonalPluginMcpToolMetadata,
  type PersonalPluginOfficialAdapterMetadata,
  type PersonalPluginOfficialReleaseMetadata,
  type PersonalPluginRuntimeStatus,
  type PersonalPluginUpstreamMetadata,
} from '@tabtin/agent-runtime/plugins'
import {
  assertSafeStorageSegment,
  resolveDataRoot,
  resolveSpaceWorkspaceRoot,
  resolveSpacesRoot,
} from '@tabtin/terminal-core'
import { TokenManager } from '../auth.js'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'

const log = createLogger('PersonalPluginMarketplace')

export const OFFICIAL_SUPERPOWERS_PLUGIN_ID = 'superpowers'
export const OFFICIAL_SUPERPOWERS_UPSTREAM_VERSION = '5.1.3'
export const OFFICIAL_SUPERPOWERS_RELEASE_VERSION = '2026.06.23'
export const OFFICIAL_SUPERPOWERS_SOURCE_URI = 'official://tabtin/superpowers'
export const OFFICIAL_COWART_PLUGIN_ID = 'cowart'
export const PERSONAL_PLUGIN_OPEN_BROWSER_CHANNEL = 'personal-plugins:open-browser-url'

interface OfficialPersonalPluginRelease {
  pluginId: string
  displayName: string
  description: string
  sourceUri: string
  sourceDir: () => string
  versionPin: string
  upstream: PersonalPluginUpstreamMetadata
  officialRelease: PersonalPluginOfficialReleaseMetadata
  adapter: PersonalPluginOfficialAdapterMetadata
}

export interface PersonalPluginOfficialUpdateCheckResult {
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
    channel: PersonalPluginOfficialReleaseMetadata['channel']
    upstream: PersonalPluginUpstreamMetadata
  }
}

export interface PersonalPluginMarketplaceInstallInput {
  organizationId: string
  pluginId: string
}

export interface PersonalPluginMarketplaceListInput {
  organizationId: string
}

export interface PersonalPluginEnablementListInput {
  organizationId: string
  spaceId: string
}

export interface PersonalPluginEnablementSetInput {
  organizationId: string
  spaceId: string
  pluginId: string
  enabled: boolean
}

export interface PersonalPluginRuntimeInput {
  organizationId: string
  spaceId: string
  agentId?: string
  pluginId: string
}

export interface PersonalPluginRuntimeLaunchInput extends PersonalPluginRuntimeInput {
  serviceId?: string
  title?: string
  openBrowser?: boolean
  requireMcp?: boolean
}

export interface PersonalPluginMcpToolCallInput extends PersonalPluginRuntimeInput {
  toolName: string
  input?: unknown
}

export interface PersonalPluginUpdateInput {
  organizationId: string
  pluginId: string
}

export interface PersonalPluginMarketplaceInstallResult {
  status: 'installed' | 'already-installed'
  plugin: InstalledPersonalPlugin
}

type PersonalPluginRuntimeController = Pick<PersonalPluginRuntimeManager, 'launch' | 'getStatus' | 'stop'>
  & Partial<Pick<PersonalPluginRuntimeManager, 'listMcpTools' | 'callMcpTool'>>
  & Partial<Pick<PersonalPluginRuntimeManager, 'stopAllForPlugin'>>

export interface PersonalPluginRuntimeServiceDeps {
  runtimeManager?: PersonalPluginRuntimeController
  resolveProjectDir?: (input: { organizationId: string; spaceId: string }) => string
}

function assertOrganizationId(organizationId: unknown): string {
  if (typeof organizationId !== 'string') {
    throw new Error('Personal Plugin install requires a valid organizationId')
  }
  return assertSafeStorageSegment(organizationId.trim(), 'organizationId')
}

function assertSpaceId(spaceId: unknown): string {
  if (typeof spaceId !== 'string') {
    throw new Error('Personal Plugin enablement requires a valid spaceId')
  }
  return assertSafeStorageSegment(spaceId.trim(), 'spaceId')
}

/** （硬切）：解析当前登录用户，供组织级 plugins 落盘；未登录返回 undefined。 */
async function resolvePersonalPluginUserId(): Promise<string | undefined> {
  try {
    const userInfo = await TokenManager.getUserInfo()
    const raw =
      (userInfo?.id as unknown) ??
      (userInfo?.user_id as unknown) ??
      (userInfo?.userId as unknown)
    if (raw === undefined || raw === null || raw === '') return undefined
    return String(raw)
  } catch {
    return undefined
  }
}

/**
 * （硬切）：组织级 Personal Plugin 存储必须要有真实 userId + dataRoot——
 * 未认证直接抛错，不再回落 legacy per-Space 路径。
 */
async function requirePersonalPluginUserId(): Promise<string> {
  const userId = await resolvePersonalPluginUserId()
  if (!userId) {
    throw new Error('Personal Plugin storage requires an authenticated user (not logged in)')
  }
  return userId
}

async function withPersonalPluginStorage<T extends { organizationId: string }>(
  input: T,
): Promise<T & { userId: string; dataRoot: string }> {
  const userId = await requirePersonalPluginUserId()
  return { ...input, userId, dataRoot: resolveDataRoot() }
}

function assertSupportedOfficialPlugin(pluginId: unknown): string {
  if (pluginId !== OFFICIAL_SUPERPOWERS_PLUGIN_ID && pluginId !== OFFICIAL_COWART_PLUGIN_ID) {
    throw new Error(`Unsupported official Personal Plugin: ${String(pluginId)}`)
  }
  return pluginId
}

function assertPluginId(pluginId: unknown): string {
  if (typeof pluginId !== 'string' || !pluginId.trim()) {
    throw new Error('Personal Plugin runtime requires a valid pluginId')
  }
  return pluginId.trim()
}

function defaultResolveProjectDir(input: { organizationId: string; spaceId: string }): string {
  return resolveSpaceWorkspaceRoot(resolveSpacesRoot(), input.organizationId, input.spaceId)
}

type McpServerConfig = {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry
  }
  return result
}

function firstStdioMcpServer(raw: unknown): McpServerConfig | null {
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return null
  for (const server of Object.values(raw.mcpServers)) {
    if (!isRecord(server)) continue
    const command = typeof server.command === 'string' ? server.command.trim() : ''
    if (!command) continue
    return {
      command,
      args: normalizeStringArray(server.args),
      cwd: typeof server.cwd === 'string' && server.cwd.trim() ? server.cwd.trim() : undefined,
      env: normalizeStringMap(server.env),
    }
  }
  return null
}

export function resolvePersonalPluginMcpCwd(installPath: string, cwd: string | undefined): string {
  if (!cwd) return installPath
  const root = path.resolve(installPath)
  const resolved = path.resolve(root, cwd)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Personal Plugin MCP cwd escapes install path: ${cwd}`)
  }
  return resolved
}

function isReadOnlyMcpTool(tool: { annotations?: unknown }): boolean {
  return isRecord(tool.annotations) && tool.annotations.readOnlyHint === true
}

export function createElectronPersonalPluginMcpRuntimeAdapter(): PersonalPluginMcpRuntimeAdapter {
  const sessions = new Map<string, { client: Client; transport: StdioClientTransport }>()

  return {
    async attach(request: PersonalPluginMcpAttachRequest) {
      const server = firstStdioMcpServer(request.mcp.raw)
      if (!server) {
        throw new Error('No stdio MCP server declared in plugin .mcp.json')
      }

      const cwd = resolvePersonalPluginMcpCwd(request.installPath, server.cwd)
      log.info(`MCP attach: runtimeId=${request.runtimeId} command=${server.command}`)
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        cwd,
        env: {
          ...process.env,
          ...server.env,
          ...request.env,
          COWART_PROJECT_DIR: request.projectDir,
          TABTIN_PLUGIN_INSTALL_PATH: request.installPath,
        } as Record<string, string>,
        stderr: 'pipe',
      })
      const client = new Client(
        { name: 'tabtin-personal-plugin-mcp', version: app.getVersion() },
        { capabilities: {} },
      )
      try {
        await client.connect(transport)
      } catch (err) {
        log.error(`MCP attach 连接失败 runtimeId=${request.runtimeId} command=${server.command}:`, err instanceof Error ? err.message : err)
        throw err
      }
      const listed = await client.listTools()
      const handle: PersonalPluginMcpRuntimeHandle = {
        runtimeId: request.runtimeId,
        processId: `mcp:${request.runtimeId}`,
      }
      sessions.set(handle.processId!, { client, transport })
      log.info(`MCP attached: runtimeId=${request.runtimeId} tools=${listed.tools?.length ?? 0}`)
      return {
        handle,
        tools: (listed.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
          isReadOnly: isReadOnlyMcpTool(tool),
        })),
      }
    },
    async detach(handle) {
      const key = handle.processId ?? `mcp:${handle.runtimeId}`
      const session = sessions.get(key)
      sessions.delete(key)
      // close 失败不影响 detach 语义（session 已从 map 移除），但记录以便诊断残留子进程
      await session?.client.close().catch((err) => {
        log.warn(`MCP detach close 失败 key=${key}:`, err instanceof Error ? err.message : err)
      })
    },
    async callTool(request) {
      const key = request.handle.processId ?? `mcp:${request.handle.runtimeId}`
      const session = sessions.get(key)
      if (!session) {
        throw new Error(`Personal Plugin MCP session is not attached: ${request.runtimeId}`)
      }
      return await session.client.callTool({
        name: request.toolName,
        arguments: isRecord(request.input) ? request.input : {},
      })
    },
  }
}

async function findInstalledPersonalPlugin(
  organizationId: string,
  pluginId: string,
): Promise<InstalledPersonalPlugin> {
  const installed = await listMarketplaceInstalledPersonalPlugins({ organizationId })
  const plugin = installed.find((record) => record.pluginId === pluginId)
  if (!plugin) {
    throw new Error(`Personal Plugin is not installed: ${pluginId}`)
  }
  return plugin
}

export function resolveBundledSuperpowersSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'personal-plugins', OFFICIAL_SUPERPOWERS_PLUGIN_ID)
  }

  return path.resolve(
    process.cwd(),
    '../../packages/agent-runtime/fixtures/personal-plugins',
    OFFICIAL_SUPERPOWERS_PLUGIN_ID,
  )
}

export function resolveBundledCowartSourceDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'personal-plugins', OFFICIAL_COWART_PLUGIN_ID)
  }

  return path.resolve(process.cwd(), '../../packages/apps', OFFICIAL_COWART_PLUGIN_ID)
}

function officialPersonalPluginReleases(): Record<string, OfficialPersonalPluginRelease> {
  return {
    [OFFICIAL_SUPERPOWERS_PLUGIN_ID]: {
      pluginId: OFFICIAL_SUPERPOWERS_PLUGIN_ID,
      displayName: 'Superpowers',
      description: 'Official TabTin Personal Plugin bundle for installing reusable agent skills.',
      sourceUri: OFFICIAL_SUPERPOWERS_SOURCE_URI,
      sourceDir: resolveBundledSuperpowersSourceDir,
      versionPin: OFFICIAL_SUPERPOWERS_RELEASE_VERSION,
      upstream: {
        packageName: 'superpowers',
        version: OFFICIAL_SUPERPOWERS_UPSTREAM_VERSION,
        repository: 'https://github.com/obra/superpowers',
        commit: 'superpowers-5.1.3',
      },
      officialRelease: {
        id: 'tabtin-official:superpowers:2026.06.23',
        version: OFFICIAL_SUPERPOWERS_RELEASE_VERSION,
        channel: 'stable',
        catalogVersion: '2026-06-23.preview',
      },
      adapter: {
        id: 'tabtin-superpowers-adapter',
        version: '0.1.0',
      },
    },
    [OFFICIAL_COWART_PLUGIN_ID]: {
      pluginId: OFFICIAL_COWART_PLUGIN_ID,
      displayName: 'Cowart',
      description: 'Official Personal Plugin for a local infinite canvas runtime.',
      sourceUri: 'official://tabtin/cowart',
      sourceDir: resolveBundledCowartSourceDir,
      versionPin: '0.1.2',
      upstream: {
        packageName: 'cowart',
        version: '0.1.2',
        repository: 'https://github.com/zhongerxin/cowart',
        commit: 'v0.1.2',
      },
      officialRelease: {
        id: 'tabtin-official:cowart:0.1.2',
        version: '0.1.2',
        channel: 'stable',
        catalogVersion: '2026-06-23.preview',
      },
      adapter: {
        id: 'tabtin-cowart-adapter',
        version: '0.1.0',
      },
    },
  }
}

function latestOfficialPersonalPluginRelease(pluginId: string): OfficialPersonalPluginRelease {
  const release = officialPersonalPluginReleases()[pluginId]
  if (!release) {
    throw new Error(`Unsupported official Personal Plugin: ${pluginId}`)
  }
  return release
}

function createElectronPersonalPluginRuntimeManager(): PersonalPluginRuntimeManager {
  return new PersonalPluginRuntimeManager({
    processAdapter: createDefaultPersonalPluginProcessAdapter(),
    mcpRuntimeAdapter: createElectronPersonalPluginMcpRuntimeAdapter(),
    browserOpenAdapter: {
      async open(request) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(PERSONAL_PLUGIN_OPEN_BROWSER_CHANNEL, request)
          }
        }
      },
    },
  })
}

const defaultPersonalPluginRuntimeManager = createElectronPersonalPluginRuntimeManager()

export async function listMarketplaceInstalledPersonalPlugins(
  input: PersonalPluginMarketplaceListInput,
): Promise<InstalledPersonalPlugin[]> {
  const organizationId = assertOrganizationId(input.organizationId)
  const storage = await withPersonalPluginStorage({ organizationId })
  return listInstalledPersonalPlugins(storage)
}

export async function installOfficialPersonalPlugin(
  input: PersonalPluginMarketplaceInstallInput,
): Promise<PersonalPluginMarketplaceInstallResult> {
  const organizationId = assertOrganizationId(input.organizationId)
  const pluginId = assertSupportedOfficialPlugin(input.pluginId)
  const release = latestOfficialPersonalPluginRelease(pluginId)
  const existing = await listMarketplaceInstalledPersonalPlugins({ organizationId })
  const installed = existing.find((plugin) => plugin.pluginId === pluginId)
  if (installed) {
    return { status: 'already-installed', plugin: installed }
  }

  log.info(`安装官方插件 pluginId=${pluginId} version=${release.versionPin} organizationId=${organizationId}`)
  let plugin: InstalledPersonalPlugin
  try {
    const storage = await withPersonalPluginStorage({ organizationId })
    plugin = await installPersonalPluginFromCodexDirectory({
      sourceDir: release.sourceDir(),
      sourceUri: release.sourceUri,
      versionPin: release.versionPin,
      upstream: release.upstream,
      officialRelease: release.officialRelease,
      adapter: release.adapter,
      ...storage,
    })
  } catch (err) {
    log.error(`安装官方插件失败 pluginId=${pluginId}:`, err instanceof Error ? err.message : err)
    throw err
  }

  log.info(`安装官方插件完成 pluginId=${pluginId}`)
  return { status: 'installed', plugin }
}

export async function uninstallMarketplacePersonalPlugin(
  input: PersonalPluginUpdateInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): Promise<{ removed: boolean; plugin?: InstalledPersonalPlugin }> {
  const organizationId = assertOrganizationId(input.organizationId)
  const pluginId = assertPluginId(input.pluginId)
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  log.info(`卸载插件 pluginId=${pluginId} organizationId=${organizationId}`)
  try {
    await runtimeManager.stopAllForPlugin?.({
      organizationId,
      pluginId,
    })
    const storage = await withPersonalPluginStorage({ organizationId })
    return await uninstallPersonalPlugin({
      ...storage,
      pluginId,
    })
  } catch (err) {
    log.error(`卸载插件失败 pluginId=${pluginId}:`, err instanceof Error ? err.message : err)
    throw err
  }
}

export async function listAgentPersonalPluginEnablement(
  input: PersonalPluginEnablementListInput,
): Promise<PersonalPluginEnablementState[]> {
  const organizationId = assertOrganizationId(input.organizationId)
  // spaceId 校验仍保留（IPC 入参契约），但组织级存储不再按 spaceId 分桶。
  assertSpaceId(input.spaceId)
  const storage = await withPersonalPluginStorage({ organizationId })
  return listPersonalPluginEnablement(storage)
}

export async function setAgentPersonalPluginEnabled(
  input: PersonalPluginEnablementSetInput,
): Promise<PersonalPluginEnablementState> {
  const organizationId = assertOrganizationId(input.organizationId)
  assertSpaceId(input.spaceId)
  const storage = await withPersonalPluginStorage({ organizationId })
  return setPersonalPluginEnabled({
    ...storage,
    pluginId: input.pluginId,
    enabled: input.enabled === true,
  })
}

export async function launchAgentPersonalPluginRuntime(
  input: PersonalPluginRuntimeLaunchInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): Promise<PersonalPluginRuntimeStatus> {
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  const organizationId = assertOrganizationId(input.organizationId)
  const spaceId = assertSpaceId(input.spaceId)
  const resolveProjectDir = deps.resolveProjectDir ?? defaultResolveProjectDir
  const pluginId = assertPluginId(input.pluginId)
  log.info(`启动插件运行时 pluginId=${pluginId} spaceId=${spaceId} agentId=${input.agentId ?? '-'} requireMcp=${input.requireMcp ?? false}`)
  try {
    const storage = await withPersonalPluginStorage({ organizationId })
    return await runtimeManager.launch({
      ...storage,
      spaceId,
      agentId: input.agentId,
      pluginId,
      projectDir: resolveProjectDir({ organizationId, spaceId }),
      serviceId: input.serviceId,
      title: input.title,
      openBrowser: input.openBrowser,
      requireMcp: input.requireMcp,
    })
  } catch (err) {
    log.error(`启动插件运行时失败 pluginId=${pluginId} spaceId=${spaceId}:`, err instanceof Error ? err.message : err)
    throw err
  }
}

export function getAgentPersonalPluginRuntimeStatus(
  input: PersonalPluginRuntimeInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): PersonalPluginRuntimeStatus {
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  return runtimeManager.getStatus({
    organizationId: assertOrganizationId(input.organizationId),
    spaceId: assertSpaceId(input.spaceId),
    agentId: input.agentId,
    pluginId: assertPluginId(input.pluginId),
  })
}

export async function stopAgentPersonalPluginRuntime(
  input: PersonalPluginRuntimeInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): Promise<PersonalPluginRuntimeStatus> {
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  return runtimeManager.stop({
    organizationId: assertOrganizationId(input.organizationId),
    spaceId: assertSpaceId(input.spaceId),
    agentId: input.agentId,
    pluginId: assertPluginId(input.pluginId),
  })
}

export function listAgentPersonalPluginMcpTools(
  input: PersonalPluginRuntimeInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): PersonalPluginMcpToolMetadata[] {
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  if (!runtimeManager.listMcpTools) return []
  return runtimeManager.listMcpTools({
    organizationId: assertOrganizationId(input.organizationId),
    spaceId: assertSpaceId(input.spaceId),
    agentId: input.agentId,
    pluginId: assertPluginId(input.pluginId),
  })
}

export async function callAgentPersonalPluginMcpTool(
  input: PersonalPluginMcpToolCallInput,
  deps: PersonalPluginRuntimeServiceDeps = {},
): Promise<unknown> {
  const runtimeManager = deps.runtimeManager ?? defaultPersonalPluginRuntimeManager
  if (!runtimeManager.callMcpTool) {
    throw new Error('Personal Plugin MCP tool provider is not configured')
  }
  return runtimeManager.callMcpTool({
    organizationId: assertOrganizationId(input.organizationId),
    spaceId: assertSpaceId(input.spaceId),
    agentId: input.agentId,
    pluginId: assertPluginId(input.pluginId),
    toolName: input.toolName,
    input: input.input,
  })
}

export async function checkMarketplacePersonalPluginUpdate(
  input: PersonalPluginUpdateInput,
): Promise<PersonalPluginOfficialUpdateCheckResult> {
  const organizationId = assertOrganizationId(input.organizationId)
  const pluginId = assertPluginId(input.pluginId)
  const installedPlugin = await findInstalledPersonalPlugin(organizationId, pluginId)
  const current = {
    releaseId: installedPlugin.officialRelease?.id,
    version: installedPlugin.officialRelease?.version,
    upstreamVersion: installedPlugin.upstream?.version,
    upstreamCommit: installedPlugin.upstream?.commit,
  }
  if (!installedPlugin.officialRelease) {
    return { status: 'not-official', pluginId, current }
  }

  const latestRelease = latestOfficialPersonalPluginRelease(pluginId)
  if (installedPlugin.officialRelease.id === latestRelease.officialRelease.id) {
    return { status: 'up-to-date', pluginId, current }
  }

  return {
    status: 'update-available',
    pluginId,
    current,
    candidate: {
      releaseId: latestRelease.officialRelease.id,
      version: latestRelease.officialRelease.version,
      channel: latestRelease.officialRelease.channel,
      upstream: latestRelease.upstream,
    },
  }
}

export async function confirmMarketplacePersonalPluginUpdate(
  input: PersonalPluginUpdateInput,
): Promise<InstalledPersonalPlugin> {
  const organizationId = assertOrganizationId(input.organizationId)
  const pluginId = assertPluginId(input.pluginId)
  const installedPlugin = await findInstalledPersonalPlugin(organizationId, pluginId)
  if (!installedPlugin.officialRelease) {
    throw new Error(`Personal Plugin is not an official release: ${pluginId}`)
  }
  const latestRelease = latestOfficialPersonalPluginRelease(pluginId)
  log.info(`更新官方插件 pluginId=${pluginId} → version=${latestRelease.versionPin}`)
  try {
    const storage = await withPersonalPluginStorage({ organizationId })
    return await installPersonalPluginFromCodexDirectory({
      sourceDir: latestRelease.sourceDir(),
      sourceUri: latestRelease.sourceUri,
      versionPin: latestRelease.versionPin,
      upstream: latestRelease.upstream,
      officialRelease: latestRelease.officialRelease,
      adapter: latestRelease.adapter,
      ...storage,
    })
  } catch (err) {
    log.error(`更新官方插件失败 pluginId=${pluginId}:`, err instanceof Error ? err.message : err)
    throw err
  }
}

export function registerPersonalPluginMarketplaceIpc(): void {
  guardedHandle(
    'personal-plugins:list-installed',
    async (_event, input: PersonalPluginMarketplaceListInput) =>
      listMarketplaceInstalledPersonalPlugins(input),
  )
  guardedHandle(
    'personal-plugins:install-official',
    async (_event, input: PersonalPluginMarketplaceInstallInput) =>
      installOfficialPersonalPlugin(input),
  )
  guardedHandle(
    'personal-plugins:uninstall',
    async (_event, input: PersonalPluginUpdateInput) =>
      uninstallMarketplacePersonalPlugin(input),
  )
  guardedHandle(
    'personal-plugins:list-enablement',
    async (_event, input: PersonalPluginEnablementListInput) =>
      listAgentPersonalPluginEnablement(input),
  )
  guardedHandle(
    'personal-plugins:set-enabled',
    async (_event, input: PersonalPluginEnablementSetInput) =>
      setAgentPersonalPluginEnabled(input),
  )
  guardedHandle(
    'personal-plugins:launch-runtime',
    async (_event, input: PersonalPluginRuntimeLaunchInput) =>
      launchAgentPersonalPluginRuntime(input),
  )
  guardedHandle(
    'personal-plugins:get-runtime-status',
    async (_event, input: PersonalPluginRuntimeInput) =>
      getAgentPersonalPluginRuntimeStatus(input),
  )
  guardedHandle(
    'personal-plugins:stop-runtime',
    async (_event, input: PersonalPluginRuntimeInput) =>
      stopAgentPersonalPluginRuntime(input),
  )
  guardedHandle(
    'personal-plugins:list-mcp-tools',
    async (_event, input: PersonalPluginRuntimeInput) =>
      listAgentPersonalPluginMcpTools(input),
  )
  guardedHandle(
    'personal-plugins:call-mcp-tool',
    async (_event, input: PersonalPluginMcpToolCallInput) =>
      callAgentPersonalPluginMcpTool(input),
  )
  guardedHandle(
    'personal-plugins:check-update',
    async (_event, input: PersonalPluginUpdateInput) =>
      checkMarketplacePersonalPluginUpdate(input),
  )
  guardedHandle(
    'personal-plugins:confirm-update',
    async (_event, input: PersonalPluginUpdateInput) =>
      confirmMarketplacePersonalPluginUpdate(input),
  )
}

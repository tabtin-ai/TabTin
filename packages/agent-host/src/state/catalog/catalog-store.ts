import type { CliCommandInfo } from '../../capabilities/cli.js'
import type { CliCommandSchema } from '@tabtin/agent-runtime/capability'
import type { McpListing } from '../../capabilities/mcp.js'

/**
 * @deprecated ：CLI 目录改为宿主生命周期常驻缓存，不再按时间过期。
 * 保留导出仅兼容旧 import；值为 Infinity。
 */
export const CLI_COMMANDS_CACHE_TTL_MS = Number.POSITIVE_INFINITY
/** spawn / parse 失败后的短退避，避免无旧缓存时打爆进程；成功缓存不受此约束。 */
const CLI_NEGATIVE_BACKOFF_MS = 5_000
const CLI_SPAWN_TIMEOUT_MS = 30_000

/**
 * @deprecated ：MCP 目录改为常驻 + invalidate，不再按时间过期。
 * 保留导出仅兼容旧 import；值为 Infinity。
 */
export const MCP_TOOLS_TTL_MS = Number.POSITIVE_INFINITY

export type CliCommandsSpawnPort = (
  file: string,
  args: readonly string[],
  options: { timeout: number; encoding: BufferEncoding; maxBuffer: number },
) => Promise<{ stdout: string }>

export type CliCommandsMaterializeOptions = {
  timeoutMs?: number
}

interface RawCliCommand extends CliCommandSchema {
  description?: string
  long?: string
  flags?: Array<{ name?: string }>
  hidden?: boolean
  is_group?: boolean
}

function isIncludeHiddenUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  const output = [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase()
  return (
    output.includes('include-hidden')
    && (output.includes('unknown flag') || output.includes('flag provided but not defined'))
  )
}

export interface CliCommandsMaterialized {
  at: number
  listing: { commands: CliCommandInfo[] }
  schemas: ReadonlyArray<CliCommandSchema>
  /** false 表示旧 CLI 只返回可见目录，不得用于受限模式 risk map。 */
  riskSchemasComplete: boolean
}

interface McpToolsCacheEntry {
  at: number
  tools: McpListing['tools']
  serverKey: string
  stale: boolean
}

export type McpToolCacheInvalidation = {
  agentIds?: readonly string[]
  mode: 'drop' | 'stale'
  reason: string
}

export type McpListingPorts = {
  listAttachedServers: (agentId: string) => Array<{ serverName: string; sourceLabel?: string }>
  listAttachedTools: (agentId: string) => Promise<Array<{
    server: { serverName: string }
    tools: Array<{ name: string; description?: string }>
  }>>
}

/**
 * CLI / MCP 目录常驻缓存权威容器（ Phase 4；#9463 去时间 TTL）。
 * 失效只走 {@link CatalogStore.invalidateCliCommands} /
 * {@link CatalogStore.invalidateMcpCache}。
 */
export class CatalogStore {
  private cliCache: CliCommandsMaterialized | null = null
  private cliStale = false
  private cliNegativeAt: number | null = null
  private cliInflight: Promise<CliCommandsMaterialized | null> | null = null

  private readonly mcpToolsCache = new Map<string, McpToolsCacheEntry>()
  private readonly mcpAgentCacheEpochs = new Map<string, number>()
  private mcpGlobalCacheEpoch = 0

  resetCliForTesting(): void {
    this.cliCache = null
    this.cliStale = false
    this.cliNegativeAt = null
    this.cliInflight = null
  }

  resetMcpForTesting(): void {
    this.mcpToolsCache.clear()
    this.mcpAgentCacheEpochs.clear()
    this.mcpGlobalCacheEpoch = 0
  }

  /** 身份切换：丢弃 CLI 物化与 MCP listing。 */
  reset(): void {
    this.resetCliForTesting()
    this.resetMcpForTesting()
  }

  resetForTesting(): void {
    this.reset()
  }

  /**
   * CLI 升级 / 显式刷新：标记 stale，下次 ensure 重新 spawn。
   * 失败时仍回落旧物化，避免目录瞬时空。
   */
  invalidateCliCommands(): void {
    this.cliStale = true
    this.cliNegativeAt = null
  }

  // ─── CLI materializer ───────────────────────────────────────────────

  getCliCommandsMaterializedSnapshot(): CliCommandsMaterialized | null {
    if (this.cliCache && !this.cliStale) return this.cliCache
    return null
  }

  async ensureCliCommandsMaterialized(
    spawn: CliCommandsSpawnPort,
    parseJson: (stdout: string) => RawCliCommand[] | null,
    logWarn: (message: string) => void,
    options?: CliCommandsMaterializeOptions,
  ): Promise<CliCommandsMaterialized | null> {
    if (this.cliCache && !this.cliStale) {
      return this.cliCache
    }
    const now = Date.now()
    if (
      !this.cliCache
      && this.cliNegativeAt != null
      && now - this.cliNegativeAt < CLI_NEGATIVE_BACKOFF_MS
    ) {
      return null
    }
    if (this.cliInflight) return this.cliInflight
    this.cliInflight = this.spawnAndMaterializeCli(
      spawn,
      parseJson,
      logWarn,
      options?.timeoutMs ?? CLI_SPAWN_TIMEOUT_MS,
    ).finally(() => {
      this.cliInflight = null
    })
    return this.cliInflight
  }

  private async spawnAndMaterializeCli(
    spawn: CliCommandsSpawnPort,
    parseJson: (stdout: string) => RawCliCommand[] | null,
    logWarn: (message: string) => void,
    timeoutMs: number,
  ): Promise<CliCommandsMaterialized | null> {
    try {
      const options = {
        timeout: timeoutMs,
        encoding: 'utf-8' as const,
        maxBuffer: 4 * 1024 * 1024,
      }
      let stdout: string
      let riskSchemasComplete = true
      try {
        ;({ stdout } = await spawn(
          'tabtin',
          ['commands', '--format', 'json', '--include-hidden'],
          options,
        ))
      } catch (error) {
        if (!isIncludeHiddenUnsupported(error)) throw error
        logWarn(
          'bundled tabtin CLI does not support --include-hidden; falling back to visible command catalog',
        )
        riskSchemasComplete = false
        ;({ stdout } = await spawn('tabtin', ['commands', '--format', 'json'], options))
      }
      const parsed = parseJson(stdout)
      if (!parsed) {
        logWarn('parseTabtinCommandsJson returned null (unexpected shape)')
        this.cliNegativeAt = Date.now()
        return this.cliCache
      }
      const commands = parsed
        .filter((raw) => raw.hidden !== true)
        .map(toCommandInfo)
        .filter((c): c is CliCommandInfo => c !== null)
      const next: CliCommandsMaterialized = {
        at: Date.now(),
        listing: { commands },
        schemas: riskSchemasComplete ? parsed : [],
        riskSchemasComplete,
      }
      this.cliCache = next
      this.cliStale = false
      this.cliNegativeAt = null
      return next
    } catch (e) {
      logWarn(`tabtin commands spawn failed: ${String(e)}`)
      this.cliNegativeAt = Date.now()
      return this.cliCache
    }
  }

  // ─── MCP listing cache ────────────────────────────────────────────────

  invalidateMcpCache(event: McpToolCacheInvalidation): void {
    const agentIds = event.agentIds?.length ? [...new Set(event.agentIds)] : null
    if (!agentIds) {
      this.mcpGlobalCacheEpoch += 1
      if (event.mode === 'drop') {
        this.mcpToolsCache.clear()
        return
      }
      for (const cached of this.mcpToolsCache.values()) cached.stale = true
      return
    }

    for (const agentId of agentIds) {
      this.mcpAgentCacheEpochs.set(agentId, (this.mcpAgentCacheEpochs.get(agentId) ?? 0) + 1)
      if (event.mode === 'drop') {
        this.mcpToolsCache.delete(agentId)
      } else {
        const cached = this.mcpToolsCache.get(agentId)
        if (cached) cached.stale = true
      }
    }
  }

  async fetchMcpListing(
    agentId: string | undefined,
    ports: McpListingPorts,
    logWarn: (message: string) => void,
  ): Promise<McpListing | null> {
    const aid = agentId?.trim()
    if (!aid) return { servers: [], tools: [] }

    let servers: McpListing['servers']
    try {
      servers = ports.listAttachedServers(aid)
        .map((s) => ({ serverName: s.serverName, sourceLabel: s.sourceLabel }))
    } catch (e) {
      logWarn(`listAttachedServers failed agent=${aid}: ${String(e)}`)
      return null
    }

    if (servers.length === 0) return { servers: [], tools: [] }

    const serverKey = servers
      .map(server => `${server.serverName}\u0000${server.sourceLabel ?? ''}`)
      .sort()
      .join('\u0001')
    const cached = this.mcpToolsCache.get(aid)
    if (
      cached
      && !cached.stale
      && cached.serverKey === serverKey
    ) {
      return { servers, tools: cached.tools }
    }

    const requestEpoch = this.mcpCacheEpoch(aid)
    try {
      const grouped = await ports.listAttachedTools(aid)
      const tools = grouped.flatMap((g) =>
        g.tools.map((t) => ({
          serverName: g.server.serverName,
          name: t.name,
          description: t.description,
        })),
      )
      if (this.mcpCacheEpoch(aid) === requestEpoch) {
        this.mcpToolsCache.set(aid, {
          at: Date.now(),
          tools,
          serverKey,
          stale: false,
        })
      }
      return { servers, tools }
    } catch (e) {
      logWarn(`listAttachedTools failed agent=${aid}: ${String(e)}`)
      const activeServerNames = new Set(servers.map(server => server.serverName))
      const fallbackTools = (cached?.tools ?? [])
        .filter(tool => activeServerNames.has(tool.serverName))
      return { servers, tools: fallbackTools }
    }
  }

  private mcpCacheEpoch(agentId: string): string {
    return `${this.mcpGlobalCacheEpoch}:${this.mcpAgentCacheEpochs.get(agentId) ?? 0}`
  }
}

function toCommandInfo(raw: RawCliCommand): CliCommandInfo | null {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) return null
  const flags = Array.isArray(raw.flags)
    ? raw.flags
      .map((f) => f?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    long: typeof raw.long === 'string' ? raw.long : undefined,
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    flags: flags.length > 0 ? flags : undefined,
    isGroup: raw.is_group === true ? true : undefined,
  }
}

/**
 * 工厂：按 agentId 闭包返回 McpCap fetchMcp 回调。
 */
export function createMcpListingFetcherFromCatalog(
  catalog: CatalogStore,
  agentId: string | undefined,
  ports: McpListingPorts,
  logWarn: (message: string) => void,
): (context: { query?: string }) => Promise<McpListing | null> {
  return async () => catalog.fetchMcpListing(agentId, ports, logWarn)
}

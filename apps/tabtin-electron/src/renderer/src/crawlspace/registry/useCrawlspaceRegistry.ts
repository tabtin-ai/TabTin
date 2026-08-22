import { useMemo } from 'react'
import { useCrawlTabStore, type CrawlspaceConfig } from '@stores/useCrawlTabStore'
import { getPartitionForSpaceSync } from '@stores/browserEnvSnapshot'

export type SpaceCrawlspaceEntry = {
  crawlspaceId: string
  config: CrawlspaceConfig
}

const matchesSpaceId = (config: CrawlspaceConfig, spaceId: string): boolean => {
  return (config.spaceId ?? config.projectId) === spaceId
}

export const findSpaceCrawlspaceEntry = (
  configsById: Record<string, CrawlspaceConfig>,
  spaceId: string | null | undefined,
): SpaceCrawlspaceEntry | null => {
  if (!spaceId) return null

  const entry = Object.entries(configsById)
    .find(([, config]) => matchesSpaceId(config, spaceId))

  if (!entry) return null

  const [crawlspaceId, config] = entry
  return { crawlspaceId, config }
}

export const resolveSpaceCrawlspaceIdFromConfigs = (
  configsById: Record<string, CrawlspaceConfig>,
  spaceId: string | null | undefined,
  fallbackCrawlspaceId: string | null = null,
): string | null => {
  return findSpaceCrawlspaceEntry(configsById, spaceId)?.crawlspaceId ?? fallbackCrawlspaceId
}

export const resolveSpacePartitionFromConfigs = (
  configsById: Record<string, CrawlspaceConfig>,
  spaceId: string | null | undefined,
): string | null => {
  // 优先从已打开的 workspace config 取（已被 listener 升级到最新值）；如果
  // 该 Space 还没打开过 workspace（比如 onboarding 横幅在进入 workspace 前就
  // 显示），就走 BrowserEnv 镜像直接查 Space 的 partition。
  // 镜像未就绪时返回默认 env partition；这正是 Banner / 注入路径需要的语义。
  const fromWorkspace = findSpaceCrawlspaceEntry(configsById, spaceId)?.config.partition
  if (fromWorkspace) return fromWorkspace
  if (!spaceId) return null
  return getPartitionForSpaceSync(spaceId)
}

export type CrawlspaceRegistry = {
  configsById: Record<string, CrawlspaceConfig>
  getConfig: (crawlspaceId: string) => CrawlspaceConfig | null
  getSpaceEntry: (spaceId: string | null | undefined) => SpaceCrawlspaceEntry | null
  getSpaceCrawlspaceId: (
    spaceId: string | null | undefined,
    fallbackCrawlspaceId?: string | null,
  ) => string | null
  getSpacePartition: (spaceId: string | null | undefined) => string | null
}

export const useCrawlspaceRegistry = (): CrawlspaceRegistry => {
  const emptyConfigs = useMemo<Record<string, CrawlspaceConfig>>(() => ({}), [])
  const configsById = useCrawlTabStore(state => state.crawlspaceConfigById || emptyConfigs)

  const getConfig = useMemo(() => {
    return (crawlspaceId: string) => configsById[crawlspaceId] || null
  }, [configsById])

  const getSpaceEntry = useMemo(() => {
    return (spaceId: string | null | undefined) => findSpaceCrawlspaceEntry(configsById, spaceId)
  }, [configsById])

  const getSpaceCrawlspaceId = useMemo(() => {
    return (spaceId: string | null | undefined, fallbackCrawlspaceId: string | null = null) =>
      resolveSpaceCrawlspaceIdFromConfigs(configsById, spaceId, fallbackCrawlspaceId)
  }, [configsById])

  const getSpacePartition = useMemo(() => {
    return (spaceId: string | null | undefined) => resolveSpacePartitionFromConfigs(configsById, spaceId)
  }, [configsById])

  return useMemo(() => ({
    configsById,
    getConfig,
    getSpaceEntry,
    getSpaceCrawlspaceId,
    getSpacePartition,
  }), [configsById, getConfig, getSpaceEntry, getSpaceCrawlspaceId, getSpacePartition])
}

export const getCrawlspaceConfig = (crawlspaceId: string): CrawlspaceConfig | null => {
  return useCrawlTabStore.getState().crawlspaceConfigById[crawlspaceId] || null
}

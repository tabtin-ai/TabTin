import { describe, expect, it } from 'vitest'
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore'
import {
  findSpaceCrawlspaceEntry,
  resolveSpaceCrawlspaceIdFromConfigs,
  resolveSpacePartitionFromConfigs,
} from './useCrawlspaceRegistry'

const buildConfig = (
  crawlspaceId: string,
  overrides: Partial<CrawlspaceConfig> = {},
): CrawlspaceConfig => ({
  crawlspaceId,
  profile: 'agent-workspace',
  partition: `tabtin:crawlspace:${crawlspaceId}`,
  ...overrides,
})

describe('useCrawlspaceRegistry helpers', () => {
  it('优先按 spaceId 命中 registry entry', () => {
    const configsById: Record<string, CrawlspaceConfig> = {
      'cs-1': buildConfig('cs-1', { spaceId: 'space-1' }),
    }

    expect(findSpaceCrawlspaceEntry(configsById, 'space-1')).toEqual({
      crawlspaceId: 'cs-1',
      config: configsById['cs-1'],
    })
  })

  it('兼容历史 projectId 字段解析 crawlspaceId', () => {
    const configsById: Record<string, CrawlspaceConfig> = {
      'cs-legacy': buildConfig('cs-legacy', { projectId: 'legacy-space' }),
    }

    expect(resolveSpaceCrawlspaceIdFromConfigs(configsById, 'legacy-space')).toBe('cs-legacy')
  })

  it('在缺失映射时回退到 fallback crawlspaceId', () => {
    const configsById: Record<string, CrawlspaceConfig> = {}

    expect(resolveSpaceCrawlspaceIdFromConfigs(configsById, 'missing-space', 'cs-fallback')).toBe('cs-fallback')
  })

  it('可从 registry 解析当前 space 的 partition', () => {
    const configsById: Record<string, CrawlspaceConfig> = {
      'cs-2': buildConfig('cs-2', { spaceId: 'space-2', partition: 'persist:space-2' }),
    }

    expect(resolveSpacePartitionFromConfigs(configsById, 'space-2')).toBe('persist:space-2')
  })
})

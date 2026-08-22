/**
 * cli-listing-gate 单测（ prompt 门控）。
 *
 * 覆盖：开关关 → 剔 image；模型空 → 剔；两路都不可用 → 连组入口剔；
 * 信号抛错 → fail-open；无 organizationId → 不门控；缓存命中不重复请求。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliListing } from '@tabtin/agent-runtime/capability'

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../../config/api.js', () => ({
  API_BASE_URL: 'http://api.test',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`,
}))

vi.mock('../../../auth.js', () => ({
  TokenManager: {
    getAccessToken: vi.fn(async () => 'test-token'),
  },
}))

vi.mock('../cli-listing-fetcher.js', () => ({
  createCliListingFetcher: () => async () => FULL_LISTING,
}))

import {
  __resetCliListingGateCacheForTesting,
  createGatedCliListingFetcher,
  filterCliListingByMediaGate,
} from '../cli-listing-gate.js'

const FULL_LISTING: CliListing = {
  commands: [
    { name: 'browser open', description: 'open url' },
    { name: 'site', description: 'site group', isGroup: true },
    { name: 'site list', description: 'list sites' },
    { name: 'media', description: 'media group', isGroup: true },
    { name: 'media list', description: 'list media tasks' },
    { name: 'media catalog', description: 'media model catalog' },
    { name: 'media image', description: 'image group', isGroup: true },
    { name: 'media image generate', description: 'generate image' },
    { name: 'media image status', description: 'image task status' },
    { name: 'media video', description: 'video group', isGroup: true },
    { name: 'media video generate', description: 'generate video' },
    { name: 'slide create', description: 'create slide' },
    { name: 'memo list', description: 'list memos' },
    { name: 'tabtin-demo-app', description: 'demo marketplace app', isGroup: true },
    { name: 'tabtin-demo-app list', description: 'demo list' },
    { name: 'files list', description: 'list files' },
    { name: 'doc read', description: 'read doc' },
  ],
}

function namesOf(listing: CliListing): string[] {
  return listing.commands.map((c) => c.name)
}

function serviceCatalogPayload(opts: { image?: boolean; video?: boolean }) {
  return {
    success: true,
    data: {
      organization_id: 'org-1',
      services: [
        { service_key: 'media.image', enabled: opts.image ?? true },
        { service_key: 'media.video', enabled: opts.video ?? true },
        { service_key: 'web.search', enabled: true },
      ],
    },
  }
}

function mediaCatalogPayload(models: Array<{ task_type: string }>) {
  return { success: true, models }
}

function mockFetchSequence(
  handlers: Array<(url: string) => unknown | Promise<unknown>>,
): ReturnType<typeof vi.fn> {
  let i = 0
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const handler = handlers[Math.min(i, handlers.length - 1)]
    i += 1
    const body = await handler(url)
    return {
      ok: true,
      status: 200,
      json: async () => body,
    }
  })
}

describe('filterCliListingByMediaGate', () => {
  it('两边都可用时仅剔除  临时隐藏命令域', () => {
    const out = filterCliListingByMediaGate(FULL_LISTING, {
      imageAvailable: true,
      videoAvailable: true,
    })
    const names = namesOf(out)
    expect(names).not.toContain('site')
    expect(names).not.toContain('site list')
    expect(names).not.toContain('media video')
    expect(names).not.toContain('media video generate')
    expect(names).toContain('media image generate')
    expect(names).toContain('slide create')
    expect(names).not.toContain('memo list')
    expect(names).not.toContain('tabtin-demo-app')
    expect(names).not.toContain('tabtin-demo-app list')
    expect(names).toContain('files list')
  })

  it('image 不可用 → 剔除 media image *', () => {
    const out = filterCliListingByMediaGate(FULL_LISTING, {
      imageAvailable: false,
      videoAvailable: true,
    })
    const names = namesOf(out)
    expect(names).not.toContain('media image generate')
    expect(names).not.toContain('media image')
    expect(names).not.toContain('media video generate')
    expect(names).toContain('media')
    expect(names).toContain('media list')
  })

  it('image+video 都不可用 → 连组入口 / list / catalog 剔除', () => {
    const out = filterCliListingByMediaGate(FULL_LISTING, {
      imageAvailable: false,
      videoAvailable: false,
    })
    const names = namesOf(out)
    expect(names).toEqual(['browser open', 'slide create', 'files list', 'doc read'])
  })
})

describe('createGatedCliListingFetcher', () => {
  beforeEach(() => {
    __resetCliListingGateCacheForTesting()
  })

  afterEach(() => {
    __resetCliListingGateCacheForTesting()
    vi.unstubAllGlobals()
  })

  it('无 organizationId → 不发 HTTP，但仍应用临时隐藏命令域', async () => {
    const fetchImpl = vi.fn()
    const fetcher = createGatedCliListingFetcher(undefined, {
      baseFetch: async () => FULL_LISTING,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await fetcher({ query: 'gen image' })
    expect(namesOf(out!)).toEqual([
      'browser open',
      'media',
      'media list',
      'media catalog',
      'media image',
      'media image generate',
      'media image status',
      'slide create',
      'files list',
      'doc read',
    ])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('开关关 → 剔除 media image *', async () => {
    const fetchImpl = mockFetchSequence([
      (url) => {
        if (url.includes('service-catalog')) {
          return serviceCatalogPayload({ image: false, video: true })
        }
        return mediaCatalogPayload([
          { task_type: 'text2image' },
          { task_type: 'text2video' },
        ])
      },
    ])
    const fetcher = createGatedCliListingFetcher('org-1', {
      baseFetch: async () => FULL_LISTING,
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await fetcher({ organizationId: 'org-1' })
    const names = namesOf(out!)
    expect(names).not.toContain('media image generate')
    expect(names).not.toContain('media video generate')
    expect(names).toContain('media')
  })

  it('模型空 → 剔除对应 media 命令', async () => {
    const fetchImpl = mockFetchSequence([
      (url) => {
        if (url.includes('service-catalog')) {
          return serviceCatalogPayload({ image: true, video: true })
        }
        // 只有 video 模型 → image 侧视为无模型
        return mediaCatalogPayload([{ task_type: 'text2video' }])
      },
    ])
    const fetcher = createGatedCliListingFetcher('org-2', {
      baseFetch: async () => FULL_LISTING,
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await fetcher({ organizationId: 'org-2' })
    const names = namesOf(out!)
    expect(names).not.toContain('media image generate')
    expect(names).not.toContain('media video generate')
  })

  it('两路都不可用 → 连 media / list / catalog 剔除', async () => {
    const fetchImpl = mockFetchSequence([
      (url) => {
        if (url.includes('service-catalog')) {
          return serviceCatalogPayload({ image: false, video: false })
        }
        return mediaCatalogPayload([])
      },
    ])
    const fetcher = createGatedCliListingFetcher('org-3', {
      baseFetch: async () => FULL_LISTING,
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await fetcher({ organizationId: 'org-3' })
    expect(namesOf(out!)).toEqual([
      'browser open',
      'slide create',
      'files list',
      'doc read',
    ])
  })

  it('信号查询抛错 → fail-open 返回全量', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    })
    const fetcher = createGatedCliListingFetcher('org-fail', {
      baseFetch: async () => FULL_LISTING,
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await fetcher({ organizationId: 'org-fail' })
    expect(namesOf(out!)).toEqual([
      'browser open',
      'media',
      'media list',
      'media catalog',
      'media image',
      'media image generate',
      'media image status',
      'slide create',
      'files list',
      'doc read',
    ])
  })

  it('缓存命中不重复请求', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1
      const url = String(input)
      const body = url.includes('service-catalog')
        ? serviceCatalogPayload({ image: false, video: true })
        : mediaCatalogPayload([{ task_type: 'text2image' }, { task_type: 'text2video' }])
      return { ok: true, status: 200, json: async () => body }
    })
    const fetcher = createGatedCliListingFetcher('org-cache', {
      baseFetch: async () => FULL_LISTING,
      getAccessToken: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000,
    })

    await fetcher({ organizationId: 'org-cache' })
    await fetcher({ organizationId: 'org-cache' })

    // 每轮并行打 2 个端点；第二次应命中缓存，不再发请求。
    expect(calls).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

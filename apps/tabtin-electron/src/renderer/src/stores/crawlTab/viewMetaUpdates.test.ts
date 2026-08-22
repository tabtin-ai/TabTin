import { describe, expect, it } from 'vitest'
import {
  applyViewMetaUpdatesToCache,
  applyViewMetaUpdatesToSeeds,
} from './viewMetaUpdates'

describe('viewMetaUpdates', () => {
  it('会把 title/url/themeColor 写入 cache，并支持显式清空 themeColor', () => {
    const cache = {
      activeViewId: 'view-1',
      viewList: [
        {
          viewId: 'view-1',
          title: 'Old title',
          url: 'https://old.example',
          themeColor: '#ffffff',
          createdAt: 1,
        },
      ],
    }

    const updated = applyViewMetaUpdatesToCache(cache, 'view-1', {
      title: 'New title',
      url: 'https://new.example',
      themeColor: undefined,
    })

    expect(updated).not.toBe(cache)
    expect(updated?.viewList[0]).toMatchObject({
      viewId: 'view-1',
      title: 'New title',
      url: 'https://new.example',
      themeColor: undefined,
    })
  })

  it('cache 中 url 跨文档变化且未提供新 favicon 时会清空旧 favicon', () => {
    const cache = {
      activeViewId: 'view-1',
      viewList: [
        {
          viewId: 'view-1',
          title: 'Baidu',
          url: 'https://www.baidu.com',
          favicon: 'data:image/png;base64,baidu',
          createdAt: 1,
        },
      ],
    }

    const updated = applyViewMetaUpdatesToCache(cache, 'view-1', {
      url: 'https://www.xiaohongshu.com/explore',
    })

    expect(updated?.viewList[0]?.url).toBe('https://www.xiaohongshu.com/explore')
    expect(updated?.viewList[0]?.favicon).toBeUndefined()
  })

  it('cache 中同站点 url 变化会保留 favicon', () => {
    const cache = {
      activeViewId: 'view-1',
      viewList: [
        {
          viewId: 'view-1',
          title: 'Docs',
          url: 'https://www.example.com/page-one',
          favicon: 'data:image/png;base64,example',
          createdAt: 1,
        },
      ],
    }

    const updated = applyViewMetaUpdatesToCache(cache, 'view-1', {
      url: 'https://example.com/page-two',
    })

    expect(updated?.viewList[0]?.favicon).toBe('data:image/png;base64,example')
  })

  it('cache 中 url 变化会清空旧 openIntentHints，避免导航后沿用文件 metadata', () => {
    const cache = {
      activeViewId: 'view-1',
      viewList: [
        {
          viewId: 'view-1',
          title: 'report.xlsx',
          url: 'https://oss.example.com/download?id=asset-1',
          openIntentHints: { filename: 'report.xlsx', assetId: 'asset-1' },
          createdAt: 1,
        },
      ],
    }

    const updated = applyViewMetaUpdatesToCache(cache, 'view-1', {
      url: 'https://example.com/ordinary-page',
    })

    expect(updated?.viewList[0]?.url).toBe('https://example.com/ordinary-page')
    expect(updated?.viewList[0]?.openIntentHints).toBeUndefined()
  })

  it('只会把可持久化字段同步到 seeds', () => {
    const seeds = [
      {
        viewId: 'view-1',
        title: 'Old title',
        url: 'https://old.example',
        favicon: 'old.ico',
        runId: 'run-1',
        isPreview: false,
        createdAt: 1,
      },
    ]

    const updated = applyViewMetaUpdatesToSeeds(seeds, 'view-1', {
      title: 'New title',
      url: 'https://new.example',
      favicon: 'new.ico',
      runId: 'run-2',
      isPreview: true,
      themeColor: '#111111',
      isLoading: true,
    })

    expect(updated).not.toBe(seeds)
    expect(updated?.[0]).toMatchObject({
      viewId: 'view-1',
      title: 'New title',
      url: 'https://new.example',
      favicon: 'new.ico',
      runId: 'run-2',
      isPreview: true,
    })
    expect(updated?.[0]).not.toHaveProperty('themeColor')
    expect(updated?.[0]).not.toHaveProperty('isLoading')
  })

  it('seeds 中 url 跨文档变化且未提供新 favicon 时会清空旧 favicon', () => {
    const seeds = [
      {
        viewId: 'view-1',
        title: 'Baidu',
        url: 'https://www.baidu.com',
        favicon: 'data:image/png;base64,baidu',
        createdAt: 1,
      },
    ]

    const updated = applyViewMetaUpdatesToSeeds(seeds, 'view-1', {
      url: 'https://www.xiaohongshu.com/explore',
    })

    expect(updated?.[0]?.url).toBe('https://www.xiaohongshu.com/explore')
    expect(updated?.[0]?.favicon).toBeUndefined()
  })

  it('seeds 中 url 变化会清空旧 openIntentHints，避免恢复时误判新页面', () => {
    const seeds = [
      {
        viewId: 'view-1',
        title: 'report.xlsx',
        url: 'https://oss.example.com/download?id=asset-1',
        openIntentHints: { filename: 'report.xlsx', assetId: 'asset-1' },
        createdAt: 1,
      },
    ]

    const updated = applyViewMetaUpdatesToSeeds(seeds, 'view-1', {
      url: 'https://example.com/ordinary-page',
    })

    expect(updated?.[0]?.url).toBe('https://example.com/ordinary-page')
    expect(updated?.[0]?.openIntentHints).toBeUndefined()
  })
})

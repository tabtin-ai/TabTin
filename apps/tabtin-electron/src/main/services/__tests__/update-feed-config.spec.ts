import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LEGACY_DEFAULT_FEED_URL,
  extractGenericPublishUrl,
  loadPackagedPublishFeedUrl,
  loadPackagedUpdateChannel,
  normalizeFeedUrl,
  normalizeUpdateChannel,
  resolveDefaultFeedUrl,
  resolvePackagedUpdaterConfig,
  resolveUpdateChannel,
} from '../update-feed-config'

describe('update-feed-config', () => {
  it('会标准化 feed url 结尾斜杠', () => {
    expect(normalizeFeedUrl('https://cdn.example.com/releases')).toBe('https://cdn.example.com/releases/')
    expect(normalizeFeedUrl('https://cdn.example.com/releases/')).toBe('https://cdn.example.com/releases/')
    expect(normalizeFeedUrl('')).toBeNull()
  })

  it('优先读取 generic publish 配置中的 url', () => {
    expect(
      extractGenericPublishUrl([
        { provider: 'github', owner: 'tabtin' },
        { provider: 'generic', url: 'https://cdn.example.com/releases/win' },
      ])
    ).toBe('https://cdn.example.com/releases/win/')
  })

  it('会从 package.json 的构建配置中解析默认 feed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-feed-config-'))

    try {
      const packageJsonPath = join(tempDir, 'package.json')
      writeFileSync(packageJsonPath, JSON.stringify({
        build: {
          publish: {
            provider: 'generic',
            url: 'https://cdn.example.com/releases/stable/win',
          },
        },
      }))

      expect(loadPackagedPublishFeedUrl(packageJsonPath)).toBe('https://cdn.example.com/releases/stable/win/')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('会按 updateServerUrl > TABTIN_UPDATE_FEED_URL > UPDATE_SERVER_URL 的优先级解析', () => {
    const env = {
      TABTIN_UPDATE_FEED_URL: 'https://env.example.com/feed',
      UPDATE_SERVER_URL: 'https://legacy.example.com/feed',
    }

    expect(resolveDefaultFeedUrl({ env })).toBe('https://env.example.com/feed/')
    expect(resolveDefaultFeedUrl({ env, updateServerUrl: 'https://config.example.com/feed' })).toBe(
      'https://config.example.com/feed/'
    )
  })

  it('缺少显式配置时回退到 package publish url，再不行才回退 legacy feed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-feed-config-'))

    try {
      const packageJsonPath = join(tempDir, 'package.json')
      writeFileSync(packageJsonPath, JSON.stringify({
        build: {
          publish: [
            { provider: 'github', owner: 'tabtin' },
            { provider: 'generic', url: 'https://package.example.com/feed' },
          ],
        },
      }))

      expect(resolveDefaultFeedUrl({ env: {}, packageJsonPath })).toBe('https://package.example.com/feed/')
      expect(resolveDefaultFeedUrl({ env: {}, packageJsonPath: join(tempDir, 'missing.json') })).toBe(
        LEGACY_DEFAULT_FEED_URL
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('会从打包产物元数据读取 update channel，并优先于环境变量', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-channel-config-'))

    try {
      const packageJsonPath = join(tempDir, 'package.json')
      writeFileSync(packageJsonPath, JSON.stringify({
        tabtinDesktop: {
          updateChannel: 'beta',
        },
      }))

      expect(loadPackagedUpdateChannel(packageJsonPath)).toBe('beta')
      expect(resolveUpdateChannel({
        env: {
          TABTIN_UPDATE_CHANNEL: 'alpha',
          UPDATE_CHANNEL: 'stable',
        },
        packageJsonPath,
      })).toBe('beta')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('channel 标准化失败时会安全回退到 stable', () => {
    expect(normalizeUpdateChannel('BETA')).toBe('beta')
    expect(normalizeUpdateChannel('preview')).toBeNull()
    expect(resolveUpdateChannel({
      env: {
        TABTIN_UPDATE_CHANNEL: 'preview',
        UPDATE_CHANNEL: 'nightly',
      },
    })).toBe('stable')
  })

  it('community 缺少 packaged feed 元数据时关闭 updater，且忽略运行时 feed env', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-community-feed-'))

    try {
      const packageJsonPath = join(tempDir, 'package.json')
      writeFileSync(packageJsonPath, JSON.stringify({
        tabtinDesktop: {
          distribution: {
            kind: 'community',
            apiBaseUrl: 'https://api.example.org/api',
          },
        },
      }))

      expect(resolvePackagedUpdaterConfig({
        packageJsonPath,
        env: { TABTIN_UPDATE_FEED_URL: 'https://attacker.example/feed' },
      })).toEqual({ enabled: false })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('community 只启用 packaged metadata 声明的 feed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tabtin-community-feed-'))

    try {
      const packageJsonPath = join(tempDir, 'package.json')
      writeFileSync(packageJsonPath, JSON.stringify({
        tabtinDesktop: {
          distribution: {
            kind: 'community',
            apiBaseUrl: 'https://api.example.org/api',
            updateFeedUrl: 'https://downloads.example.org/desktop',
          },
        },
      }))

      expect(resolvePackagedUpdaterConfig({ packageJsonPath, env: {} })).toEqual({
        enabled: true,
        feedUrl: 'https://downloads.example.org/desktop/',
        feedOrigin: 'https://downloads.example.org',
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

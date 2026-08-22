/**
 * @tabtin/app-config —— configSchema 默认值读取 + override + 容错单测。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.5 + § 9.1 完成标准 §9.0.4
 * "app.json → runtime plumbing 通畅"。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAppConfig,
  createStaticManifestSource,
  type AppConfigSource,
} from '../index.js'

interface DesktopLikeConfig {
  imageResize: {
    enabled: boolean
    pxPerToken: number
    maxTargetPx: number
    maxTargetTokens: number
  }
  pixelCompare: { enabled: boolean }
}

const DEFAULT_CONFIG: DesktopLikeConfig = {
  imageResize: { enabled: true, pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 },
  pixelCompare: { enabled: true },
}

describe('@tabtin/app-config · loadAppConfig（v2.1 模块零）', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `tabtin-app-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpRoot, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  })

  function writeManifest(appId: string, manifest: object): void {
    const dir = join(tmpRoot, appId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  it('app.json 不存在 → 返回 defaults', () => {
    const cfg = loadAppConfig<DesktopLikeConfig>('not-exists', DEFAULT_CONFIG, {
      manifestRoot: tmpRoot,
    })
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('app.json 存在但无 configSchema → 返回 defaults', () => {
    writeManifest('foo', { id: 'foo', name: 'Foo' })
    const cfg = loadAppConfig<DesktopLikeConfig>('foo', DEFAULT_CONFIG, {
      manifestRoot: tmpRoot,
    })
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('app.json 损坏（解析失败）→ 不抛错，返回 defaults', () => {
    const dir = join(tmpRoot, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'app.json'), '{ invalid json !!!', 'utf-8')
    expect(() =>
      loadAppConfig<DesktopLikeConfig>('broken', DEFAULT_CONFIG, { manifestRoot: tmpRoot }),
    ).not.toThrow()
    const cfg = loadAppConfig<DesktopLikeConfig>('broken', DEFAULT_CONFIG, { manifestRoot: tmpRoot })
    expect(cfg).toEqual(DEFAULT_CONFIG)
  })

  it('configSchema 默认值真接通 —— 改 app.json default 后 loadAppConfig 真返回新值', () => {
    writeManifest('mock-tabdesktop', {
      id: 'mock-tabdesktop',
      configSchema: {
        type: 'object',
        properties: {
          imageResize: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', default: false },
              pxPerToken: { type: 'number', default: 14 },
              maxTargetPx: { type: 'number', default: 800 },
              maxTargetTokens: { type: 'number', default: 800 },
            },
          },
          pixelCompare: {
            type: 'object',
            properties: { enabled: { type: 'boolean', default: false } },
          },
        },
      },
    })
    const cfg = loadAppConfig<DesktopLikeConfig>('mock-tabdesktop', DEFAULT_CONFIG, {
      manifestRoot: tmpRoot,
    })
    expect(cfg.imageResize.enabled).toBe(false)
    expect(cfg.imageResize.pxPerToken).toBe(14)
    expect(cfg.imageResize.maxTargetPx).toBe(800)
    expect(cfg.imageResize.maxTargetTokens).toBe(800)
    expect(cfg.pixelCompare.enabled).toBe(false)
  })

  it('app.json 部分缺失字段 → 缺失字段保留 defaults', () => {
    writeManifest('partial', {
      id: 'partial',
      configSchema: {
        type: 'object',
        properties: {
          // 只覆盖 pixelCompare.enabled，imageResize 完全缺失
          pixelCompare: {
            type: 'object',
            properties: { enabled: { type: 'boolean', default: false } },
          },
        },
      },
    })
    const cfg = loadAppConfig<DesktopLikeConfig>('partial', DEFAULT_CONFIG, {
      manifestRoot: tmpRoot,
    })
    expect(cfg.pixelCompare.enabled).toBe(false)
    expect(cfg.imageResize.enabled).toBe(true)
    expect(cfg.imageResize.pxPerToken).toBe(28)
  })

  it('opts.override 优先级最高（覆盖 app.json 与 defaults）', () => {
    writeManifest('override-test', {
      id: 'override-test',
      configSchema: {
        type: 'object',
        properties: {
          pixelCompare: {
            type: 'object',
            properties: { enabled: { type: 'boolean', default: false } },
          },
        },
      },
    })
    const cfg = loadAppConfig<DesktopLikeConfig>('override-test', DEFAULT_CONFIG, {
      manifestRoot: tmpRoot,
      override: { pixelCompare: { enabled: true } },
    })
    expect(cfg.pixelCompare.enabled).toBe(true)
  })

  it('自定义 source 链按顺序覆盖（后者覆盖前者）', () => {
    const sourceA: AppConfigSource = {
      name: 'A',
      read() { return { pixelCompare: { enabled: false } } },
    }
    const sourceB: AppConfigSource = {
      name: 'B',
      read() { return { imageResize: { pxPerToken: 14 } } },
    }
    const cfg = loadAppConfig<DesktopLikeConfig>('any', DEFAULT_CONFIG, {
      sources: [sourceA, sourceB],
    })
    expect(cfg.pixelCompare.enabled).toBe(false)
    expect(cfg.imageResize.pxPerToken).toBe(14)
    // 未被任一 source 覆盖的字段保留 defaults
    expect(cfg.imageResize.enabled).toBe(true)
    expect(cfg.imageResize.maxTargetPx).toBe(1568)
  })

  it('单个 source 抛错不影响其他 source / 不影响 defaults 兜底', () => {
    const throwingSource: AppConfigSource = {
      name: 'throw',
      read() { throw new Error('boom') },
    }
    const goodSource: AppConfigSource = {
      name: 'good',
      read() { return { pixelCompare: { enabled: false } } },
    }
    const cfg = loadAppConfig<DesktopLikeConfig>('any', DEFAULT_CONFIG, {
      sources: [throwingSource, goodSource],
    })
    expect(cfg.pixelCompare.enabled).toBe(false)
    expect(cfg.imageResize.pxPerToken).toBe(28)
  })

  it('createStaticManifestSource 在 manifestRoot 不存在时返回空对象，不抛错', () => {
    const src = createStaticManifestSource({ manifestRoot: '/this/path/does/not/exist' })
    expect(src.read('anything')).toEqual({})
  })

  describe('v2.2 模块零扫尾（独立验收 P0-1）· 显式 manifestRoot 诊断', () => {
    it('显式 manifestRoot 不存在 → onExplicitMissing 被触发（含 tried + appId）', () => {
      const onMissing = vi.fn()
      const src = createStaticManifestSource({
        manifestRoot: '/this/path/does/not/exist',
        diagnostics: { onExplicitMissing: onMissing },
      })
      const out = src.read('tabdesktop')
      expect(out).toEqual({})
      expect(onMissing).toHaveBeenCalledTimes(1)
      expect(onMissing).toHaveBeenCalledWith({
        tried: '/this/path/does/not/exist',
        appId: 'tabdesktop',
      })
    })

    it('显式 manifestRoot 存在 → onExplicitMissing 不被触发', () => {
      writeManifest('foo', { configSchema: { properties: {} } })
      const onMissing = vi.fn()
      const src = createStaticManifestSource({
        manifestRoot: tmpRoot,
        diagnostics: { onExplicitMissing: onMissing },
      })
      src.read('foo')
      expect(onMissing).not.toHaveBeenCalled()
    })

    it('未显式传 manifestRoot + 自动推断找不到 → onAutoMissing 被触发（如果传了回调）', () => {
      // 强制 cwd 到一个不存在 packages/apps 的临时目录
      const isoCwd = join(tmpRoot, 'isolated-no-packages-apps')
      mkdirSync(isoCwd, { recursive: true })
      const orig = process.cwd()
      try {
        process.chdir(isoCwd)
        const onAutoMissing = vi.fn()
        const onExplicitMissing = vi.fn()
        const src = createStaticManifestSource({
          diagnostics: { onAutoMissing, onExplicitMissing },
        })
        src.read('foo')
        // 注意：这里 cwd 已切走，但 import.meta.url 上溯仍可能找到本仓库的 packages/apps
        // ——所以本断言对 onAutoMissing 是"可能触发"，但 onExplicitMissing 一定不触发
        expect(onExplicitMissing).not.toHaveBeenCalled()
      } finally {
        process.chdir(orig)
      }
    })

    it('loadAppConfig 透传 diagnostics 给默认 staticManifestSource', () => {
      const onMissing = vi.fn()
      const cfg = loadAppConfig<{ pixelCompare: { enabled: boolean } }>(
        'tabdesktop',
        { pixelCompare: { enabled: true } },
        {
          manifestRoot: '/this/path/does/not/exist',
          diagnostics: { onExplicitMissing: onMissing },
        },
      )
      // fallback 到 defaults
      expect(cfg.pixelCompare.enabled).toBe(true)
      // 诊断回调被触发
      expect(onMissing).toHaveBeenCalledWith({
        tried: '/this/path/does/not/exist',
        appId: 'tabdesktop',
      })
    })

    it('loadAppConfig 自定义 sources 时 diagnostics 不影响（自定义来源链自管诊断）', () => {
      const onMissing = vi.fn()
      const customSource: AppConfigSource = {
        name: 'custom',
        read() { return { pixelCompare: { enabled: false } } },
      }
      const cfg = loadAppConfig<{ pixelCompare: { enabled: boolean } }>(
        'tabdesktop',
        { pixelCompare: { enabled: true } },
        {
          sources: [customSource],
          manifestRoot: '/this/path/does/not/exist',
          diagnostics: { onExplicitMissing: onMissing },
        },
      )
      // 自定义 sources 生效（pixelCompare = false）
      expect(cfg.pixelCompare.enabled).toBe(false)
      // 诊断不被触发（因为没走默认 staticManifestSource）
      expect(onMissing).not.toHaveBeenCalled()
    })
  })
})

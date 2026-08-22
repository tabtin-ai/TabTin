/**
 * v2.1 模块零 · app.json plumbing 集成测试。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.5 + § 9.0.4 第 2 条
 * "app.json → runtime plumbing 通畅" + § 10 Q11（v1.8 false promise 修正的偿还）。
 *
 * **测试策略**：本文件**不实例化 DesktopExecutorService**——避免大量 mock
 * （nut-js / electron / sharp / node:fs 等）的复杂度。改为分两层守约：
 *
 * 1. **端到端读取层**：用真实文件系统在临时目录写 mock app.json，验证
 *    `loadAppConfig` 真能按 configSchema 读出默认值（含 v1.8 SKILL false
 *    promise 修正的核心承诺：改 app.json 重启 → 行为真变）；
 * 2. **真实 app.json 落点验证**：直接读仓库根的
 *    `packages/apps/tabdesktop/app.json`，断言 imageResize / pixelCompare
 *    默认值与规范 § 4.5.1 / § 4.5.3 + DesktopExecutorService hard-default 一致。
 *
 * Executor 构造 opts 字段（pixelCompareEnabled / imageResize.{enabled,params}）
 * 被正确接收由 `DesktopExecutorService.test.ts` 中的"构造函数 opts"段守约。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadAppConfig } from '@tabtin/app-config'

interface DesktopRuntimeConfig {
  imageResize: {
    enabled: boolean
    pxPerToken: number
    maxTargetPx: number
    maxTargetTokens: number
  }
  pixelCompare: { enabled: boolean }
}

const HARD_DEFAULTS: DesktopRuntimeConfig = {
  imageResize: { enabled: true, pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 },
  pixelCompare: { enabled: true },
}

describe('app.json plumbing · loadAppConfig 端到端（v2.1 模块零 · 规范 § 3.5.5）', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = join(
      tmpdir(),
      `tabtin-plumbing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(tmpRoot, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  })

  function writeManifest(appId: string, configSchema: object): void {
    const dir = join(tmpRoot, appId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({ id: appId, configSchema }, null, 2),
      'utf-8',
    )
  }

  describe('pixelCompare 开关接通', () => {
    it('app.json `pixelCompare.enabled=true` → loadAppConfig 返回 true', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          pixelCompare: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop',
        { ...HARD_DEFAULTS, pixelCompare: { enabled: false } },
        { manifestRoot: tmpRoot },
      )
      expect(cfg.pixelCompare.enabled).toBe(true)
    })

    it('app.json `pixelCompare.enabled=false` → loadAppConfig 返回 false（核心 false promise 修正）', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          pixelCompare: { type: 'object', properties: { enabled: { type: 'boolean', default: false } } },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop',
        HARD_DEFAULTS,
        { manifestRoot: tmpRoot },
      )
      expect(cfg.pixelCompare.enabled).toBe(false)
    })

    it('改 app.json 后 loadAppConfig 重新读 → 拿到新值（重启等价路径）', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          pixelCompare: { type: 'object', properties: { enabled: { type: 'boolean', default: true } } },
        },
      })
      const cfg1 = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg1.pixelCompare.enabled).toBe(true)

      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          pixelCompare: { type: 'object', properties: { enabled: { type: 'boolean', default: false } } },
        },
      })
      const cfg2 = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg2.pixelCompare.enabled).toBe(false)
    })
  })

  describe('imageResize 开关接通', () => {
    it('app.json 默认 enabled=true + 默认参数 → 与规范 § 4.5.1 默认值一致', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          imageResize: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', default: true },
              pxPerToken: { type: 'number', default: 28 },
              maxTargetPx: { type: 'number', default: 1568 },
              maxTargetTokens: { type: 'number', default: 1568 },
            },
          },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop',
        { ...HARD_DEFAULTS, imageResize: { enabled: false, pxPerToken: 1, maxTargetPx: 1, maxTargetTokens: 1 } },
        { manifestRoot: tmpRoot },
      )
      expect(cfg.imageResize.enabled).toBe(true)
      expect(cfg.imageResize.pxPerToken).toBe(28)
      expect(cfg.imageResize.maxTargetPx).toBe(1568)
      expect(cfg.imageResize.maxTargetTokens).toBe(1568)
    })

    it('app.json `imageResize.enabled=false` → loadAppConfig 返回 false', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          imageResize: {
            type: 'object',
            properties: { enabled: { type: 'boolean', default: false } },
          },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg.imageResize.enabled).toBe(false)
    })

    it('app.json `imageResize.maxTargetPx=800` → loadAppConfig 真按新参数返回', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          imageResize: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', default: true },
              pxPerToken: { type: 'number', default: 28 },
              maxTargetPx: { type: 'number', default: 800 },
              maxTargetTokens: { type: 'number', default: 800 },
            },
          },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg.imageResize.maxTargetPx).toBe(800)
      expect(cfg.imageResize.maxTargetTokens).toBe(800)
    })
  })

  describe('plumbing 容错（保护 TabTin 启动不被 app.json 错误卡死）', () => {
    it('app.json 不存在 → loadAppConfig 走 defaults，行为完全等价 v1.7 hard-default', () => {
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg).toEqual(HARD_DEFAULTS)
    })

    it('app.json 损坏（非法 JSON）→ loadAppConfig 不抛错 + 走 defaults', () => {
      const dir = join(tmpRoot, 'tabdesktop')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'app.json'), '{ broken json !!!', 'utf-8')
      expect(() =>
        loadAppConfig<DesktopRuntimeConfig>('tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot }),
      ).not.toThrow()
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg).toEqual(HARD_DEFAULTS)
    })

    it('app.json 字段部分缺失 → 缺失字段保留 defaults', () => {
      writeManifest('tabdesktop', {
        type: 'object',
        properties: {
          // 只有 pixelCompare，没有 imageResize
          pixelCompare: { type: 'object', properties: { enabled: { type: 'boolean', default: false } } },
        },
      })
      const cfg = loadAppConfig<DesktopRuntimeConfig>(
        'tabdesktop', HARD_DEFAULTS, { manifestRoot: tmpRoot },
      )
      expect(cfg.pixelCompare.enabled).toBe(false)
      // 缺失的 imageResize 完全保留 hard-default
      expect(cfg.imageResize).toEqual(HARD_DEFAULTS.imageResize)
    })
  })

  describe('真实 packages/apps/tabdesktop/app.json 端到端读取', () => {
    it('从仓库根读 packages/apps/tabdesktop/app.json → 默认值与规范 § 4.5.1/§ 4.5.3 一致', () => {
      // 不传 manifestRoot → loadAppConfig 自己从 cwd 推断（仓库根的 packages/apps）
      // 用"故意全错"的 hard-defaults 起手——证明实际值真的是从 app.json 读出来的
      const cfg = loadAppConfig<DesktopRuntimeConfig>('tabdesktop', {
        imageResize: { enabled: false, pxPerToken: 1, maxTargetPx: 1, maxTargetTokens: 1 },
        pixelCompare: { enabled: false },
      })
      // 真实 app.json 默认值（规范 § 4.5.1 / § 4.5.3）
      expect(cfg.imageResize.enabled).toBe(true)
      expect(cfg.imageResize.pxPerToken).toBe(28)
      expect(cfg.imageResize.maxTargetPx).toBe(1568)
      expect(cfg.imageResize.maxTargetTokens).toBe(1568)
      expect(cfg.pixelCompare.enabled).toBe(true)
    })
  })
})

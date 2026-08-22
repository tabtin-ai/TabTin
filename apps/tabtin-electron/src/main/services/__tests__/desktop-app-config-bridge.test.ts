/**
 * v2.2 模块零扫尾（独立验收 P0-1 + P1-1 + P1-2）· 接通胶水端到端测试。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.5 + § 9.1（v2.1 模块零）
 * + v2.2 扫尾记录 + § 9.0.4 第 2 条 "app.json → runtime plumbing 通畅"。
 *
 * **背景**：v2.1 模块零落地后，独立验收 Agent（QA 视角）发现：
 *
 * 1. **P1-1**：`deferred-init-action-bridge.ts` 中 `loadAppConfig → new
 *    DesktopExecutorService(opts)` 的接通胶水代码**完全无端到端测试**。M1+ 改
 *    plumbing 加新字段（tier）时如果改坏 imageResize / pixelCompare 的传值逻辑，
 *    所有现有测试都不会发现，v1.8 § 10 Q11 偿还的 plumbing 债又破。
 * 2. **P1-2**：构造 opts.imageResize.enabled = false → screenshot 默认走 maxDim
 *    路径**无端到端断言**。`pixelCompareEnabled` 等价路径有覆盖（desktop-pixel-
 *    compare.test.ts:423），imageResize 路径漏配。
 * 3. **P0-1**：`deferred-init-action-bridge.ts` 不传 manifestRoot → Electron
 *    打包态 silent fallback，SKILL false promise 复发。
 *
 * **本文件守约**：v2.2 模块零扫尾把接通胶水提取到 `desktop-app-config-bridge.ts`
 * 作为纯函数后，本文件直接 unit 测它的两个公开函数：
 *
 * - `resolveTabDesktopAppManifestRoot({ isPackaged, resourcesPath })` —— 4 条
 *   覆盖开发 / 打包 / 异常 resourcesPath 路径
 * - `buildTabDesktopExecutorConstructorOptions(loadConfigFn, opts?)` —— 多条
 *   覆盖 loadConfigFn 返回不同 cfg 时 Executor 构造 opts 的传值正确性
 *
 * 由于这些函数纯（无 electron / fs 副作用），可以脱离 Electron 完整启动直接
 * 单测——M1+ 改 plumbing 时本文件会立刻发现回归。
 */

import { describe, it, expect, vi } from 'vitest'
import {
  resolveTabDesktopAppManifestRoot,
  buildTabDesktopExecutorConstructorOptions,
  TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT,
  type TabDesktopRuntimeConfig,
  type LoadAppConfigFn,
} from '../desktop-app-config-bridge'

describe('resolveTabDesktopAppManifestRoot · v2.2 模块零扫尾（独立验收 P0-1）', () => {
  it('开发态（isPackaged=false）→ 返回 undefined（让 loadAppConfig 走自动推断）', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: false,
      resourcesPath: '/some/dev/path',
    })
    expect(r).toBeUndefined()
  })

  it('开发态 resourcesPath 缺失 → 仍返回 undefined', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: false,
      resourcesPath: undefined,
    })
    expect(r).toBeUndefined()
  })

  it('打包态（isPackaged=true + resourcesPath 有效）→ 返回 <resourcesPath>/app.asar.unpacked/packages/apps', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: true,
      resourcesPath: '/Applications/TabTin.app/Contents/Resources',
    })
    expect(r).toBe('/Applications/TabTin.app/Contents/Resources/app.asar.unpacked/packages/apps')
  })

  it('打包态 + Windows 路径 → 同样拼成 packages/apps', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\TabTin\\resources',
    })
    // path.join 在 POSIX 用 / 在 Windows 用 \；本测试在 Linux CI 跑，断言以 POSIX 为准
    expect(r).toContain('app.asar.unpacked')
    expect(r).toContain('packages')
    expect(r).toContain('apps')
  })

  it('打包态但 resourcesPath 异常（空字符串）→ 返回 undefined（保护性 fallback）', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: true,
      resourcesPath: '',
    })
    expect(r).toBeUndefined()
  })

  it('打包态但 resourcesPath 为 undefined → 返回 undefined', () => {
    const r = resolveTabDesktopAppManifestRoot({
      isPackaged: true,
      resourcesPath: undefined,
    })
    expect(r).toBeUndefined()
  })
})

describe('buildTabDesktopExecutorConstructorOptions · v2.2 模块零扫尾（独立验收 P1-1 + P1-2）', () => {
  /**
   * 工厂：构造一个 mock loadConfigFn，按需返回不同 cfg。
   * 这是 P1-1 守约的核心——把 loadAppConfig 真正的副作用（读 fs）替换成可控
   * 数据，断言"loadAppConfig 返回 X → Executor 构造 opts 是 Y"的接通映射。
   */
  function mockLoadConfigFn(returnCfg: TabDesktopRuntimeConfig): LoadAppConfigFn {
    const fn = vi.fn((appId: string, _defaults: unknown) => {
      expect(appId).toBe('tabdesktop')
      return returnCfg
    }) as unknown as LoadAppConfigFn
    return fn
  }

  describe('P1-1 · 接通映射正确性', () => {
    it('loadConfigFn 返回 hard-default → Executor opts 与 hard-default 一致', () => {
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT),
      )
      expect(opts.pixelCompareEnabled).toBe(true)
      expect(opts.imageResize.enabled).toBe(true)
      expect(opts.imageResize.params.pxPerToken).toBe(28)
      expect(opts.imageResize.params.maxTargetPx).toBe(1568)
      expect(opts.imageResize.params.maxTargetTokens).toBe(1568)
    })

    it('loadConfigFn 返回 pixelCompare.enabled=false → Executor opts.pixelCompareEnabled=false', () => {
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn({
          ...TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT,
          pixelCompare: { enabled: false },
        }),
      )
      expect(opts.pixelCompareEnabled).toBe(false)
      // 不影响 imageResize
      expect(opts.imageResize.enabled).toBe(true)
    })

    it('loadConfigFn 返回 imageResize.enabled=false → Executor opts.imageResize.enabled=false（P1-2 核心）', () => {
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn({
          ...TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT,
          imageResize: { enabled: false, pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 },
        }),
      )
      expect(opts.imageResize.enabled).toBe(false)
      // 不影响 pixelCompare
      expect(opts.pixelCompareEnabled).toBe(true)
    })

    it('loadConfigFn 返回自定义 imageResize 参数 → Executor opts 字段一对一映射', () => {
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn({
          imageResize: { enabled: true, pxPerToken: 14, maxTargetPx: 800, maxTargetTokens: 800 },
          pixelCompare: { enabled: true },
        }),
      )
      expect(opts.imageResize.params.pxPerToken).toBe(14)
      expect(opts.imageResize.params.maxTargetPx).toBe(800)
      expect(opts.imageResize.params.maxTargetTokens).toBe(800)
    })

    it('loadConfigFn 返回完全相反的全 false → Executor opts 全 false（守约 plumbing 不丢字段）', () => {
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn({
          imageResize: { enabled: false, pxPerToken: 1, maxTargetPx: 1, maxTargetTokens: 1 },
          pixelCompare: { enabled: false },
        }),
      )
      expect(opts.pixelCompareEnabled).toBe(false)
      expect(opts.imageResize.enabled).toBe(false)
      expect(opts.imageResize.params.pxPerToken).toBe(1)
      expect(opts.imageResize.params.maxTargetPx).toBe(1)
      expect(opts.imageResize.params.maxTargetTokens).toBe(1)
    })
  })

  describe('opts 透传给 loadConfigFn', () => {
    it('manifestRoot 显式传 → loadConfigFn 收到对应 manifestRoot', () => {
      const fn = vi.fn((_appId: string, _defaults: unknown, opts?: { manifestRoot?: string }) => {
        return TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT
      }) as unknown as LoadAppConfigFn
      buildTabDesktopExecutorConstructorOptions(fn, {
        manifestRoot: '/explicit/path',
      })
      expect(fn).toHaveBeenCalledTimes(1)
      const opts = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]
      expect(opts?.manifestRoot).toBe('/explicit/path')
    })

    it('diagnostics 显式传 → loadConfigFn 收到对应 diagnostics 回调', () => {
      const onMissing = vi.fn()
      const fn = vi.fn((
        _appId: string,
        _defaults: unknown,
        opts?: { diagnostics?: { onExplicitMissing?: (info: { tried: string; appId: string }) => void } },
      ) => {
        // 模拟 loadAppConfig 在 manifestRoot 不存在时调诊断回调
        opts?.diagnostics?.onExplicitMissing?.({ tried: '/bad/path', appId: 'tabdesktop' })
        return TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT
      }) as unknown as LoadAppConfigFn
      buildTabDesktopExecutorConstructorOptions(fn, {
        manifestRoot: '/bad/path',
        diagnostics: { onExplicitMissing: onMissing },
      })
      expect(onMissing).toHaveBeenCalledWith({ tried: '/bad/path', appId: 'tabdesktop' })
    })

    it('manifestRoot 不传（开发态）→ loadConfigFn 收到 undefined manifestRoot', () => {
      const fn = vi.fn((_appId: string, _defaults: unknown) => {
        return TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT
      }) as unknown as LoadAppConfigFn
      buildTabDesktopExecutorConstructorOptions(fn)
      const opts = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]
      expect(opts?.manifestRoot).toBeUndefined()
    })
  })

  describe('回归保险 · M1+ 改 plumbing 时这条会守住接通胶水不破', () => {
    it('hard-default 与 packages/apps/tabdesktop/app.json 默认值始终一致（漂移立即报错）', () => {
      // 这条断言守约：如果有人改了 hard-default 但没同步 app.json（或反过来），
      // 漂移会被发现。M1 改 plumbing 加新字段时也要相应扩 hard-default。
      expect(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT.imageResize.enabled).toBe(true)
      expect(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT.imageResize.pxPerToken).toBe(28)
      expect(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT.imageResize.maxTargetPx).toBe(1568)
      expect(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT.imageResize.maxTargetTokens).toBe(1568)
      expect(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT.pixelCompare.enabled).toBe(true)
    })

    it('字段映射形态 · 加新字段守约（M1 加 tier 时本测试加新断言即可发现接通漂移）', () => {
      // 当前接通的两组字段
      const opts = buildTabDesktopExecutorConstructorOptions(
        mockLoadConfigFn(TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT),
      )
      const optsKeys = Object.keys(opts).sort()
      // v2.2 阶段：仅 pixelCompareEnabled + imageResize 两个顶层 key
      expect(optsKeys).toEqual(['imageResize', 'pixelCompareEnabled'])
      // imageResize 子结构：enabled + params 两个顶层 key
      const imageResizeKeys = Object.keys(opts.imageResize).sort()
      expect(imageResizeKeys).toEqual(['enabled', 'params'])
    })
  })
})

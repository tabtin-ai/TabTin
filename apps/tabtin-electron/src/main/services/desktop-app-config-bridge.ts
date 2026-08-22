/**
 * TabDesktop · app.json → DesktopExecutorService 构造 opts 接通胶水。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.5（v2.1 模块零）+
 * § 9.1 模块零交付记录 + v2.2 扫尾记录（独立验收 P0-1 / P1-1 / P1-2 修）。
 *
 * **背景**：v2.1 模块零落地后，`deferred-init-action-bridge.ts` 直接调
 * `loadAppConfig('tabdesktop', defaults)` + 把结果拼进 Executor 构造 opts。
 * 独立验收（QA 视角 P1-1 + 下游模块依赖 P0-1）发现：
 *
 * 1. **不传 manifestRoot 在 Electron 打包态会 silent fallback 到 defaults**——
 *    生产态 process.cwd() = app.asar 内部，找不到 `packages/apps/`，整条
 *    plumbing 链路又破，等于 v1.8 § 10 Q11 偿还的 false promise 复发；
 * 2. **接通胶水代码本身完全无端到端测试**——M1+ 改 plumbing 加新字段（tier）
 *    时如果改坏 imageResize / pixelCompare 的传值逻辑，所有现有测试都不会
 *    发现。
 *
 * v2.2 修法：把"决定 manifestRoot"+"loadAppConfig + 拼 Executor 构造 opts"
 * 两段逻辑从 deferred-init-action-bridge.ts 抽到本文件，作为**纯函数**：
 *
 * - `resolveTabDesktopAppManifestRoot` —— 入参 `{ isPackaged, resourcesPath }`
 *   显式注入运行时信号，避免直接依赖 `electron.app`，单测可任意构造场景；
 * - `buildTabDesktopExecutorConstructorOptions` —— 入参 `loadConfigFn`
 *   显式注入，单测 mock 返回值后断言生成的 opts 字段一对一正确。
 *
 * 这样后续 M1+ 在 plumbing 加新字段时，只要在本文件改 + 加测试，接通胶水
 * 行为变化能被立即发现，不再依赖"端到端集成 + 真实 Electron 启动"才能验证。
 */

import { join } from 'node:path'
import type { ImageResizeParams } from './desktop-image-resize'
import type {
  AppConfigSource,
  StaticManifestSourceDiagnostics,
} from '@tabtin/app-config'

/**
 * v2.2 模块零扫尾：决定 TabDesktop app.json 的 manifestRoot。
 *
 * 入参显式注入避免本函数依赖 `electron.app` —— 让单元测试能通过传不同
 * `isPackaged` 模拟"开发态"vs"打包态"。
 *
 * 三种返回值：
 * - 打包态（isPackaged=true + 有 resourcesPath）→ 返回
 *   `<resourcesPath>/app.asar.unpacked/packages/apps`
 *   （要求 electron-builder 配置把 `packages/apps` 列进 `asarUnpack`）
 * - 开发态（isPackaged=false）→ 返回 `undefined`，让 loadAppConfig
 *   走自动推断（process.cwd() 或 import.meta.url 上溯，能找到 monorepo 根）
 * - 非常规态（isPackaged=true 但 resourcesPath 缺失/异常）→ 返回 `undefined`
 *   触发 loadAppConfig 自动推断，最终 fallback 到 defaults
 *
 * @param env 运行时信号 `{ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }`
 * @returns 显式 manifestRoot 或 undefined
 */
export function resolveTabDesktopAppManifestRoot(env: {
  isPackaged: boolean
  resourcesPath?: string | undefined
}): string | undefined {
  if (!env.isPackaged) return undefined
  const rp = env.resourcesPath
  if (typeof rp !== 'string' || rp.length === 0) return undefined
  return join(rp, 'app.asar.unpacked', 'packages', 'apps')
}

/**
 * TabDesktop runtime config 的最小集合（仅 v2.1 模块零接通的 imageResize +
 * pixelCompare）。M1+ 加新开关（tier / subGates / coordinateMode）时扩字段。
 */
export interface TabDesktopRuntimeConfig {
  imageResize: {
    enabled: boolean
    pxPerToken: number
    maxTargetPx: number
    maxTargetTokens: number
  }
  pixelCompare: { enabled: boolean }
}

/**
 * Hard-default —— 与 `packages/apps/tabdesktop/app.json` configSchema 默认值
 * + DesktopExecutorService 内部 hard-default 三处必须保持一致。改动前请同步
 * 检查规范 § 4.5.1 / § 4.5.3 + DEFAULT_IMAGE_RESIZE_PARAMS。
 */
export const TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT: TabDesktopRuntimeConfig = {
  imageResize: { enabled: true, pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 },
  pixelCompare: { enabled: true },
}

/**
 * Executor 构造 opts 子集 —— 由本胶水函数构造。`onSessionTimeout` /
 * `mainWindowGetter` 由调用方（deferred-init-action-bridge）负责拼接。
 */
export interface TabDesktopExecutorConfigOptions {
  pixelCompareEnabled: boolean
  imageResize: {
    enabled: boolean
    params: Pick<ImageResizeParams, 'pxPerToken' | 'maxTargetPx' | 'maxTargetTokens'>
  }
}

/**
 * `loadAppConfig` 函数签名抽象——单测注入 mock 函数。
 *
 * 与 `@tabtin/app-config.loadAppConfig` 完全一致，但用本地接口避免单测
 * 强制 import 真实包（更轻、更可控）。
 */
export type LoadAppConfigFn = <T extends Record<string, unknown>>(
  appId: string,
  defaults: T,
  opts?: {
    override?: Record<string, unknown>
    sources?: AppConfigSource[]
    manifestRoot?: string
    diagnostics?: StaticManifestSourceDiagnostics
  },
) => T

/**
 * v2.2 模块零扫尾：把 `loadAppConfig` 调用 + 拼 Executor 构造 opts 的接通胶水
 * 抽成纯函数，可被单测显式断言。
 *
 * @param loadConfigFn loadAppConfig 函数引用（生产传 `@tabtin/app-config.loadAppConfig`，单测传 mock）
 * @param opts plumbing 选项：manifestRoot（生产打包态显式传，开发态 undefined）+ diagnostics 回调
 * @returns Executor 构造 opts 子集（pixelCompareEnabled + imageResize.{enabled, params}）
 *
 * **使用契约**：
 * - 调用方拿到返回值后**不能再覆盖** `pixelCompareEnabled` / `imageResize`——
 *   这是 plumbing 的最终决定值；只能在外面拼 `onSessionTimeout` /
 *   `mainWindowGetter` 等"运行时关切"字段
 * - 任何 loadConfigFn 抛错 / 返回不完整对象的容错都依赖 loadConfigFn 自身
 *   实现（@tabtin/app-config 已保证不抛 + 缺字段走 defaults）
 */
export function buildTabDesktopExecutorConstructorOptions(
  loadConfigFn: LoadAppConfigFn,
  opts?: {
    manifestRoot?: string | undefined
    diagnostics?: StaticManifestSourceDiagnostics
  },
): TabDesktopExecutorConfigOptions {
  const cfg = (loadConfigFn as unknown as <T>(appId: string, defaults: T, opts?: { manifestRoot?: string; diagnostics?: StaticManifestSourceDiagnostics }) => T)<TabDesktopRuntimeConfig>(
    'tabdesktop',
    TABDESKTOP_RUNTIME_CONFIG_HARD_DEFAULT,
    {
      manifestRoot: opts?.manifestRoot,
      diagnostics: opts?.diagnostics,
    },
  )
  return {
    pixelCompareEnabled: cfg.pixelCompare.enabled,
    imageResize: {
      enabled: cfg.imageResize.enabled,
      params: {
        pxPerToken: cfg.imageResize.pxPerToken,
        maxTargetPx: cfg.imageResize.maxTargetPx,
        maxTargetTokens: cfg.imageResize.maxTargetTokens,
      },
    },
  }
}

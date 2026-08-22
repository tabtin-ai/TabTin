/**
 * @tabtin/app-config —— App configSchema 通用 runtime 读取层（v2.1 模块零）。
 *
 * 规范出处：`docs/planning/tabdesktop-spec-v1.md` § 3.5.5 + § 9.1（v2.0 占位
 * → v2.1 模块零落地）。同时偿还 § 10 Q11 登记的 "TabDesktop app.json 开关
 * 声明了不生效"债（v1.8 SKILL false promise 修正）。
 *
 * **解决什么问题**：v1.8 之前 TabTin 全仓没有"App configSchema → runtime
 * config"读取路径——`packages/apps/<id>/app.json` 的 configSchema 字段都是
 * "声明了不生效"。模块零建立通用基础设施，TabDesktop 是首批接入；模块一
 * tier / 模块二 subGates / 模块四 coordinateMode 落地时复用同一 API。
 *
 * **本包不做的事**：
 * - 实时热更新（app.json 改动监听 / IPC 推送）—— 留给 Space 配置热更新 Wave；
 * - JSON Schema 校验 —— configSchema 字段集合由调用方按 TS 类型保证；
 * - 用户级 override 持久化 —— v1 阶段 override 只能从代码侧显式传，UI 入口
 *   留给 Space 设置 Wave。
 *
 * **能做的事（v1）**：
 * - `loadAppConfig(appId, defaults, opts?)`：读 `packages/apps/<appId>/app.json`
 *   的 configSchema → 提取 default 字段 → deep merge 到调用方传入的 defaults
 *   上 → 再叠加 opts.override → 返回最终 runtime config；
 * - 容错：app.json 不存在 / 解析失败 / configSchema 缺失 / 默认值缺失，全部
 *   降级到调用方 defaults，不抛错（不让 TabTin 启动被一个配置文件错误卡死）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// app.json 类型（仅本包用，最小化）
// ---------------------------------------------------------------------------

/**
 * app.json 中我们关心的字段。configSchema 是 JSON Schema 子集——本包只读
 * `properties.<key>.default` 字段，不做完整 schema 校验。
 */
interface AppManifestSlice {
  configSchema?: {
    type?: string
    properties?: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------
// AppConfigSource 抽象（为未来 Space 配置热更新留接口位）
// ---------------------------------------------------------------------------

/**
 * 一个 App 配置来源。当前 v1 只实现 staticManifestSource（读 app.json defaults）；
 * 未来 userOverrideSource / spacePushSource / agentRuntimeSource 都按此接口
 * 实现，loadAppConfig 按优先级合并。
 */
export interface AppConfigSource {
  /** 来源标识，便于审计 / 调试。 */
  readonly name: string
  /**
   * 返回该来源下指定 appId 的配置 partial（key → value，浅层 partial，
   * deep merge 由 loadAppConfig 内部统一处理）。
   * 来源不可用 / 字段缺失时返回空对象，不抛错。
   */
  read(appId: string): Record<string, unknown>
}

// ---------------------------------------------------------------------------
// staticManifestSource —— 从 packages/apps/<id>/app.json 读 configSchema 默认值
// ---------------------------------------------------------------------------

/**
 * 计算包含 packages/apps/<appId>/app.json 的候选目录列表。
 *
 * 候选搜索路径（按优先级）：
 * 1. 调用方显式传入的 `manifestRoot`（推荐，避免运行时路径推断不确定性）
 * 2. process.cwd() 上溯到包含 `packages/apps/` 的目录
 * 3. 当前文件所在 dist 目录上溯——同样找 `packages/apps/`
 *
 * 三条路径都要存在性兜底——TabTin 客户端、Daemon、CI、单测可能从不同
 * cwd 启动。
 */
/**
 * v2.2 模块零扫尾（独立验收 P0-1 修）：诊断 manifestRoot 解析结果。
 *
 * 三种返回值——调用方按 status 决定要不要 warn：
 * - `{ status: 'explicit-found', root }`：显式传入路径且存在，**最理想**（生产打包态推荐）
 * - `{ status: 'explicit-missing', tried }`：**显式传了但路径不存在 → 几乎一定是 bug**
 *   （Electron 打包态忘了把 packages/apps 列进 asarUnpack；调用方应该显式 warn）
 * - `{ status: 'auto-found', root }`：未显式传，从 cwd / 包路径自动推断到了（开发 / 单测 / CI 通常走这条）
 * - `{ status: 'auto-missing' }`：未显式传，自动推断也找不到（可能是非 monorepo 子目录运行
 *   或测试隔离环境——v2.1 之前是默认场景，不强制 warn）
 */
function resolveManifestRoot(
  explicit?: string,
):
  | { status: 'explicit-found'; root: string }
  | { status: 'explicit-missing'; tried: string }
  | { status: 'auto-found'; root: string }
  | { status: 'auto-missing' } {
  if (explicit) {
    const resolved = resolve(explicit)
    return existsSync(resolved)
      ? { status: 'explicit-found', root: resolved }
      : { status: 'explicit-missing', tried: resolved }
  }

  const tryFromDir = (start: string): string | null => {
    let cur = start
    for (let i = 0; i < 10; i++) {
      const candidate = join(cur, 'packages', 'apps')
      if (existsSync(candidate)) return candidate
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return null
  }

  const fromCwd = tryFromDir(process.cwd())
  if (fromCwd) return { status: 'auto-found', root: fromCwd }

  // 当前 .js 在 dist/ 下，向上找
  try {
    const here = fileURLToPath(import.meta.url)
    const fromHere = tryFromDir(dirname(here))
    if (fromHere) return { status: 'auto-found', root: fromHere }
  } catch {
    // import.meta.url 在某些 jest / commonjs 环境不可用 —— 走 cwd 路径已足够
  }
  return { status: 'auto-missing' }
}

/**
 * v1 兼容入口：调用方只关心"找没找到"时用这个；要诊断 status 走 resolveManifestRoot。
 */
function findManifestRoot(explicit?: string): string | null {
  const r = resolveManifestRoot(explicit)
  if (r.status === 'explicit-found' || r.status === 'auto-found') return r.root
  return null
}

/**
 * 从 app.json `configSchema.properties.<key>.default`（含嵌套对象）抽出
 * 默认值树。
 *
 * 例：
 * ```json
 * "configSchema": {
 *   "properties": {
 *     "imageResize": {
 *       "type": "object",
 *       "properties": {
 *         "enabled": { "type": "boolean", "default": true },
 *         "pxPerToken": { "type": "number", "default": 28 }
 *       }
 *     },
 *     "pixelCompare": {
 *       "type": "object",
 *       "properties": { "enabled": { "type": "boolean", "default": true } }
 *     }
 *   }
 * }
 * ```
 * 输出：
 * ```json
 * {
 *   "imageResize": { "enabled": true, "pxPerToken": 28 },
 *   "pixelCompare": { "enabled": true }
 * }
 * ```
 */
function extractDefaults(schema: AppManifestSlice['configSchema']): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {}
  const props = (schema as { properties?: Record<string, unknown> }).properties
  if (!props || typeof props !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(props)) {
    if (!val || typeof val !== 'object') continue
    const node = val as Record<string, unknown>
    if ('default' in node) {
      out[key] = node.default
      continue
    }
    if (node.type === 'object' && node.properties) {
      const nested = extractDefaults({ properties: node.properties as Record<string, unknown> })
      if (Object.keys(nested).length > 0) {
        out[key] = nested
      }
    }
  }
  return out
}

/**
 * `createStaticManifestSource` 的可选诊断回调。
 *
 * v2.2 模块零扫尾（独立验收 P0-1 修）：让调用方在显式传 manifestRoot 但路径
 * 不存在时收到信号——这几乎一定是 bug（Electron 打包态忘配 asarUnpack 等），
 * 不能再像 v2.1 那样 silent fallback 到 defaults。
 *
 * 默认行为（不传 onMissing）：在 `process.env.NODE_ENV !== 'test'` 时走
 * `console.warn`；测试环境保持静默避免干扰测试输出。
 */
export interface StaticManifestSourceDiagnostics {
  /**
   * 显式传了 manifestRoot 但路径不存在时调用。
   * @param info `{ tried }` —— resolve 后的绝对路径，便于排查
   */
  onExplicitMissing?: (info: { tried: string; appId: string }) => void
  /**
   * 自动推断也找不到 packages/apps 时调用（可选——这条在测试 / 子目录场景常见，
   * 默认不警告，由调用方决定是否启用）。
   */
  onAutoMissing?: (info: { appId: string }) => void
}

function defaultExplicitMissingWarn(info: { tried: string; appId: string }): void {
  // 测试环境静默，避免污染测试输出
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return
  // eslint-disable-next-line no-console
  console.warn(
    `[@tabtin/app-config] 显式传入的 manifestRoot 不存在: ${info.tried}（appId=${info.appId}）。` +
    `本次配置读取将 fallback 到调用方 defaults——若该 App 的 configSchema 期望生效，请检查打包态是否正确配置 asarUnpack。`,
  )
}

/**
 * 创建从 packages/apps/<id>/app.json 读 configSchema 默认值的 source。
 *
 * @param opts.manifestRoot 可选 packages/apps/ 绝对路径；默认从 cwd / 包路径推断
 * @param opts.diagnostics 可选诊断回调集合；不传则 explicit-missing 走默认 console.warn
 */
export function createStaticManifestSource(opts?: {
  manifestRoot?: string
  diagnostics?: StaticManifestSourceDiagnostics
}): AppConfigSource {
  const onExplicitMissing = opts?.diagnostics?.onExplicitMissing ?? defaultExplicitMissingWarn
  const onAutoMissing = opts?.diagnostics?.onAutoMissing
  return {
    name: 'static-manifest',
    read(appId: string): Record<string, unknown> {
      const r = resolveManifestRoot(opts?.manifestRoot)
      if (r.status === 'explicit-missing') {
        onExplicitMissing({ tried: r.tried, appId })
        return {}
      }
      if (r.status === 'auto-missing') {
        onAutoMissing?.({ appId })
        return {}
      }
      const root = r.root
      const manifestPath = join(root, appId, 'app.json')
      if (!existsSync(manifestPath)) return {}
      try {
        const raw = readFileSync(manifestPath, 'utf-8')
        const json = JSON.parse(raw) as AppManifestSlice
        return extractDefaults(json.configSchema)
      } catch {
        // 解析失败 → 不抛错，调用方走传入 defaults
        return {}
      }
    },
  }
}

// ---------------------------------------------------------------------------
// loadAppConfig —— 主入口
// ---------------------------------------------------------------------------

/**
 * Deep merge 两个 plain object（层数有限，仅处理 plain object，不处理
 * Map / Set / 类实例）。后者覆盖前者；后者中 undefined 值不覆盖前者。
 */
function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  if (!patch) return base
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const existing = out[k]
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        existing as Record<string, unknown>,
        v as Record<string, unknown>,
      )
    } else {
      out[k] = v
    }
  }
  return out as T
}

/**
 * `loadAppConfig` 配置项。
 */
export interface LoadAppConfigOptions {
  /**
   * 显式 override —— 最高优先级，主要用于测试和 ad-hoc 实例化。
   * 如：`loadAppConfig('tabdesktop', defaults, { override: { pixelCompare: { enabled: false } } })`。
   */
  override?: Record<string, unknown>
  /**
   * 自定义来源链（按优先级从低到高，后面的覆盖前面的）。默认：
   * `[createStaticManifestSource()]`，即只从 app.json 读默认值。
   * 未来加 userOverrideSource / spacePushSource 时按此机制扩展。
   */
  sources?: AppConfigSource[]
  /**
   * 自定义 packages/apps/ 绝对路径（透传给默认 staticManifestSource）。
   *
   * **生产打包态强烈建议显式传**——v2.2 模块零扫尾（独立验收 P0-1）已修复
   * 默认 staticManifestSource 在 `manifestRoot` 显式不存在时会调
   * `diagnostics.onExplicitMissing`（默认走 `console.warn`），不再 silent
   * fallback 隐藏 plumbing 失效。
   */
  manifestRoot?: string
  /**
   * v2.2 模块零扫尾：诊断回调透传到默认 staticManifestSource。详见
   * {@link StaticManifestSourceDiagnostics}。
   *
   * 仅对未自定义 `sources` 时生效（自定义 sources 时调用方自行决定诊断逻辑）。
   */
  diagnostics?: StaticManifestSourceDiagnostics
}

/**
 * 加载指定 App 的 runtime config。
 *
 * 合并优先级（从低到高）：调用方 `defaults` < 来源链各 source.read() < `opts.override`。
 *
 * 错误兜底：所有来源失败都不抛错，最终返回 `defaults` ——避免 TabTin 启动
 * 被一个 App 的配置文件错误卡死。
 *
 * **打包 / 非常规 cwd 注意（v2.1 技术 Review §5 修）**：默认 `staticManifestSource`
 * 通过 `findManifestRoot` 从 `process.cwd()` + `import.meta.url` 上溯查找
 * `packages/apps/` 目录。开发 / CI / 单测环境通常足够；**Electron 打包后**
 * 资源布局会变（main 进程的 cwd 可能是 `process.resourcesPath` 而不是源码根），
 * 此时若不显式传 `opts.manifestRoot`，函数会 silent fallback 到 `defaults`，
 * 行为"安全但难排查"。生产代码建议**显式传 manifestRoot**——例如 Electron
 * 主进程可写：
 *
 * ```ts
 * import { app } from 'electron'
 * import { join } from 'node:path'
 * const manifestRoot = app.isPackaged
 *   ? join(process.resourcesPath, 'app.asar.unpacked', 'packages', 'apps')
 *   : undefined  // 开发态走自动推断
 * loadAppConfig('tabdesktop', defaults, { manifestRoot })
 * ```
 *
 * @param appId    App 标识，对应 packages/apps/<appId>/app.json。
 * @param defaults 调用方代码侧的默认值（最低优先级，永不丢失字段）。
 * @param opts     来源链 / override / 路径定制。
 * @returns        最终合并出的 runtime config（与 defaults 类型一致）。
 *
 * @example
 * ```ts
 * import { loadAppConfig } from '@tabtin/app-config'
 *
 * interface TabDesktopConfig {
 *   imageResize: { enabled: boolean; pxPerToken: number; maxTargetPx: number; maxTargetTokens: number }
 *   pixelCompare: { enabled: boolean }
 * }
 *
 * const cfg = loadAppConfig<TabDesktopConfig>('tabdesktop', {
 *   imageResize: { enabled: true, pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 },
 *   pixelCompare: { enabled: true },
 * })
 *
 * new DesktopExecutorService(getter, {
 *   pixelCompareEnabled: cfg.pixelCompare.enabled,
 *   imageResizeDefaults: cfg.imageResize,
 * })
 * ```
 */
export function loadAppConfig<T extends Record<string, unknown>>(
  appId: string,
  defaults: T,
  opts?: LoadAppConfigOptions,
): T {
  const sources =
    opts?.sources ??
    [createStaticManifestSource({
      manifestRoot: opts?.manifestRoot,
      diagnostics: opts?.diagnostics,
    })]

  let merged: T = { ...defaults }
  for (const src of sources) {
    try {
      const partial = src.read(appId)
      if (partial && typeof partial === 'object') {
        merged = deepMerge(merged, partial)
      }
    } catch {
      // 单个来源失败不影响其他来源 —— 也不影响最终降级到 defaults
    }
  }
  if (opts?.override) {
    merged = deepMerge(merged, opts.override)
  }
  return merged
}

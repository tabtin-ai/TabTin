/**
 * marketplaceToolCardDiscovery — App 平台 H1 / Wave B-B2 双通道扫描
 *
 * 在编译期通过 Vite `import.meta.glob({ eager: true })` 静态扫描 marketplace App
 * 目录下两类 Tool Card 物料；运行期无 IO。
 *
 * **打包范围口径（必读）**：eager glob 在编译期把 `packages/apps/* /tool-cards.json`
 * 与 `packages/apps/* /tool-cards/*.tsx` 全部静态 import 到依赖图——**只要 monorepo 内
 * 存在物料文件，对应 descriptor / factory tsx 都会进入 renderer bundle**，与"用户是否
 * 在 device 上装了这个 marketplace App"无关。后续 App 数量 / factory 体积大幅增长时，
 * 需评估改 `eager: false` + 运行时按 appId 动态注册（详见 PRD §13.4 H2-7 marketplace
 * SDK 候选）。
 *
 * 优先级（合并到 TOOL_CARDS 时由调用方按以下顺序 spread）:
 *   1. 主仓 spread（FILE_TOOL_CARDS / TERMINAL_TOOL_CARDS / … 19 builtin 域）
 *   2. manifest 通道：packages/apps/<id>/tool-cards.json
 *   3. factory 通道：packages/apps/<id>/tool-cards/<name>.tsx
 *
 * 同名 toolName 出现在多通道时高优先级胜出（factory > manifest > 主仓 spread）。
 * 详见 toolCardRegistry.ts 注释 + __tests__/toolCardRegistry.test.ts。
 *
 * 关键决策：本扫描不读取 `_renderers/` 子目录（下划线前缀，glob `*.tsx` 不递归）；
 * factory tsx 内部可 import 同 App 内部共享 React 组件而不会被误识别为 descriptor 来源。
 */

import type { ToolCardDescriptor } from '@tabtin/chat-client'

/** manifest tool-cards.json 文件的 entry 形态：不含函数字段（compactSummary / extractOutput） */
export type ManifestToolCardEntry = Omit<ToolCardDescriptor, 'compactSummary' | 'extractOutput'>

/** manifest tool-cards.json 文件的整体形态：toolName → entry，外加可选的 $schema/$comment 元字段 */
export type ManifestToolCardFile = Record<string, ManifestToolCardEntry | string | undefined>

/** factory tsx 文件的默认导出形态 */
interface FactoryModule {
  default: ToolCardDescriptor
}

/**
 * Vite 编译期 glob 扫描结果。
 *
 * 路径选用相对路径（8 级 `..`）而非别名 `@apps-marketplace/*`，原因：
 * 1. Vite 6 的 `import.meta.glob` 对 alias 模式在某些版本仍有限制（无 wildcard 通配组合）；
 * 2. 相对路径不依赖 alias 配置，与 vitest / electron-vite / rollup 三套工具链行为一致。
 *
 * fs.allow 已在 `electron.vite.config.ts` renderer.server.fs 中扩展到 workspace root，
 * 确保 dev server 能访问 packages/apps/*。Vitest 端默认 fs.allow 已宽于 vite dev，
 * 因此无需在 `vitest.config.ts` 显式扩展（实测 24 测试全绿）。
 */
const manifestModules = import.meta.glob<ManifestToolCardFile>(
  '../../../../../../../../packages/apps/*/tool-cards.json',
  { eager: true, import: 'default' },
)

const factoryModules = import.meta.glob<FactoryModule>(
  '../../../../../../../../packages/apps/*/tool-cards/*.tsx',
  { eager: true },
)

/** 内部：从 glob 结果路径中抽取 appId（packages/apps/<appId>/...） */
function extractAppIdFromPath(path: string): string | null {
  const match = path.match(/\/packages\/apps\/([^/]+)\//)
  return match?.[1] ?? null
}

/** 内部：把 manifest entry 提升为完整 ToolCardDescriptor（无函数字段） */
function manifestEntryToDescriptor(toolName: string, entry: ManifestToolCardEntry): ToolCardDescriptor | null {
  if (!entry || typeof entry !== 'object') return null
  if (entry.id !== toolName) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[marketplaceToolCardDiscovery] manifest entry id "${entry.id}" 与 key "${toolName}" 不一致，已跳过`,
      )
    }
    return null
  }
  return { ...entry } as ToolCardDescriptor
}

/** 扫描结果 */
export interface DiscoveryResult {
  manifestCards: Record<string, ToolCardDescriptor>
  factoryCards: Record<string, ToolCardDescriptor>
  /** 调试：每个 toolName 的来源 App + 通道，便于优先级覆盖问题排查 */
  sources: Record<string, { appId: string; channel: 'manifest' | 'factory' }>
}

/**
 * 收集双通道发现结果。
 *
 * - manifestCards：按 manifest 文件 key (toolName) → descriptor；多个 App 同 toolName 时
 *   后扫到的覆盖前者（实际不应发生，会打 warning）。
 * - factoryCards：按 default export 的 descriptor.id (toolName) → descriptor；多个 factory
 *   tsx 同 toolName 时后扫到的覆盖前者（同上，会打 warning）。
 */
export function discoverMarketplaceToolCards(): DiscoveryResult {
  const manifestCards: Record<string, ToolCardDescriptor> = {}
  const factoryCards: Record<string, ToolCardDescriptor> = {}
  const sources: Record<string, { appId: string; channel: 'manifest' | 'factory' }> = {}

  for (const [path, file] of Object.entries(manifestModules)) {
    const appId = extractAppIdFromPath(path)
    if (!appId || !file) continue
    for (const [toolName, raw] of Object.entries(file)) {
      if (toolName.startsWith('$')) continue
      if (typeof raw === 'string' || raw == null) continue
      const descriptor = manifestEntryToDescriptor(toolName, raw)
      if (!descriptor) continue
      if (manifestCards[toolName] && process.env.NODE_ENV !== 'production') {
        console.warn(
          `[marketplaceToolCardDiscovery] manifest tool "${toolName}" 在多个 App 中重复声明，` +
          `previous=${sources[toolName]?.appId} now=${appId}，后者覆盖前者`,
        )
      }
      manifestCards[toolName] = descriptor
      sources[toolName] = { appId, channel: 'manifest' }
    }
  }

  for (const [path, mod] of Object.entries(factoryModules)) {
    const appId = extractAppIdFromPath(path)
    if (!appId || !mod) continue
    const descriptor = mod.default
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.id !== 'string') {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`[marketplaceToolCardDiscovery] factory ${path} 缺少 default export ToolCardDescriptor`)
      }
      continue
    }
    const toolName = descriptor.id
    if (factoryCards[toolName] && process.env.NODE_ENV !== 'production') {
      console.warn(
        `[marketplaceToolCardDiscovery] factory tool "${toolName}" 在多个 App 中重复声明，` +
        `后者覆盖前者：${path}`,
      )
    }
    factoryCards[toolName] = descriptor
    sources[toolName] = { appId, channel: 'factory' }
  }

  return { manifestCards, factoryCards, sources }
}

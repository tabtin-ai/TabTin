/**
 * 同步从 `packages/prompt-contract/src/registry-entries.generated.ts` 抽取
 * REGISTRY_ENTRIES 数据，供本目录三条 ESLint 规则使用。
 *
 * 设计取舍：
 *   - 不依赖 `dist/`：lint 跑在 source（无需 prompt-contract build），避免
 *     "改完没 build → lint 跑老数据"的脏状态
 *   - 不依赖外部 JSON5 / ts-node：generated.ts 已是 100% JSON 字面量风格
 *     （所有 key 双引号，无注释），剥头剥尾 `new Function('return ...')` 即可
 *     安全求值。trailing-comma 这种 JSON 不接受、JS 接受的差异由 `new Function`
 *     吃掉
 *   - 文件本地受控（自家仓库 generated 产物），不存在任意代码注入风险
 *
 * 失败语义：generated.ts 缺失 / 解析失败时不抛异常，而是返回 `error` 字段。
 * 规则文件读到 error 时应当 fail-open：不报告任何 violation，并在 description
 * 里提示治理者跑 `extract_renderers.py`。这是治理基线第一波的设计——既不希望
 * generated 缺失阻断整个仓 lint，也不希望它在缺失时假装"全部合规"。
 *
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const GENERATED_PATH = join(__dirname, '..', 'src', 'registry-entries.generated.ts')

/** @type {{ entries: any[]; error: string | null } | null} */
let cache = null

/** 重置 cache（仅供测试用） */
export function _resetRegistryCache() {
  cache = null
}

/**
 * 同步加载注册表数据。多次调用走 cache。
 * @returns {{ entries: any[]; error: string | null }}
 */
export function loadRegistryEntries() {
  if (cache !== null) return cache

  if (!existsSync(GENERATED_PATH)) {
    cache = {
      entries: [],
      error: `registry-entries.generated.ts not found at ${GENERATED_PATH}.`,
    }
    return cache
  }

  let text
  try {
    text = readFileSync(GENERATED_PATH, 'utf-8')
  } catch (err) {
    cache = { entries: [], error: `readFileSync failed: ${String(err)}` }
    return cache
  }

  // generated.ts 形态：
  //   import type { ... } from '...'
  //   export const REGISTRY_ENTRIES: SectionDescriptor[] = [
  //     { ... },
  //     ...
  //   ];
  //
  // 切片 `= [` 之后 + `];` 之前的数组字面量。
  const startIdx = text.indexOf('= [')
  const endIdx = text.lastIndexOf('];')
  if (startIdx < 0 || endIdx < 0) {
    cache = {
      entries: [],
      error: 'cannot locate REGISTRY_ENTRIES array bounds in generated.ts',
    }
    return cache
  }

  const arrayText = text.slice(startIdx + 2, endIdx + 1)
  try {
    // generated.ts 受控产物，trailing comma 等 JS 风味用 `new Function` 吃掉。
    // 输入来自自家仓库 build artifact，无外部用户输入路径，无注入风险。
    const entries = new Function(`return ${arrayText}`)()
    if (!Array.isArray(entries)) {
      cache = { entries: [], error: 'parsed REGISTRY_ENTRIES is not an array' }
    } else {
      cache = { entries, error: null }
    }
  } catch (err) {
    cache = { entries: [], error: `parse failed: ${String(err)}` }
  }
  return cache
}

/**
 * 工具 id（带 `_tool` 后缀）→ { tier, charBudget } 映射。
 * 给 `tool-description-length` 规则用。
 *
 * @returns {Map<string, { tier: string; charBudget: number }>}
 */
export function getToolTierMap() {
  const { entries } = loadRegistryEntries()
  const map = new Map()
  for (const e of entries) {
    if (e && e.category === 'tool_description' && e.tier && typeof e.charBudget === 'number') {
      map.set(e.id, { tier: e.tier, charBudget: e.charBudget })
    }
  }
  return map
}

/**
 * 所有 section id（含 tool / hook / base / etc.）集合。
 * 给 `section-name-match` 规则用。
 *
 * @returns {Set<string>}
 */
export function getSectionIdSet() {
  const { entries } = loadRegistryEntries()
  return new Set(entries.map((e) => e.id))
}

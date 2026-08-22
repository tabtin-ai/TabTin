/**
 * PlatformSurface 工厂函数。
 *
 * 一份 service 声明 → 自动注册到全局 registry → 返回冻结的
 * RegisteredSurface 供 IPC / HTTP adapter 消费。
 *
 * 这是开发者使用 PlatformSurface 框架的主入口。典型用法：
 *
 * ```ts
 * const chatExportMd = definePlatformSurface({
 *   module: 'chat',
 *   verb: 'export-md',
 *   kind: 'local',
 *   errorCodes: ['SESSION_NOT_FOUND', 'EXPORT_FAILED'] as const,
 *   handler: async (input, ctx) => { ... },
 *   bindings: { ipc: true, http: true },
 * })
 * ```
 */

import type {
  PlatformSurfaceDef,
  RegisteredSurface,
  SurfaceKind,
} from './types.js'
import { _registerSurface } from './registry.js'

/**
 * module / verb 命名格式校验正则。
 *
 * D-5 规则：只允许 `[a-z][a-z0-9-]*`——小写字母开头，后续可包含
 * 小写字母、数字、连字符。不允许大写、下划线、空格、中文等。
 *
 * 这个约束保证：
 *   - IPC channel `chat:export-md` 与 HTTP path `/chat/export-md` 一一映射
 *   - CLI 命令 `tabtin chat export-md` 与 Go cobra 命名一致
 *   - grep 时不需要处理大小写 / 特殊字符
 */
const _MODULE_VERB_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 校验 module / verb 格式是否合法。
 * 不合法时抛出描述性错误，包含具体哪个字段、什么值、期望什么格式。
 */
function _validateModuleVerb(field: string, value: string): void {
  if (!_MODULE_VERB_PATTERN.test(value)) {
    throw new Error(
      `[PlatformSurface] ${field} "${value}" 格式不合法。` +
      `要求：以小写字母开头，只包含小写字母、数字、连字符（正则：${_MODULE_VERB_PATTERN.source}）`,
    )
  }
}

/**
 * 校验 alias 格式：必须是 `module:verb`（IPC channel 风格）或
 * `module/verb`（HTTP path 风格），且 module/verb 段都符合
 * D-5 规范。
 *
 * 历史背景：迁移期 alias 主要用于兼容旧 IPC channel（如
 * `chat:closeDetached` 这种 camelCase 旧名）。这里我们**保留**对
 * camelCase verb 段的容忍——只要分隔符是 `:` 或 `/`、module 段合法即可。
 *
 * 拒绝的形态：
 *   - 完全无分隔符（如 "chatExportMd"——无法派生 httpPath）
 *   - 自引用（alias 等于主 channel——重复注册必抛 ChannelAlreadyRegistered）
 *   - 同一 surface 的 alias 列表内重复
 */
const _ALIAS_SEPARATOR_PATTERN = /^[a-z][a-z0-9-]*[:/][A-Za-z][A-Za-z0-9-]*$/

function _validateAliases(
  module: string,
  verb: string,
  aliases: readonly string[],
): void {
  const mainChannel = `${module}:${verb}`
  const seen = new Set<string>()
  for (const alias of aliases) {
    if (!_ALIAS_SEPARATOR_PATTERN.test(alias)) {
      throw new Error(
        `[PlatformSurface] alias "${alias}" 格式不合法。` +
        `要求：module 段 ${_MODULE_VERB_PATTERN.source}，分隔符 ":" 或 "/"，` +
        `verb 段允许字母/数字/连字符（含 camelCase 兼容形态）`,
      )
    }
    if (alias === mainChannel) {
      throw new Error(
        `[PlatformSurface] alias "${alias}" 与主 channel 重复，` +
        `会触发 registry ChannelAlreadyRegistered。请删除该别名。`,
      )
    }
    if (seen.has(alias)) {
      throw new Error(
        `[PlatformSurface] alias "${alias}" 在 surface "${mainChannel}" 的 aliases 列表内重复。`,
      )
    }
    seen.add(alias)
  }
}

/**
 * 定义并注册一个 PlatformSurface。
 *
 * 行为：
 *   1. 校验 module/verb 格式（只允许 [a-z][a-z0-9-]*）
 *   2. 构造 channel = `${module}:${verb}`、httpPath = `/${module}/${verb}`
 *   3. 注册到全局 registry（重复 channel 抛错）
 *   4. aliases 也注册（指向同一个 surface 实例）
 *   5. 返回 Object.freeze 后的 RegisteredSurface
 *
 * 类型参数全部由 def 推导，调用方不需要显式写泛型。
 */
export function definePlatformSurface<
  K extends SurfaceKind,
  I,
  O,
  ECodes extends string,
>(
  def: PlatformSurfaceDef<K, I, O, ECodes>,
): RegisteredSurface<K, I, O, ECodes> {
  // ── 1. 格式校验 ──
  _validateModuleVerb('module', def.module)
  _validateModuleVerb('verb', def.verb)
  if (def.aliases?.length) {
    _validateAliases(def.module, def.verb, def.aliases)
  }

  // ── 2. 构造派生 ID ──
  const channel = `${def.module}:${def.verb}`

  // http 路径：优先使用自定义 path，否则从 module/verb 派生
  const httpBindings = def.bindings.http
  const customPath =
    typeof httpBindings === 'object' && httpBindings !== null
      ? httpBindings.path
      : undefined
  const httpPath = customPath ?? `/${def.module}/${def.verb}`

  // ── 3. 构造 RegisteredSurface ──
  const surface: RegisteredSurface<K, I, O, ECodes> = Object.freeze({
    channel,
    httpPath,
    def: Object.freeze({ ...def }),
  })

  // ── 4. 注册主 channel ──
  _registerSurface(surface)

  // ── 5. 注册别名（指向同一个 handler，channel/httpPath 不同） ──
  if (def.aliases?.length) {
    for (const alias of def.aliases) {
      _registerSurface(Object.freeze({
        ...surface,
        channel: alias,
        httpPath: `/${alias.replace(':', '/')}`,
      }))
    }
  }

  return surface
}

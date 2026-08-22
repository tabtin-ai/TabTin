/**
 * PlatformSurface 全局注册表。
 *
 * 所有通过 definePlatformSurface 注册的 surface 存放在此。
 * 消费方：
 *   - IPC adapter（registerSurfaceAsIpc）查询后注册 ipcMain.handle
 *   - HTTP adapter（createSurfaceHttpHandler）查询后挂路由
 *   - W4 codegen 遍历生成 cobra 命令 / preload 类型
 *   - W5 `tabtin commands --json` 直接从此读
 *
 * 注册表使用 channel（`${module}:${verb}`）作为 key。alias 也注册
 * 到同一个 Map，指向同一个 RegisteredSurface 实例。
 */

import type { RegisteredSurface } from './types.js'

/**
 * 全局注册表——channel → RegisteredSurface。
 *
 * 使用 `RegisteredSurface<any, any, any, any>` 而非默认泛型参数，
 * 因为各 surface 的 I/O/ECodes 类型各异，Map 需要能存放任意泛型实例。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _registry = new Map<string, RegisteredSurface<any, any, any, any>>()

/**
 * 注册一个 surface 到全局表。
 *
 * channel 重复注册会抛错——同一个 `module:verb` 只能注册一次，
 * 避免两个文件各自声明同名 surface 导致运行时互相覆盖的隐蔽 bug。
 *
 * 前缀 `_` 表示这是框架内部 API（definePlatformSurface 调用），
 * 外部代码不应直接调用。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _registerSurface(surface: RegisteredSurface<any, any, any, any>): void {
  if (_registry.has(surface.channel)) {
    throw new Error(
      `[PlatformSurface] channel "${surface.channel}" 已注册，不允许重复注册。` +
      `如果是别名冲突，请检查 aliases 配置`,
    )
  }
  _registry.set(surface.channel, surface)
}

/**
 * 按 channel 查询已注册的 surface。
 *
 * 返回 undefined 表示该 channel 未注册——调用方应当处理 fallback
 * （譬如 HTTP adapter 返 404，IPC adapter 不注册该 channel）。
 */
export function getSurface(channel: string): RegisteredSurface | undefined {
  return _registry.get(channel)
}

/**
 * 获取所有已注册 surface 的列表（去重，不含 alias）。
 *
 * 去重逻辑：按 `${def.module}:${def.verb}` 作为唯一标识，alias 注册
 * 的条目虽然 channel 不同但 def.module + def.verb 相同，只返回主
 * channel 的那个。W4 `tabtin commands --json` 不应列出别名作为独立命令。
 */
export function getAllSurfaces(): readonly RegisteredSurface[] {
  const seen = new Set<string>()
  const result: RegisteredSurface[] = []
  for (const surface of _registry.values()) {
    const primaryKey = `${surface.def.module}:${surface.def.verb}`
    if (!seen.has(primaryKey)) {
      seen.add(primaryKey)
      result.push(surface)
    }
  }
  return Object.freeze(result)
}

/**
 * 按 HTTP 路径查询已注册的 surface。
 *
 * 遍历 registry 匹配 httpPath（含 alias 注册的条目）。
 * HTTP adapter 在路由分发时使用此方法查找对应的 surface。
 *
 * 注意：当前用线性遍历（registry 条目数 < 100），
 * W6 批量迁完后如果条目过多可以改成 Map<httpPath, surface>。
 */
export function getSurfaceByHttpPath(
  path: string,
): RegisteredSurface | undefined {
  for (const surface of _registry.values()) {
    if (surface.httpPath === path) {
      return surface
    }
  }
  return undefined
}

/**
 * 清空注册表——仅供测试使用。
 *
 * 生产代码绝不应该调用。测试中每个用例 beforeEach 清空，避免
 * 上一个测试注册的 surface 泄漏到下一个测试。
 */
export function _clearRegistry(): void {
  _registry.clear()
}

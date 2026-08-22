/**
 * /surfaces endpoint — 暴露 PlatformSurface 注册表供外部消费。
 *
 * 消费方：
 *   - Go CLI `tabtin commands --json` 合并 surface 信息，
 *     Agent 自动发现新能力
 *   - 调试 / 运维工具查看当前宿主注册了哪些 surface
 *
 * 安全考量：handler 函数是运行时闭包，不能也不应 JSON.stringify，
 * 所以序列化时只输出 surface 的声明元信息（module / verb / kind /
 * errorCodes / bindings / aliases / deprecated / channel / httpPath）。
 *
 * 注册在 auth guard **之后**——调用方必须带 token，避免未授权客户端
 * 枚举宿主能力清单。
 */

import { okResponse } from '@tabtin/agent-wire'
import { sendJSON } from '../http-utils.js'
import type { RouteHandler } from '../server.js'
import { getAllSurfaces } from './registry.js'

/**
 * 单个 surface 的可序列化视图。
 *
 * 不含 handler（运行时函数）。字段名与 PlatformSurfaceDef / RegisteredSurface
 * 保持一一对应，消费方按字面读即可。
 */
export interface SurfaceDescriptor {
  /** 模块名，如 'chat' */
  module: string
  /** 动作名，如 'export-md' */
  verb: string
  /** surface 种类：'local' | 'proxied' */
  kind: string
  /** 业务错误码闭集 */
  errorCodes: readonly string[]
  /** binding 声明 */
  bindings: {
    ipc: boolean
    http: boolean | { method?: string; path?: string }
  }
  /** 别名列表 */
  aliases: string[]
  /** 弃用声明（null 表示未弃用） */
  deprecated: { since: string; replacedBy: string; removeAfter: string } | null
  /** IPC channel 名（`module:verb`） */
  channel: string
  /** HTTP 路径（`/module/verb`） */
  httpPath: string
  /** Risk 标注（L20e）：'' | 'none' | 'write' | 'high-risk-write'；缺省视为 RiskNone */
  risk: string
}

/**
 * 将 RegisteredSurface 转为可序列化的 SurfaceDescriptor。
 *
 * 前缀 _ 标识框架内部 API，外部不应直接调用。
 */
function _toDescriptor(surface: ReturnType<typeof getAllSurfaces>[number]): SurfaceDescriptor {
  const { def } = surface
  return {
    module: def.module,
    verb: def.verb,
    kind: def.kind,
    errorCodes: [...def.errorCodes],
    bindings: {
      ipc: typeof def.bindings.ipc === 'boolean' ? def.bindings.ipc : false,
      http: def.bindings.http,
    },
    aliases: def.aliases ? [...def.aliases] : [],
    deprecated: def.deprecated
      ? { ...def.deprecated }
      : null,
    channel: surface.channel,
    httpPath: surface.httpPath,
    // L20e：透传 risk 字段；未声明时默认空串（视为 RiskNone）
    risk: def.risk ?? '',
  }
}

/**
 * 创建 /surfaces endpoint 的 RouteHandler。
 *
 * GET /surfaces → 200 + okResponse(SurfaceDescriptor[])
 *
 * 此 handler 无需 parseBody（GET 无 body），直接读 registry 序列化返回。
 */
export function createSurfacesEndpoint(): RouteHandler {
  return async (_req, res) => {
    const surfaces = getAllSurfaces()
    const descriptors = surfaces.map(_toDescriptor)
    sendJSON(res, 200, okResponse(descriptors))
  }
}

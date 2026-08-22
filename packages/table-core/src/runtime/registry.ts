import type { TableApiPort, TableRuntimePorts } from './ports'
import type { AppHostClient } from '@tabtin/app-host-sdk'

let runtimePorts: Partial<TableRuntimePorts> = {}

// ─── AppHostClient（统一 HTTP 通道） ─────────────────────────────────

let _appHostClient: AppHostClient | null = null

/**
 * 注入全局 AppHostClient —— 宿主在启动阶段调用
 *
 * 注入后 table-core 内部的 requestJsonApi 会优先委托给
 * client.request()，实现 URL 拼接 / token 注入 / envelope 解包的统一。
 */
export const setAppHostClient = (client: AppHostClient): void => {
  _appHostClient = client
}

export const getAppHostClient = (): AppHostClient | null => {
  return _appHostClient
}

// ─── 注入式 fetch（统一二进制 / multipart / 透明 Response 通道） ──────────
//
// table-core 的导入导出、附件分片中转、公开表单等场景需要 fetch 的完整语义
// （FormData / Blob / 透明 Response），无法套进 TableApiPort 的 JSON envelope
// 形态。这些请求过去直接调全局 `fetch`，在 Electron 生产包里会因为 renderer
// 自定义协议 origin（tabtin-file://app）被业务 API 的 CORS 拒绝。
//
// 这里提供一个可注入的 fetch 实现：Electron 宿主注入 electronFetch（经主进程
// 代理走 Node http，不受 CORS 约束、复用统一重试 / trace / token 链路）；
// Web / AdminDash 不注入，回退到浏览器原生 fetch（同源 / CORS 正常，行为不变）。

let _fetchImpl: typeof globalThis.fetch | null = null

/**
 * 注入全局 fetch 实现 —— 宿主在启动阶段调用。
 *
 * Electron 宿主传入 electronFetch（主进程代理桥接）；不注入时回退浏览器原生
 * fetch。
 */
export const setTableFetch = (fetchImpl: typeof globalThis.fetch): void => {
  _fetchImpl = fetchImpl
}

/**
 * 获取当前生效的 fetch 实现：优先用宿主注入的，否则回退浏览器原生 fetch。
 * 二者都不可用时抛错（运行环境无网络能力）。
 */
export const getTableFetch = (): typeof globalThis.fetch => {
  if (_fetchImpl) return _fetchImpl
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis)
  }
  throw new Error('[table-core] No fetch implementation available')
}

/**
 * 合并 runtime ports。对嵌套 port 对象（如 file、i18n）做 deep merge，
 * 避免后续调用方覆盖前一个调用方注入的同级方法。
 */
export const configureTableRuntime = (next: Partial<TableRuntimePorts>): void => {
  const merged = { ...runtimePorts } as Record<string, unknown>
  for (const [key, value] of Object.entries(next)) {
    const existing = merged[key]
    if (
      existing != null &&
      value != null &&
      typeof existing === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(existing) &&
      !Array.isArray(value)
    ) {
      merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
    } else {
      merged[key] = value
    }
  }
  runtimePorts = merged as Partial<TableRuntimePorts>
}

export const setTableApiPort = (apiPort: TableApiPort): void => {
  configureTableRuntime({ api: apiPort })
}

export const getTableRuntime = (): Readonly<Partial<TableRuntimePorts>> => {
  return runtimePorts
}

export const getTableApiPort = (): TableApiPort | null => {
  return runtimePorts.api ?? null
}

export const getTableFilePort = (): TableRuntimePorts['file'] | null => {
  return runtimePorts.file ?? null
}

export const requireTableApiPort = (): TableApiPort => {
  const apiPort = getTableApiPort()
  if (!apiPort) {
    throw new Error('[table-core] Table API port is not configured')
  }
  return apiPort
}

export const resetTableRuntime = (): void => {
  runtimePorts = {}
  _appHostClient = null
  _fetchImpl = null
}

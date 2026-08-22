/**
 * Daemon Bridge (主进程侧) — 拉 Daemon 注册中心 bucket 数据。
 *
 * 设计意图：
 *   - W2.1 阶段先打桩——把接口契约定义清楚，但实际 wire 留给 W2.3；
 *   - W2.3 实现时：Daemon 端在 `apps/tabtin-daemon/src/cli/routes/storage.ts`
 *     新增 `tabtin-daemon storage list/size/list-items/clear/export` CLI 路由，
 *     主进程通过现有 `cli-server-core` HTTP-over-socket API 调它，再用
 *     本桥包成 RemoteBridge 喂给 RendererStorageBridge；
 *   - 提供 `setDaemonStorageFetcher` 注入点：W2.3 真实接通时只换 fetcher，
 *     不动 renderer-bridge / ipc-bridge。
 *
 * **边界声明（W2.3 接入必读）**：
 *   - 本桥仅覆盖**单 bucket 主线操作**（list / size / list-items / clear / export）
 *   - admin 类操作（vacuum / drain / purge / clear --category）**不走本桥**，
 *     W2.3 直接调 cli-server-core HTTP API（这些是高级 tab 的"高级动作"，
 *     频次低、流程独立、不需要进 storage-manager 注册中心）
 */

import type { ClearOptions } from './bucket.js'
import type {
  BucketCategory,
  BucketClearReport,
  BucketDescriptor,
  BucketGroup,
  BucketItemListReport,
  BucketSizeReport,
  ExportPayload,
} from './ui-protocol.js'

// ── Fetcher 接口（W2.3 实现的实际 transport） ──────────────────

/**
 * Daemon 存储路由的 RPC fetcher。
 *
 * 子命令命名严格对应 RFC §4.4 + Daemon CLI 路由：
 *   - `list`       → `tabtin-daemon storage list`
 *   - `size`       → `tabtin-daemon storage size --bucket <id>`
 *   - `list-items` → `tabtin-daemon storage list-items --bucket <id>`
 *   - `clear`      → `tabtin-daemon storage clear --bucket <id>`
 *   - `export`     → `tabtin-daemon storage export --bucket <id>`
 */
export interface DaemonStorageFetcher {
  /** 列出 Daemon 端所有 bucket（descriptors，已 DTO 化） */
  listBuckets(filter?: {
    group?: BucketGroup
    category?: BucketCategory
    includeHidden?: boolean
  }): Promise<BucketDescriptor[]>
  getBucketSize(id: string): Promise<BucketSizeReport>
  listBucketItems(id: string): Promise<BucketItemListReport>
  clearBucket(id: string, options?: ClearOptions): Promise<BucketClearReport>
  exportBucket(id: string): Promise<ExportPayload>
}

// ── 默认 fetcher：未配置时所有调用直接抛 NotImplementedError ────

export class DaemonBridgeNotConfiguredError extends Error {
  constructor(operation: string) {
    super(
      `[storage-manager/daemon-bridge] ${operation} 调用失败：尚未配置 Daemon fetcher。` +
        `请在主进程启动时调用 setDaemonStorageFetcher(...) 注入 W2.3 实现。`,
    )
    this.name = 'DaemonBridgeNotConfiguredError'
  }
}

const NOT_CONFIGURED: DaemonStorageFetcher = {
  async listBuckets() {
    // 未配置时返回空数组——让 W2.1 的 listAllBuckets() 在 Daemon 没接通时
    // 不至于直接抛错把整个面板炸掉，UI 仍能展示 main + renderer 的 bucket。
    return []
  },
  async getBucketSize() {
    throw new DaemonBridgeNotConfiguredError('getBucketSize')
  },
  async listBucketItems() {
    throw new DaemonBridgeNotConfiguredError('listBucketItems')
  },
  async clearBucket() {
    throw new DaemonBridgeNotConfiguredError('clearBucket')
  },
  async exportBucket() {
    throw new DaemonBridgeNotConfiguredError('exportBucket')
  },
}

let _fetcher: DaemonStorageFetcher = NOT_CONFIGURED

/**
 * 注入 Daemon storage fetcher。W2.3 实现 cli-server-core 调用后在主进程启动时调用。
 * 传 `undefined` 恢复"未配置"模式（用于热替换或测试隔离）。
 */
export function setDaemonStorageFetcher(
  fetcher: DaemonStorageFetcher | undefined,
): void {
  _fetcher = fetcher ?? NOT_CONFIGURED
}

/** 当前是否已注入真实 fetcher。UI 概览页可据此提示"Daemon 未连接"。 */
export function isDaemonStorageFetcherConfigured(): boolean {
  return _fetcher !== NOT_CONFIGURED
}

// ── 公开 API：模拟"远程 bridge"语义 ────────────────────────────

/**
 * 主进程把 daemon 数据再转一手给渲染进程时用——签名跟
 * `RemoteBridge` 一致（renderer-bridge 内部接口）。
 *
 * 注意 source 字段：descriptor 上的 source 在这里强行打成 `'daemon'`，
 * 即使 Daemon CLI 自己上报为 'main'（CLI 进程内部叫 main）也以本桥为准。
 *
 * **F-1 修复**：fetcher 在每次方法调用时**lazy 解析**，不在
 * createDaemonBridge() 调用瞬间冻结。这样支持以下接入顺序：
 *   1. 主进程启动早期调 createDaemonBridge() 把桥挂上去
 *   2. 后续 W2.3 cli-server-core 就绪时再 setDaemonStorageFetcher(real)
 * 即使 fetcher 显式传入（用于测试隔离），也仍按调用瞬间快照
 * （传入 fetcher 是显式覆盖，调用方知道自己在做什么）。
 */
export function createDaemonBridge(
  fetcher?: DaemonStorageFetcher,
): {
  source: 'daemon'
  listBuckets: DaemonStorageFetcher['listBuckets']
  getBucketSize: DaemonStorageFetcher['getBucketSize']
  listBucketItems: DaemonStorageFetcher['listBucketItems']
  clearBucket: DaemonStorageFetcher['clearBucket']
  exportBucket: DaemonStorageFetcher['exportBucket']
} {
  // 注入式 fetcher 优先（调用方显式覆盖，按瞬间快照）；
  // 未注入时 lazy 读模块级 _fetcher（每次调用现读，避免 F-1 冻结陷阱）。
  const resolve = (): DaemonStorageFetcher => fetcher ?? _fetcher
  return {
    source: 'daemon',
    async listBuckets(filter) {
      const list = await resolve().listBuckets(filter)
      return list.map((d) => ({ ...d, source: 'daemon' as const }))
    },
    getBucketSize: (id) => resolve().getBucketSize(id),
    listBucketItems: (id) => resolve().listBucketItems(id),
    clearBucket: (id, options) => resolve().clearBucket(id, options),
    exportBucket: (id) => resolve().exportBucket(id),
  }
}

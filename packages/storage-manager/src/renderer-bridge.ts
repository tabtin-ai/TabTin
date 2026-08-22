/**
 * Renderer Bridge — 渲染进程侧统一 bucket 访问入口。
 *
 * 设计意图：
 *   - 渲染进程要看到三类 bucket：
 *       1. 主进程注册的（走 IPC `storage-manager:*`）
 *       2. 渲染进程自己注册的（直接读本进程 registry singleton）
 *       3. Daemon 注册的（主进程通过 daemon-bridge 拉，再合并）
 *     本桥的责任是把这三类聚合成一个无缝列表给 UI；
 *   - 同样不直接 import electron——通过 `IpcRendererInvoker` 接口注入。
 */

import {
  type StorageBucket,
  type ClearOptions,
} from './bucket.js'
import {
  clearBucket as localClearBucket,
  exportBucket as localExportBucket,
  getBucket as localGetBucket,
  getBucketSize as localGetBucketSize,
  listBucketItems as localListBucketItems,
  listBuckets as localListBuckets,
  registerStorageBucket as localRegisterStorageBucket,
} from './registry.js'
import {
  type BucketCategory,
  type BucketClearReport,
  type BucketDescriptor,
  type BucketGroup,
  type BucketItemListReport,
  type BucketSizeReport,
  type ExportPayload,
  IPC_CHANNELS,
  bucketToDescriptor,
} from './ui-protocol.js'

// ── 传输层接口（避免直接依赖 electron） ────────────────────────

/** 等价于 `Electron.IpcRenderer.invoke` 的最小子集。 */
export interface IpcRendererInvoker {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

// ── 错误反序列化 ────────────────────────────────────────────────

import type { IpcErrorPayload, IpcResult } from './ipc-bridge.js'

class RemoteStorageManagerError extends Error {
  public readonly remoteName: string
  public readonly bucketId?: string
  public readonly capability?: string
  constructor(payload: IpcErrorPayload) {
    super(payload.message)
    this.name = 'RemoteStorageManagerError'
    this.remoteName = payload.name
    this.bucketId = payload.bucketId
    this.capability = payload.capability
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value
  throw new RemoteStorageManagerError(result.error)
}

// ── 单进程桥（主进程 / Daemon 任一来源） ────────────────────────

interface RemoteBridge {
  source: 'main' | 'daemon'
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

/**
 * 创建走 Electron IPC 的远程桥（指向主进程注册中心）。
 *
 * 用法（在 renderer 启动时）：
 * ```ts
 * const mainBridge = createMainProcessBridge(window.electron.ipcRenderer)
 * ```
 */
export function createMainProcessBridge(
  invoker: IpcRendererInvoker,
): RemoteBridge {
  const stamp = (descriptors: BucketDescriptor[]): BucketDescriptor[] =>
    descriptors.map((d) => ({ ...d, source: 'main' }))

  return {
    source: 'main',
    async listBuckets(filter) {
      const result = (await invoker.invoke(
        IPC_CHANNELS.LIST_BUCKETS,
        filter,
      )) as IpcResult<BucketDescriptor[]>
      return stamp(unwrap(result))
    },
    async getBucketSize(id) {
      const result = (await invoker.invoke(
        IPC_CHANNELS.GET_BUCKET_SIZE,
        id,
      )) as IpcResult<BucketSizeReport>
      return unwrap(result)
    },
    async listBucketItems(id) {
      const result = (await invoker.invoke(
        IPC_CHANNELS.LIST_BUCKET_ITEMS,
        id,
      )) as IpcResult<BucketItemListReport>
      return unwrap(result)
    },
    async clearBucket(id, options) {
      const result = (await invoker.invoke(
        IPC_CHANNELS.CLEAR_BUCKET,
        id,
        options,
      )) as IpcResult<BucketClearReport>
      return unwrap(result)
    },
    async exportBucket(id) {
      const result = (await invoker.invoke(
        IPC_CHANNELS.EXPORT_BUCKET,
        id,
      )) as IpcResult<ExportPayload>
      return unwrap(result)
    },
  }
}

// ── 聚合视图：本地 + 远程合并 ───────────────────────────────────

/**
 * 渲染进程聚合 bucket 视图。
 *
 * 路由策略（按 id 命中规则）：
 *   - 本地 registry 有同 id 的 bucket → 优先走本地（避免不必要的 IPC）
 *   - 否则在 main bridge 的 listBuckets 里找过 → 走 main bridge
 *   - 否则在 daemon bridge 的 listBuckets 里找过 → 走 daemon bridge
 *   - 否则抛 NotFound
 *
 * 注意：本桥假设 bucket id 全局唯一（registry 已强制此约束）。
 */
export class RendererStorageBridge {
  private mainBridge?: RemoteBridge
  private daemonBridge?: RemoteBridge
  /** 缓存远程 bucket 的来源，listAllBuckets 之后建立 */
  private remoteSourceById = new Map<string, 'main' | 'daemon'>()

  constructor(opts: {
    mainBridge?: RemoteBridge
    daemonBridge?: RemoteBridge
  }) {
    this.mainBridge = opts.mainBridge
    this.daemonBridge = opts.daemonBridge
  }

  /**
   * 列出所有 bucket（本地 + 主进程 + Daemon），统一为 BucketDescriptor。
   * 同 id 冲突时优先级：local > main > daemon（理论上不应冲突，注册中心有唯一性约束）。
   */
  async listAllBuckets(filter?: {
    group?: BucketGroup
    category?: BucketCategory
    includeHidden?: boolean
  }): Promise<BucketDescriptor[]> {
    const localBuckets = localListBuckets(filter)
    const localDescriptors = localBuckets.map((b) =>
      bucketToDescriptor(b, 'renderer'),
    )

    const [mainList, daemonList] = await Promise.all([
      this.mainBridge?.listBuckets(filter) ?? Promise.resolve([]),
      this.daemonBridge?.listBuckets(filter) ?? Promise.resolve([]),
    ])

    // 重建路由表：每次 listAll 都刷新一次（远程注册可能变）。
    this.remoteSourceById.clear()
    for (const d of mainList) this.remoteSourceById.set(d.id, 'main')
    for (const d of daemonList) {
      // 只在 main 没占的 id 上记 daemon
      if (!this.remoteSourceById.has(d.id)) {
        this.remoteSourceById.set(d.id, 'daemon')
      }
    }

    // 合并：local 优先，远程已被 local 占用的 id 跳过
    const merged: BucketDescriptor[] = [...localDescriptors]
    const seen = new Set(localDescriptors.map((d) => d.id))
    for (const d of mainList) {
      if (!seen.has(d.id)) {
        merged.push(d)
        seen.add(d.id)
      }
    }
    for (const d of daemonList) {
      if (!seen.has(d.id)) {
        merged.push(d)
        seen.add(d.id)
      }
    }
    return merged
  }

  async getBucketSize(id: string): Promise<BucketSizeReport> {
    if (localGetBucket(id)) {
      const size = await localGetBucketSize(id)
      return {
        id,
        bytes: size.bytes,
        itemCount: size.itemCount,
        measuredAt: Date.now(),
      }
    }
    const bridge = this.resolveBridge(id)
    return bridge.getBucketSize(id)
  }

  async listBucketItems(id: string): Promise<BucketItemListReport> {
    if (localGetBucket(id)) {
      const items = await localListBucketItems(id)
      return { id, items, measuredAt: Date.now() }
    }
    const bridge = this.resolveBridge(id)
    return bridge.listBucketItems(id)
  }

  async clearBucket(
    id: string,
    options?: ClearOptions,
  ): Promise<BucketClearReport> {
    if (localGetBucket(id)) {
      const result = await localClearBucket(id, options)
      return {
        id,
        dryRun: options?.dryRun === true,
        ...result,
      }
    }
    const bridge = this.resolveBridge(id)
    return bridge.clearBucket(id, options)
  }

  async exportBucket(id: string): Promise<ExportPayload> {
    if (localGetBucket(id)) {
      const r = await localExportBucket(id)
      const data = r.data
      if (typeof data === 'string') {
        return {
          id,
          filename: r.filename,
          data,
          encoding: 'utf-8',
          mimeType: r.mimeType,
        }
      }
      // 渲染进程 Blob → base64
      const blobLike = data as { arrayBuffer?: () => Promise<ArrayBuffer> }
      if (typeof blobLike.arrayBuffer === 'function') {
        const ab = await blobLike.arrayBuffer()
        return {
          id,
          filename: r.filename,
          data: arrayBufferToBase64(ab),
          encoding: 'base64',
          mimeType: r.mimeType,
        }
      }
      if (data instanceof Uint8Array) {
        return {
          id,
          filename: r.filename,
          data: arrayBufferToBase64(
            data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer,
          ),
          encoding: 'base64',
          mimeType: r.mimeType,
        }
      }
      throw new Error(
        `[storage-manager] bucket "${id}" 渲染进程 exportFn 返回类型无法序列化`,
      )
    }
    const bridge = this.resolveBridge(id)
    return bridge.exportBucket(id)
  }

  /**
   * 在渲染进程注册一个 bucket（直接转发到 registry singleton）。
   * 业务模块用：
   *   ```ts
   *   import { registerStorageBucket } from '@tabtin/storage-manager'
   *   const off = registerStorageBucket({ id, ... })
   *   ```
   * 实际上不需要走 bridge——provided 这里只是为了 API 完备 + 类型路由便利。
   */
  registerLocal(bucket: StorageBucket): () => void {
    return localRegisterStorageBucket(bucket)
  }

  private resolveBridge(id: string): RemoteBridge {
    const source = this.remoteSourceById.get(id)
    if (source === 'main' && this.mainBridge) return this.mainBridge
    if (source === 'daemon' && this.daemonBridge) return this.daemonBridge
    // 未知 id：默认走 main bridge（如无 main 则 daemon）。
    // 调用方应先 listAllBuckets() 建立路由表——这是 UI 进入面板的必然第一步，
    // 路由表一定先于细粒度调用建立。极少数"先调 size 再 list"的代码路径会
    // 落到这里，由 main/daemon 任一抛 NotFound，UI 端友好提示。
    if (this.mainBridge) return this.mainBridge
    if (this.daemonBridge) return this.daemonBridge
    throw new Error(
      `[storage-manager] bucket "${id}" 在渲染进程聚合视图中找不到——既未本地注册，也未在主进程/Daemon 暴露。请先 listAllBuckets() 拉一次或检查 id。`,
    )
  }
}

// ── helper：浏览器环境 ArrayBuffer → base64 ────────────────────

function arrayBufferToBase64(buf: ArrayBuffer): string {
  // 渲染进程优先用 btoa（浏览器原生），否则 fallback 到 Buffer（Node 测试环境）
  if (typeof btoa === 'function') {
    let binary = ''
    const bytes = new Uint8Array(buf)
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
      binary += String.fromCharCode.apply(null, Array.from(chunk))
    }
    return btoa(binary)
  }
  return Buffer.from(buf).toString('base64')
}

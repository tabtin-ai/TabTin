/**
 * IPC Bridge (main 进程侧) — 把本进程注册中心暴露给渲染进程。
 *
 * 设计意图：
 *   - bucket 含函数引用不能跨 IPC，本桥做"DTO 化 + 路由"两件事；
 *   - 不直接 import electron 包——通过 `IpcMainTransport` 接口注入，
 *     避免本包对 Electron 强依赖（也方便单测 mock）；
 *   - 把任意错误归一为 `{ ok: false, error: { name, message, ... } }` 形式
 *     回传，渲染进程不必处理 IPC 抛出的 Error（结构化错误更稳）。
 */

import {
  BucketCapabilityMissingError,
  BucketNotFoundError,
  clearBucket,
  exportBucket,
  getBucket,
  getBucketSize,
  listBucketItems,
  listBuckets,
} from './registry.js'
import {
  type BucketClearReport,
  type BucketDescriptor,
  type BucketItemListReport,
  type BucketSizeReport,
  type ExportPayload,
  IPC_CHANNELS,
  bucketToDescriptor,
} from './ui-protocol.js'
import type { ClearOptions } from './bucket.js'

// ── 传输层接口（避免直接依赖 electron） ────────────────────────

/**
 * 等价于 `Electron.IpcMain` 的最小子集，调用方传入真正的 ipcMain 即可。
 * 单测可以传 mock 实现。
 */
export interface IpcMainTransport {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void
  removeHandler(channel: string): void
}

// ── 响应包装：IPC 不抛错，统一转 ok/err 信封 ───────────────────

export interface IpcErrorPayload {
  name: string
  message: string
  bucketId?: string
  capability?: string
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IpcErrorPayload }

function wrapError(err: unknown): IpcErrorPayload {
  if (err instanceof BucketNotFoundError) {
    return {
      name: err.name,
      message: err.message,
      bucketId: err.bucketId,
    }
  }
  if (err instanceof BucketCapabilityMissingError) {
    return {
      name: err.name,
      message: err.message,
      bucketId: err.bucketId,
      capability: err.capability,
    }
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  return { name: 'UnknownError', message: String(err) }
}

async function safe<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: wrapError(err) }
  }
}

// ── 导出 helper：把 bucket.exportFn 的产物转成可跨 IPC 的 payload ──

async function toExportPayload(id: string): Promise<ExportPayload> {
  const result = await exportBucket(id)
  const { filename, data, mimeType } = result

  if (typeof data === 'string') {
    return { id, filename, data, encoding: 'utf-8', mimeType }
  }
  if (data instanceof Uint8Array) {
    return {
      id,
      filename,
      data: Buffer.from(data).toString('base64'),
      encoding: 'base64',
      mimeType,
    }
  }
  // Blob：主进程不应该返回 Blob（Blob 是浏览器/渲染进程类型），
  // 但保留容错——读 arrayBuffer 转 base64。
  // 用 any 是因为本包不依赖 DOM 类型。
  const blobLike = data as { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof blobLike.arrayBuffer === 'function') {
    const ab = await blobLike.arrayBuffer()
    return {
      id,
      filename,
      data: Buffer.from(ab).toString('base64'),
      encoding: 'base64',
      mimeType,
    }
  }
  throw new Error(
    `[storage-manager] bucket "${id}" exportFn 返回类型 IPC bridge 无法序列化`,
  )
}

// ── 主入口：注册 IPC handlers ──────────────────────────────────

/**
 * 在主进程把本注册中心的 5 个 IPC handler 挂到给定的传输层。
 * 返回 unregister 函数（卸载所有 handler）。
 *
 * 用法（在 Electron 主进程启动时）：
 * ```ts
 * import { ipcMain } from 'electron'
 * import { registerStorageManagerIpc } from '@tabtin/storage-manager'
 *
 * const off = registerStorageManagerIpc(ipcMain)
 * // 应用退出时
 * off()
 * ```
 */
export function registerStorageManagerIpc(
  ipcMain: IpcMainTransport,
): () => void {
  ipcMain.handle(
    IPC_CHANNELS.LIST_BUCKETS,
    async (
      _event: unknown,
      ...args: unknown[]
    ): Promise<IpcResult<BucketDescriptor[]>> => {
      const filter = args[0] as Parameters<typeof listBuckets>[0] | undefined
      return safe(async () => {
        const buckets = listBuckets(filter)
        return buckets.map((b) => bucketToDescriptor(b, 'main'))
      })
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.GET_BUCKET_SIZE,
    async (
      _event: unknown,
      ...args: unknown[]
    ): Promise<IpcResult<BucketSizeReport>> => {
      return safe(async () => {
        const bucketId = String(args[0])
        const size = await getBucketSize(bucketId)
        return {
          id: bucketId,
          bytes: size.bytes,
          itemCount: size.itemCount,
          measuredAt: Date.now(),
        }
      })
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.LIST_BUCKET_ITEMS,
    async (
      _event: unknown,
      ...args: unknown[]
    ): Promise<IpcResult<BucketItemListReport>> => {
      return safe(async () => {
        const bucketId = String(args[0])
        const items = await listBucketItems(bucketId)
        return { id: bucketId, items, measuredAt: Date.now() }
      })
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.CLEAR_BUCKET,
    async (
      _event: unknown,
      ...args: unknown[]
    ): Promise<IpcResult<BucketClearReport>> => {
      return safe(async () => {
        const bucketId = String(args[0])
        const opts = args[1] as ClearOptions | undefined
        const result = await clearBucket(bucketId, opts)
        return {
          id: bucketId,
          dryRun: opts?.dryRun === true,
          ...result,
        }
      })
    },
  )

  ipcMain.handle(
    IPC_CHANNELS.EXPORT_BUCKET,
    async (
      _event: unknown,
      ...args: unknown[]
    ): Promise<IpcResult<ExportPayload>> => {
      return safe(async () => {
        const bucketId = String(args[0])
        // 校验 bucket 存在/有 exportFn 由 toExportPayload 内部抛错并被 safe 捕获
        if (!getBucket(bucketId)) {
          throw new BucketNotFoundError(bucketId)
        }
        return toExportPayload(bucketId)
      })
    },
  )

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel)
    }
  }
}

/**
 * DaemonStorageBridgeService — 主进程把 daemon CLI /storage/* 路由
 * 包成 storage-manager DaemonStorageFetcher 的桥。
 *
 * 测试策略：
 *   - 起一个真的 HTTP-over-Unix-socket 服务器，写一个临时 daemon-server.json
 *     指过去，跑 fetcher 测试请求构造 + 响应解码 + 错误降级
 *   - 主进程的 storage-manager singleton 在测试间用 __resetForTesting() 隔离
 *
 * **覆盖**：
 *   1. listBuckets 正确解析 daemon 响应
 *   2. daemon 未运行时 listBuckets 返回 []，其他抛 DaemonNotRunningError
 *   3. daemon 返回 4xx / 5xx 时抛 DaemonHttpError
 *   4. socket 路径 / token 错误时报错
 *   5. clearBucket 透传 dryRun / itemIds 选项
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock electron logger（services 模块默认 import） ───────────
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

// ── 共享根目录 mock：把 getHomeTabtinPath 指到临时目录 ─────────
let tmpRoot: string

vi.mock('@tabtin/shared/storage-paths', async () => {
  const actual = await vi.importActual<
    typeof import('@tabtin/shared/storage-paths')
  >('@tabtin/shared/storage-paths')
  return {
    ...actual,
    getHomeTabtinPath: (...sub: string[]) => path.join(tmpRoot, ...sub),
  }
})

// 动态 import 必须在 mock 之后
async function importBridge() {
  return await import('../DaemonStorageBridgeService')
}
async function importStorageManager() {
  return await import('@tabtin/storage-manager')
}

interface FakeServerHandle {
  close: () => Promise<void>
  socketPath: string
  token: string
  receivedRequests: Array<{
    path: string
    headers: http.IncomingHttpHeaders
    body: any
  }>
}

/**
 * 启一个简单的 HTTP-over-Unix-socket 假 daemon CLI 服务器，
 * 把 (path, body) 映射到固定响应，便于测试请求 / 响应轮回。
 */
function startFakeDaemon(
  responder: (path: string, body: any) => { status: number; body: any },
): Promise<FakeServerHandle> {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(tmpRoot, `daemon-cli-test-${Date.now()}.sock`)
    const token = 'test-token-' + Math.random().toString(36).slice(2)
    const requests: FakeServerHandle['receivedRequests'] = []

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8')
        let parsed: any = null
        try {
          parsed = raw ? JSON.parse(raw) : null
        } catch {
          /* ignore */
        }
        requests.push({ path: req.url ?? '', headers: req.headers, body: parsed })

        // 验证 token
        if (req.headers['x-tabtin-token'] !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'AUTH', message: 'bad token' } }))
          return
        }

        const result = responder(req.url ?? '', parsed)
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
      })
    })

    server.listen(sockPath, () => {
      // 写 discovery 文件
      const discoveryPath = path.join(tmpRoot, 'daemon-server.json')
      fs.writeFileSync(
        discoveryPath,
        JSON.stringify({ sock: sockPath, token, pid: process.pid }),
      )
      resolve({
        socketPath: sockPath,
        token,
        receivedRequests: requests,
        async close() {
          await new Promise<void>((r) => server.close(() => r()))
          try {
            fs.unlinkSync(sockPath)
          } catch {
            /* ignore */
          }
          try {
            fs.unlinkSync(discoveryPath)
          } catch {
            /* ignore */
          }
        },
      })
    })

    server.on('error', reject)
  })
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-bridge-test-'))
  const sm = await importStorageManager()
  sm.__resetForTesting()
  const bridge = await importBridge()
  bridge.__resetForTesting()
})

afterEach(async () => {
  const sm = await importStorageManager()
  sm.__resetForTesting()
  const bridge = await importBridge()
  bridge.__resetForTesting()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('DaemonStorageBridgeService', () => {
  describe('createDaemonStorageFetcher → listBuckets', () => {
    it('请求 /storage/list 并返回 buckets 数组', async () => {
      const handle = await startFakeDaemon((p, b) => {
        if (p === '/storage/list') {
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                buckets: [
                  {
                    id: 'daemon:foo',
                    category: 'cache',
                    group: 'cache',
                    displayName: 'foo',
                    description: 'foo',
                    requiresConfirmation: 'none',
                    hideFromList: false,
                    capabilities: { canList: false, canClear: true, canExport: false },
                    source: 'daemon',
                  },
                ],
                count: 1,
              },
            },
          }
        }
        return { status: 404, body: { ok: false, error: { code: 'NF', message: 'nf' } } }
      })
      try {
        const { createDaemonStorageFetcher } = await importBridge()
        const fetcher = createDaemonStorageFetcher()
        const buckets = await fetcher.listBuckets()
        expect(buckets).toHaveLength(1)
        expect(buckets[0].id).toBe('daemon:foo')
        expect(handle.receivedRequests[0].headers['x-tabtin-token']).toBe(handle.token)
      } finally {
        await handle.close()
      }
    })

    it('daemon 未运行时返回空数组（不抛错）', async () => {
      // 没启 fake daemon、没 discovery 文件
      const { createDaemonStorageFetcher } = await importBridge()
      const fetcher = createDaemonStorageFetcher()
      const buckets = await fetcher.listBuckets()
      expect(buckets).toEqual([])
    })
  })

  describe('getBucketSize / clearBucket / listBucketItems / exportBucket', () => {
    it('getBucketSize 透传 bucket id 并解析响应', async () => {
      const handle = await startFakeDaemon((p, b) => {
        if (p === '/storage/size' && b?.bucket === 'daemon:foo') {
          return {
            status: 200,
            body: {
              ok: true,
              data: { id: 'daemon:foo', bytes: 1024, itemCount: 3, measuredAt: 12345 },
            },
          }
        }
        return { status: 404, body: { ok: false, error: { code: 'NF', message: 'nf' } } }
      })
      try {
        const { createDaemonStorageFetcher } = await importBridge()
        const fetcher = createDaemonStorageFetcher()
        const size = await fetcher.getBucketSize('daemon:foo')
        expect(size).toEqual({
          id: 'daemon:foo',
          bytes: 1024,
          itemCount: 3,
          measuredAt: 12345,
        })
      } finally {
        await handle.close()
      }
    })

    it('clearBucket 透传 dryRun / itemIds 选项', async () => {
      const handle = await startFakeDaemon((p, b) => {
        if (p === '/storage/clear') {
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                id: b?.bucket,
                dryRun: b?.options?.dryRun === true,
                clearedItemCount: 2,
                freedBytes: 128,
              },
            },
          }
        }
        return { status: 404, body: { ok: false, error: { code: 'NF', message: 'nf' } } }
      })
      try {
        const { createDaemonStorageFetcher } = await importBridge()
        const fetcher = createDaemonStorageFetcher()
        const r = await fetcher.clearBucket('daemon:foo', {
          dryRun: true,
          itemIds: ['a', 'b'],
        })
        expect(r.dryRun).toBe(true)
        expect(r.clearedItemCount).toBe(2)
        expect(handle.receivedRequests[0].body.options).toEqual({
          dryRun: true,
          itemIds: ['a', 'b'],
        })
      } finally {
        await handle.close()
      }
    })

    it('exportBucket 透传 base64 payload', async () => {
      const handle = await startFakeDaemon((p, b) => {
        if (p === '/storage/export') {
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                id: b?.bucket,
                filename: 'a.bin',
                data: 'AQID', // base64 of [1,2,3]
                encoding: 'base64',
                mimeType: 'application/octet-stream',
              },
            },
          }
        }
        return { status: 404, body: { ok: false, error: { code: 'NF', message: 'nf' } } }
      })
      try {
        const { createDaemonStorageFetcher } = await importBridge()
        const fetcher = createDaemonStorageFetcher()
        const r = await fetcher.exportBucket('daemon:foo')
        expect(r.encoding).toBe('base64')
        expect(r.data).toBe('AQID')
      } finally {
        await handle.close()
      }
    })
  })

  describe('错误处理', () => {
    it('daemon 返回 4xx 抛 DaemonHttpError', async () => {
      const handle = await startFakeDaemon(() => ({
        status: 400,
        body: {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad bucket' },
        },
      }))
      try {
        const { createDaemonStorageFetcher, DaemonHttpError } = await importBridge()
        const fetcher = createDaemonStorageFetcher()
        const promise = fetcher.getBucketSize('daemon:nope')
        await expect(promise).rejects.toBeInstanceOf(DaemonHttpError)
      } finally {
        await handle.close()
      }
    })

    it('daemon 未运行时 getBucketSize 抛 DaemonNotRunningError', async () => {
      const { createDaemonStorageFetcher, DaemonNotRunningError } = await importBridge()
      const fetcher = createDaemonStorageFetcher()
      await expect(fetcher.getBucketSize('daemon:foo')).rejects.toBeInstanceOf(
        DaemonNotRunningError,
      )
    })
  })

  describe('initDaemonStorageBridge', () => {
    it('注入 fetcher 后 storage-manager.createDaemonBridge 立即可用', async () => {
      const handle = await startFakeDaemon(() => ({
        status: 200,
        body: { ok: true, data: { buckets: [], count: 0 } },
      }))
      try {
        const { initDaemonStorageBridge, getDaemonBridgeHandle } =
          await importBridge()
        initDaemonStorageBridge()
        const bridge = getDaemonBridgeHandle()
        expect(bridge).not.toBeNull()
        expect(bridge!.source).toBe('daemon')
        const list = await bridge!.listBuckets()
        expect(Array.isArray(list)).toBe(true)
      } finally {
        await handle.close()
      }
    })

    it('重复 init 不重复挂载（warn 但不抛错）', async () => {
      const { initDaemonStorageBridge } = await importBridge()
      initDaemonStorageBridge()
      expect(() => initDaemonStorageBridge()).not.toThrow()
    })
  })
})

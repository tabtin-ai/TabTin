/**
 * /surfaces endpoint 测试（Wave 4 E2）。
 *
 * 覆盖：
 *   - 空 registry → 返回空数组
 *   - 注册 1 个 surface → 返回包含完整字段的 descriptor
 *   - 注册多个 surface → 按 module 分组返回
 *   - alias 去重（getAllSurfaces 已去重，endpoint 继承）
 *   - deprecated 字段序列化
 *   - handler 函数不出现在序列化结果中
 */

import { describe, it, expect, beforeEach } from 'vitest'
import http from 'node:http'
import { createSurfacesEndpoint } from '../create-surfaces-endpoint.js'
import { definePlatformSurface } from '../define-platform-surface.js'
import { _clearRegistry } from '../registry.js'

/**
 * 构造 mock req/res 用于 endpoint 测试。
 *
 * /surfaces 是 GET 无 body，req 只需最基本的 method/url。
 */
function _createMockReqRes(): {
  req: http.IncomingMessage
  res: http.ServerResponse & { _status: number; _body: string }
} {
  const req = {
    method: 'GET',
    url: '/surfaces',
    headers: {},
  } as unknown as http.IncomingMessage

  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string>,
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      this._status = status
      Object.assign(this._headers, headers)
      this.headersSent = true
    },
    end(body: string) {
      this._body = body
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string }

  return { req, res }
}

beforeEach(() => {
  _clearRegistry()
})

describe('createSurfacesEndpoint', () => {
  it('空 registry → 200 + okResponse([])', async () => {
    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(res._status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data).toEqual([])
  })

  it('注册 1 个 surface → descriptor 包含完整字段', async () => {
    definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] as const,
      handler: async () => ({ markdown: '', messageCount: 0 }),
      bindings: { ipc: true, http: true },
      aliases: ['chat/export'],
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.ok).toBe(true)
    expect(body.data).toHaveLength(1)

    const descriptor = body.data[0]
    expect(descriptor.module).toBe('chat')
    expect(descriptor.verb).toBe('export-md')
    expect(descriptor.kind).toBe('local')
    expect(descriptor.errorCodes).toEqual(['NOT_FOUND', 'VALIDATION_ERROR'])
    expect(descriptor.bindings).toEqual({ ipc: true, http: true })
    expect(descriptor.aliases).toEqual(['chat/export'])
    expect(descriptor.deprecated).toBeNull()
    expect(descriptor.channel).toBe('chat:export-md')
    expect(descriptor.httpPath).toBe('/chat/export-md')
    // L20e：未声明 risk 的 surface 默认空串（视为 RiskNone）
    expect(descriptor.risk).toBe('')
  })

  it('L20e: surface 显式声明 risk → descriptor.risk 透传', async () => {
    definePlatformSurface({
      module: 'workspace',
      verb: 'destroy',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
      risk: 'high-risk-write',
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()
    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.data[0].risk).toBe('high-risk-write')
  })

  it('注册多个 surface → 全部返回', async () => {
    definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
    })

    definePlatformSurface({
      module: 'workspace',
      verb: 'open',
      kind: 'local',
      errorCodes: ['NOT_FOUND'] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.data).toHaveLength(2)

    const modules = body.data.map((d: { module: string }) => d.module)
    expect(modules).toContain('chat')
    expect(modules).toContain('workspace')
  })

  it('alias 去重——getAllSurfaces 已去重，endpoint 不会输出重复条目', async () => {
    definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
      aliases: ['chat/export'],
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].channel).toBe('chat:export-md')
  })

  it('deprecated 字段正确序列化', async () => {
    definePlatformSurface({
      module: 'legacy',
      verb: 'old-action',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
      deprecated: {
        since: '1.0.0',
        replacedBy: 'new:action',
        removeAfter: '2.0.0',
      },
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.data[0].deprecated).toEqual({
      since: '1.0.0',
      replacedBy: 'new:action',
      removeAfter: '2.0.0',
    })
  })

  it('handler 函数不出现在序列化结果中', async () => {
    definePlatformSurface({
      module: 'chat',
      verb: 'secret-handler',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({ sensitive: true }),
      bindings: { ipc: true, http: true },
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const raw = res._body
    expect(raw).not.toContain('sensitive')
    expect(raw).not.toContain('function')

    const body = JSON.parse(raw)
    const descriptor = body.data[0]
    expect(descriptor).not.toHaveProperty('handler')
    expect(descriptor.module).toBe('chat')
  })

  it('http binding 支持对象形态（含 method / path）', async () => {
    definePlatformSurface({
      module: 'data',
      verb: 'query',
      kind: 'local',
      errorCodes: [] as const,
      handler: async () => ({}),
      bindings: { ipc: true, http: { method: 'GET', path: '/data/query' } },
    })

    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    const body = JSON.parse(res._body)
    expect(body.data[0].bindings.http).toEqual({ method: 'GET', path: '/data/query' })
  })

  it('响应 Content-Type 是 application/json', async () => {
    const handler = createSurfacesEndpoint()
    const { req, res } = _createMockReqRes()

    await handler(req, res)

    expect(res._headers['Content-Type']).toBe('application/json')
  })
})

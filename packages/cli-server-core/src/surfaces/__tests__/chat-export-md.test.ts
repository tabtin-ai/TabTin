/**
 * chat/export-md surface handler 单测。
 *
 * 覆盖：
 *   - sessionId 为空 → SurfaceError VALIDATION_ERROR
 *   - Django 返 404 → SurfaceError NOT_FOUND
 *   - Django 返 200 + 消息列表 → 正确拼 markdown + messageCount
 *   - markdown 格式验证（角色映射、时间戳、分隔线）
 *   - 空消息列表 → messageCount: 0 + 对应空提示
 *   - 工具调用类消息的 Markdown 渲染
 *   - alias 验证（registry 层）
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { _clearRegistry, getSurface, getSurfaceByHttpPath } from '../../surface/registry.js'
import {
  configureSurfaceRuntime,
  _clearSurfaceRuntime,
} from '../../surface/configure-surface-runtime.js'
import { definePlatformSurface } from '../../surface/define-platform-surface.js'
import { SurfaceError } from '../../surface/types.js'
import type { ChatExportMdInput, ChatExportMdOutput } from '../chat-export-md.js'

/**
 * 构造一个 mock djangoRequest。
 */
function _createMockDjangoRequest(response: { status: number; data: unknown }) {
  return async (_method: string, _path: string) => response
}

/**
 * 从 chat-export-md 模块获取 handler（不依赖模块级副作用注册）。
 *
 * ESM 模块顶层 definePlatformSurface 只执行一次，清空 registry 后
 * 再 import 不会重新注册。所以 handler 逻辑测试直接取 handler 函数调用，
 * registry 集成测试单独用 definePlatformSurface 重新注册。
 */
let _cachedHandler: ((input: ChatExportMdInput, ctx: { djangoRequest: ReturnType<typeof _createMockDjangoRequest>; spaceId: string | null }) => Promise<ChatExportMdOutput>) | null = null

async function _getHandler() {
  if (!_cachedHandler) {
    const mod = await import('../chat-export-md.js')
    _cachedHandler = mod.chatExportMd.def.handler as typeof _cachedHandler
  }
  return _cachedHandler!
}

// ─── 测试用消息数据 ─────────────────────────────────────────────

const _SAMPLE_MESSAGES = [
  {
    role: 'user',
    content: '你好，请帮我分析一下这个数据',
    created_at: '2026-05-03T10:00:00Z',
  },
  {
    role: 'assistant',
    content: '好的，我来帮你分析这个数据集。',
    created_at: '2026-05-03T10:00:05Z',
  },
  {
    role: 'system',
    content: '你是一个数据分析助手。',
  },
]

const _TOOL_CALL_MESSAGES = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        function: {
          name: 'read_file',
          arguments: '{"path": "/data/report.csv"}',
        },
      },
    ],
  },
  {
    role: 'tool',
    content: 'id,name,value\n1,Alice,100\n2,Bob,200',
    tool_call_id: 'call_abc123',
    name: 'read_file',
  },
]

// ─── 测试 ────────────────────────────────────────────────────────

describe('chat/export-md surface', () => {
  beforeEach(() => {
    _clearRegistry()
    _clearSurfaceRuntime()
  })

  describe('输入校验', () => {
    it('sessionId 为空时抛 SurfaceError VALIDATION_ERROR', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: [] }), spaceId: null }

      await expect(handler({} as ChatExportMdInput, ctx)).rejects.toThrow(SurfaceError)

      try {
        await handler({} as ChatExportMdInput, ctx)
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
        expect((err as SurfaceError).message).toContain('sessionId')
      }
    })

    it('sessionId 为 undefined 时抛 VALIDATION_ERROR', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: [] }), spaceId: null }

      try {
        await handler({ sessionId: undefined } as unknown as ChatExportMdInput, ctx)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('sessionId 为空字符串时抛 VALIDATION_ERROR', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: [] }), spaceId: null }

      try {
        await handler({ sessionId: '' }, ctx)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })
  })

  describe('Django API 交互', () => {
    it('Django 返 404 时抛 SurfaceError NOT_FOUND', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 404, data: null }), spaceId: null }

      try {
        await handler({ sessionId: 'non-existent' }, ctx)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('NOT_FOUND')
        expect((err as SurfaceError).message).toContain('non-existent')
      }
    })

    it('Django 返 200 + 消息列表时正确返回 markdown 和 messageCount', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: _SAMPLE_MESSAGES }), spaceId: null }

      const result = await handler({ sessionId: 'sess-001' }, ctx)

      expect(result.messageCount).toBe(3)
      expect(result.markdown).toContain('# 对话导出')
      expect(result.markdown).toContain('sess-001')
      expect(result.markdown).toContain('共 3 条消息')
    })

    it('Django 返 200 + data.data 嵌套结构时正确解析', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: { data: _SAMPLE_MESSAGES } }), spaceId: null }

      const result = await handler({ sessionId: 'sess-nested' }, ctx)

      expect(result.messageCount).toBe(3)
    })

    it('Django 返 500 时抛 Error（adapter 兜底为 INTERNAL_ERROR）', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 500, data: { detail: 'server error' } }), spaceId: null }

      await expect(handler({ sessionId: 'sess-500' }, ctx)).rejects.toThrow('Django 返回 HTTP 500')
    })

    it('Django 返 403 时抛 Error 而不是默默处理', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 403, data: null }), spaceId: null }

      await expect(handler({ sessionId: 'sess-403' }, ctx)).rejects.toThrow('Django 返回 HTTP 403')
    })

    it('djangoRequest 路径以 /api/ 开头（跟 cli-routes 用法一致）', async () => {
      let capturedPath = ''
      const mockDjangoReq = async (_method: string, path: string) => {
        capturedPath = path
        return { status: 200, data: [] }
      }
      const handler = await _getHandler()
      await handler({ sessionId: 'test-path' }, { djangoRequest: mockDjangoReq, spaceId: null })

      expect(capturedPath).toBe('/api/chat/sessions/test-path/messages')
    })
  })

  describe('Markdown 格式', () => {
    it('角色映射正确（user→用户, assistant→AI 助手, system→系统）', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: _SAMPLE_MESSAGES }), spaceId: null }

      const result = await handler({ sessionId: 'sess-role' }, ctx)

      expect(result.markdown).toContain('## 用户')
      expect(result.markdown).toContain('## AI 助手')
      expect(result.markdown).toContain('## 系统')
    })

    it('时间戳以引用格式显示', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: _SAMPLE_MESSAGES }), spaceId: null }

      const result = await handler({ sessionId: 'sess-ts' }, ctx)

      expect(result.markdown).toContain('> 2026-05-03T10:00:00Z')
    })

    it('消息之间有分隔线', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: _SAMPLE_MESSAGES }), spaceId: null }

      const result = await handler({ sessionId: 'sess-sep' }, ctx)

      expect(result.markdown).toContain('---')
    })

    it('空消息列表时 messageCount 为 0 且有空提示', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: [] }), spaceId: null }

      const result = await handler({ sessionId: 'sess-empty' }, ctx)

      expect(result.messageCount).toBe(0)
      expect(result.markdown).toContain('暂无消息')
    })

    it('工具调用类消息正确展示工具名和参数', async () => {
      const handler = await _getHandler()
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: _TOOL_CALL_MESSAGES }), spaceId: null }

      const result = await handler({ sessionId: 'sess-tool' }, ctx)

      expect(result.markdown).toContain('read_file')
      expect(result.markdown).toContain('call_abc123')
      expect(result.markdown).toContain('/data/report.csv')
    })

    it('无 content 的消息标注"无文本内容"', async () => {
      const handler = await _getHandler()
      const noContentMsg = [{ role: 'user', content: null }]
      const ctx = { djangoRequest: _createMockDjangoRequest({ status: 200, data: noContentMsg }), spaceId: null }

      const result = await handler({ sessionId: 'sess-nocontent' }, ctx)

      expect(result.markdown).toContain('无文本内容')
    })
  })

  describe('registry 集成', () => {
    /**
     * registry 测试需要重新注册 surface（ESM 模块缓存不会重复执行顶层代码）。
     * 用 definePlatformSurface 手动注册一个相同配置的 surface。
     */
    function _registerTestSurface() {
      return definePlatformSurface({
        module: 'chat',
        verb: 'export-md',
        kind: 'local',
        errorCodes: ['NOT_FOUND', 'VALIDATION_ERROR'] as const,
        bindings: { ipc: true, http: true },
        aliases: ['chat/export'],
        handler: async () => ({ markdown: '', messageCount: 0 }),
      })
    }

    it('注册到 registry 后可通过 channel 查到', () => {
      _registerTestSurface()

      const found = getSurface('chat:export-md')
      expect(found).toBeDefined()
      expect(found!.channel).toBe('chat:export-md')
      expect(found!.httpPath).toBe('/chat/export-md')
    })

    it('alias chat/export 和 chat:export-md 指向同一 handler', () => {
      _registerTestSurface()

      const primary = getSurface('chat:export-md')
      const alias = getSurface('chat/export')

      expect(primary).toBeDefined()
      expect(alias).toBeDefined()
      expect(primary!.def.handler).toBe(alias!.def.handler)
    })

    it('通过 httpPath 查找 /chat/export-md 能命中', () => {
      _registerTestSurface()

      const found = getSurfaceByHttpPath('/chat/export-md')
      expect(found).toBeDefined()
      expect(found!.channel).toBe('chat:export-md')
    })

    it('通过 httpPath 查找 alias /chat/export 也能命中', () => {
      _registerTestSurface()

      const found = getSurfaceByHttpPath('/chat/export')
      expect(found).toBeDefined()
      expect(found!.def.handler).toBeDefined()
    })

    it('surface 定义的 errorCodes 是闭集', () => {
      const surface = _registerTestSurface()
      expect(surface.def.errorCodes).toEqual(['NOT_FOUND', 'VALIDATION_ERROR'])
    })

    it('surface 的 bindings 声明 ipc + http 都启用', () => {
      const surface = _registerTestSurface()
      expect(surface.def.bindings.ipc).toBe(true)
      expect(surface.def.bindings.http).toBe(true)
    })
  })
})

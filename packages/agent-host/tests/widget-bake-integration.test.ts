/**
 * show-widget Wave 4 烤图链路集成测试 — widget RFC §五 4.7 关键不变量
 *
 *  批4：烤图 + OSS 上传实现从 agent-runtime 迁到 agent-host
 * （`src/capabilities/widget-bake.ts`），通过 `createShowWidgetTool` 的
 * `bakeAndUpload` deps 注入。本测试把 host 实现注入 runtime 工具，端到端守住
 * 与迁移前 agent-runtime show-widget-wave4.test.ts 相同的约束：
 *
 *   1. OffscreenRenderAPI 注入时：烤图 → uploadFileToOSS → emit RICH_CONTENT 含 image_url。
 *   2. OffscreenRenderAPI 未注入：image_url 为空字符串，仍 emit RICH_CONTENT。
 *   3. renderToImage 失败：image_url 空 + result._mobile_fallback_unavailable 含原因。
 *   4. uploadFileToOSS 返回 null/error：image_url 空 + _mobile_fallback_unavailable 含原因。
 *   5. 多 turn：上 turn 的 _mobile_fallback_unavailable 不污染下 turn。
 *   6. 进度日志关键字：widget-bake.ts 源码含 baking / uploading 字面。
 *   7. theme：UIThemeAPI 注入 dark → renderToImage 收到 theme:dark。
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createShowWidgetTool } from '@tabtin/agent-runtime/tools'
import { bakeAndUploadWidget } from '../src/capabilities/widget-bake'
import {
  setOffscreenRenderAPI,
  setUIThemeAPI,
} from '@tabtin/action-tools/headless'
import type { OffscreenRenderResult } from '@tabtin/action-tools/headless'
import type { StreamEvent, ToolContext } from '@tabtin/agent-runtime'

function setupTabtinGlobal(): void {
  ;(globalThis as unknown as { tabtin?: unknown }).tabtin = {
    apiBaseUrl: 'http://localhost:6060/api',
    auth: { getAccessToken: () => 'test-token-' + Date.now() },
    organizationId: 'wt_test',
    tabvideo: {
      uploadToOSS: vi.fn(async (_path: string) => 'https://oss.example.com/widget/test.png'),
    },
  }
}

function teardownTabtinGlobal(): void {
  delete (globalThis as unknown as { tabtin?: unknown }).tabtin
}

function makeContext(emit?: (e: StreamEvent) => void): ToolContext {
  return {
    threadId: 'tt-wave4',
    runtimeId: 'sess_wave4',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    iteration: 1,
    emitStreamEvent: emit,
    emitRichContentBlock: emit
      ? (args) => {
          const flatBlock: Record<string, unknown> = {
            type: 'tabtin_rich_content',
            kind: args.kind,
            summary: args.summary,
            ...(args.groupId ? { group_id: args.groupId } : {}),
            ...(args.payload ?? {}),
          }
          emit({
            type: 'agent.stream.content_block_start',
            payload: { blocks: [flatBlock] },
          } as unknown as StreamEvent)
        }
      : undefined,
  } as unknown as ToolContext
}

// host 装配同款注入：把 agent-host 的烤图实现接到 runtime 工具。
function makeWidgetTool() {
  return createShowWidgetTool({ bakeAndUpload: bakeAndUploadWidget })
}

const goodSvg = '<svg viewBox="0 0 100 100"><rect/></svg>'

beforeEach(() => {
  setOffscreenRenderAPI(null)
  setUIThemeAPI(null)
})

describe('widget-bake 注入 → 烤图 → uploadFileToOSS', () => {
  beforeEach(() => {
    setupTabtinGlobal()
  })

  it('OffscreenRenderAPI 成功 + uploadToOSS 成功 → emit RICH_CONTENT 带 image_url', async () => {
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async (_input) => ({
        success: true,
        buffer: Buffer.from('fake-png-bytes'),
        width: 1360,
        height: 800,
      } as OffscreenRenderResult)),
    })

    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'k8s 架构', format: 'svg', code: goodSvg, title: 'K8s' },
      makeContext(emit),
    )

    expect(result.isError).toBeFalsy()
    expect(emit).toHaveBeenCalledTimes(1)
    const event = emit.mock.calls[0][0]
    const block = (event.payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.kind).toBe('widget')
    expect(block.image_url).toBe('https://oss.example.com/widget/test.png')
    const parsed = JSON.parse(result.content as string)
    expect(parsed._mobile_fallback_unavailable).toBeUndefined()
    expect(parsed._mobile_fallback_note).toBeUndefined()
  })

  it('renderToImage 返回 success=false → image_url="" + 仍 emit + result 含 baking_error', async () => {
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async (_input) => ({
        success: false,
        error: 'BrowserWindow OOM',
      } as OffscreenRenderResult)),
    })

    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'fail case', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(result.isError).toBeFalsy()
    expect(emit).toHaveBeenCalledTimes(1)
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.kind).toBe('widget')
    expect(block.image_url).toBe('')
    const parsed = JSON.parse(result.content as string)
    expect(parsed._mobile_fallback_unavailable).toMatch(/OOM/)
    expect(parsed._mobile_fallback_note).toMatch(/DO NOT.*retry/i)
    expect(parsed._mobile_fallback_note).toMatch(/DO NOT.*apologize/i)
  })

  it('renderToImage 抛异常 → 不让 execute 抛 + image_url="" + _mobile_fallback_unavailable', async () => {
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => {
        throw new Error('unexpected race')
      }),
    })

    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'race', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(result.isError).toBeFalsy()
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.image_url).toBe('')
    const parsed = JSON.parse(result.content as string)
    expect(parsed._mobile_fallback_unavailable).toMatch(/unexpected race/)
  })

  it('uploadFileToOSS 返回 null → image_url="" + _mobile_fallback_unavailable 含原因', async () => {
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png'),
      } as OffscreenRenderResult)),
    })
    ;(globalThis as unknown as { tabtin: { tabvideo: { uploadToOSS: () => Promise<null> } } })
      .tabtin.tabvideo.uploadToOSS = async () => null

    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'upload fail', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.image_url).toBe('')
    const parsed = JSON.parse(result.content as string)
    expect(parsed._mobile_fallback_unavailable).toMatch(/Injected uploadToOSS returned null|unknown/)
  })

  it('多 turn 测试：上 turn 烤图失败不影响下 turn 烤图成功', async () => {
    const tool = makeWidgetTool()

    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: false,
        error: 'turn 1 fail',
      } as OffscreenRenderResult)),
    })
    const emit1 = vi.fn<(e: StreamEvent) => void>()
    const r1 = await tool.execute(
      { summary: 't1', format: 'svg', code: goodSvg },
      makeContext(emit1),
    )
    const b1 = (emit1.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(b1.image_url).toBe('')
    expect(JSON.parse(r1.content as string)._mobile_fallback_unavailable).toMatch(/turn 1 fail/)

    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png-t2'),
      } as OffscreenRenderResult)),
    })
    const emit2 = vi.fn<(e: StreamEvent) => void>()
    const r2 = await tool.execute(
      { summary: 't2', format: 'svg', code: '<svg><circle/></svg>' },
      makeContext(emit2),
    )
    const b2 = (emit2.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(b2.image_url).toBe('https://oss.example.com/widget/test.png')
    expect(JSON.parse(r2.content as string)._mobile_fallback_unavailable).toBeUndefined()

    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: false,
        error: 'turn 3 fail',
      } as OffscreenRenderResult)),
    })
    const emit3 = vi.fn<(e: StreamEvent) => void>()
    const r3 = await tool.execute(
      { summary: 't3', format: 'svg', code: '<svg><line/></svg>' },
      makeContext(emit3),
    )
    expect(JSON.parse(r3.content as string)._mobile_fallback_unavailable).toMatch(/turn 3 fail/)
  })
})

describe('widget-bake: OffscreenRenderAPI 未注册兜底', () => {
  beforeEach(() => {
    setupTabtinGlobal()
    setOffscreenRenderAPI(null)
  })

  it('OffscreenRenderAPI 未注入时仍 emit RICH_CONTENT 但 image_url 空（启动竞态兜底）', async () => {
    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'no api', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(result.isError).toBeFalsy()
    expect(emit).toHaveBeenCalledTimes(1)
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.kind).toBe('widget')
    expect(block.code).toBe(goodSvg)
    expect(block.image_url).toBe('')
    expect(JSON.parse(result.content as string)._mobile_fallback_unavailable).toMatch(/not registered/)
  })
})

describe('widget-bake: dogfood baking_error 复盘 — uploadFileToOSS contextId 防回归', () => {
  it('bake 必须传 contextId=widgetId，否则 oss-upload 早期校验会精确报 context-id-required', async () => {
    setupTabtinGlobal()
    delete (globalThis as unknown as { tabtin: { tabvideo?: unknown } }).tabtin.tabvideo

    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png'),
      } as OffscreenRenderResult)),
    })

    const emit = vi.fn<(e: StreamEvent) => void>()
    const result = await makeWidgetTool().execute(
      { summary: 'context-id check', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(result.isError).toBeFalsy()
    const block = (emit.mock.calls[0][0].payload as { blocks: Array<Record<string, unknown>> }).blocks[0]
    expect(block.kind).toBe('widget')
    expect(block.image_url).toBe('')

    const parsed = JSON.parse(result.content as string)
    expect(parsed._mobile_fallback_unavailable).toBeDefined()
    expect(parsed._mobile_fallback_unavailable).not.toBe('OSS upload returned null URL')
    expect(parsed._mobile_fallback_unavailable.length).toBeGreaterThan(10)
    expect(parsed._mobile_fallback_note).toMatch(/DO NOT.*retry/i)
    expect(parsed._mobile_fallback_note).toMatch(/DO NOT.*apologize/i)
    expect(parsed._mobile_fallback_note).toMatch(/non-critical/i)

    teardownTabtinGlobal()
  })
})

describe('widget-bake Wave 7 补丁: theme 传递（runtime bridge UIThemeAPI）', () => {
  beforeEach(() => {
    setupTabtinGlobal()
  })

  it('UIThemeAPI 注入 dark → bake 时 theme:dark 传到 renderToImage', async () => {
    const renderMock = vi.fn(async (_input) => ({
      success: true,
      buffer: Buffer.from('png-dark'),
    } as OffscreenRenderResult))
    setOffscreenRenderAPI({ renderToImage: renderMock })
    setUIThemeAPI({ getCurrentTheme: () => 'dark' })

    const emit = vi.fn<(e: StreamEvent) => void>()
    await makeWidgetTool().execute(
      { summary: 'dark test', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(renderMock.mock.calls[0][0]).toMatchObject({
      code: goodSvg,
      format: 'svg',
      theme: 'dark',
    })
  })

  it('UIThemeAPI 未注入（Daemon / headless）→ theme:light 保持 Wave 4 默认不回归', async () => {
    const renderMock = vi.fn(async (_input) => ({
      success: true,
      buffer: Buffer.from('png-light'),
    } as OffscreenRenderResult))
    setOffscreenRenderAPI({ renderToImage: renderMock })

    const emit = vi.fn<(e: StreamEvent) => void>()
    await makeWidgetTool().execute(
      { summary: 'light test (daemon default)', format: 'svg', code: goodSvg },
      makeContext(emit),
    )

    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(renderMock.mock.calls[0][0]).toMatchObject({
      code: goodSvg,
      format: 'svg',
      theme: 'light',
    })
  })
})

describe('widget-bake: 进度日志 / dev mode 可观测', () => {
  it('源码包含 baking / uploading 关键字（widget RFC §五 验收 8 grep 命中）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const url = await import('node:url')
    const dir = path.dirname(url.fileURLToPath(import.meta.url))
    const source = fs.readFileSync(
      path.join(dir, '..', 'src', 'capabilities', 'widget-bake.ts'),
      'utf-8',
    )
    expect(source).toMatch(/baking/i)
    expect(source).toMatch(/uploading/i)
  })
})

afterAll(() => {
  setOffscreenRenderAPI(null)
  setUIThemeAPI(null)
  teardownTabtinGlobal()
})

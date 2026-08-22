/**
 * widget-bake · W1.3 修复（A3-H3）：bake-upload 失败保留 + 错误回执含本地路径。
 *
 *  批4：烤图 + OSS 上传实现从 agent-runtime 迁至 agent-host
 * （`src/capabilities/widget-bake.ts`）。本测试直接对 `bakeAndUploadWidget`
 * 单测，聚焦 cleanup / bakedImagePath 行为——与迁移前 agent-runtime 的
 * show-widget-w13-cleanup.test.ts 断言完全一致。
 *
 * W1.3 修复契约：
 *   - "成功才清，失败保留"（与 export-tool / mg-tool 一致）
 *   - 失败时通过 `bakedImagePath` 字段透出本地 PNG 路径
 *   - show-widget/index.ts 把 `bakedImagePath` 透传到 LLM result 的 `output_path`
 *   - 失败 bakingError 文案用 `output_path` 字段引用而不是硬塞绝对路径
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { bakeAndUploadWidget } from '../src/capabilities/widget-bake'
import {
  setOffscreenRenderAPI,
  setUIThemeAPI,
} from '@tabtin/action-tools/headless'
import type { OffscreenRenderResult } from '@tabtin/action-tools/headless'

function setupTabtinGlobal(uploadResult: string | null | (() => Promise<string | null>) | (() => never)): void {
  ;(globalThis as unknown as { tabtin?: unknown }).tabtin = {
    apiBaseUrl: 'http://localhost:6060/api',
    auth: { getAccessToken: () => 'tok' },
    organizationId: 'wt',
    tabvideo: {
      uploadToOSS: vi.fn(async (_path: string) => {
        if (typeof uploadResult === 'function') return (uploadResult as () => Promise<string | null>)()
        return uploadResult
      }),
    },
  }
}

function teardownTabtinGlobal(): void {
  delete (globalThis as unknown as { tabtin?: unknown }).tabtin
}

const preparedSvg = {
  renderCode: '<svg viewBox="0 0 10 10"><rect/></svg>',
  renderFormat: 'svg' as const,
}

function bake(widgetId: string): Promise<Awaited<ReturnType<typeof bakeAndUploadWidget>>> {
  return bakeAndUploadWidget({
    widgetId,
    renderCode: preparedSvg.renderCode,
    renderFormat: preparedSvg.renderFormat,
  })
}

beforeEach(() => {
  setOffscreenRenderAPI(null)
  setUIThemeAPI(null)
  teardownTabtinGlobal()
  // 清掉测试可能残留的 widget-upload tmpDir
  try {
    const entries = fs.readdirSync(os.tmpdir())
    for (const e of entries) {
      if (e.startsWith('widget-upload-')) {
        try { fs.rmSync(path.join(os.tmpdir(), e), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
})

describe('bakeAndUploadWidget · W1.3 / A3-H3 默认"成功才清，失败保留"', () => {
  it('成功路径：上传成功 → tmpDir 被清空，bakedImagePath 为 undefined', async () => {
    setupTabtinGlobal('https://oss.example.com/widget/ok.png')
    const tmpPathsObserved: string[] = []
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async (_input) => {
        return {
          success: true,
          buffer: Buffer.from('fake-png'),
          width: 680,
          height: 400,
        } as OffscreenRenderResult
      }),
    })
    ;(
      globalThis as unknown as {
        tabtin: { tabvideo: { uploadToOSS: ReturnType<typeof vi.fn> } }
      }
    ).tabtin.tabvideo.uploadToOSS = vi.fn(async (p: string) => {
      tmpPathsObserved.push(p)
      return 'https://oss.example.com/widget/ok.png'
    })

    const result = await bake('w-success')

    expect(result.imageUrl).toBe('https://oss.example.com/widget/ok.png')
    expect(result.bakingError).toBeUndefined()
    expect(result.bakedImagePath).toBeUndefined()
    expect(tmpPathsObserved).toHaveLength(1)
    expect(fs.existsSync(tmpPathsObserved[0])).toBe(false)
    expect(fs.existsSync(path.dirname(tmpPathsObserved[0]))).toBe(false)
  })

  it('失败路径（OSS 返回 null）：保留 tmpDir + bakedImagePath 是真实存在的本地 PNG 路径', async () => {
    setupTabtinGlobal(null)
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png-bytes'),
      } as OffscreenRenderResult)),
    })

    const result = await bake('w-fail-null')

    expect(result.imageUrl).toBe('')
    expect(result.bakingError).toMatch(/OSS upload returned null/)
    expect(typeof result.bakedImagePath).toBe('string')
    expect(fs.existsSync(result.bakedImagePath as string)).toBe(true)
    expect(result.bakedImagePath).toMatch(/widget-upload-/)
    expect(path.basename(result.bakedImagePath as string)).toBe('w-fail-null.png')

    fs.rmSync(path.dirname(result.bakedImagePath as string), { recursive: true, force: true })
  })

  it('失败路径（uploadToOSS throw）：上层 oss-upload swallow 后等价 null URL → 仍保留 tmpDir + bakedImagePath', async () => {
    setupTabtinGlobal(null)
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png-bytes'),
      } as OffscreenRenderResult)),
    })
    ;(
      globalThis as unknown as {
        tabtin: { tabvideo: { uploadToOSS: ReturnType<typeof vi.fn> } }
      }
    ).tabtin.tabvideo.uploadToOSS = vi.fn(async () => {
      throw new Error('Network: ECONNRESET')
    })

    const result = await bake('w-fail-throw')

    expect(result.imageUrl).toBe('')
    expect(result.bakingError).toMatch(/OSS upload returned null|ECONNRESET/)
    expect(typeof result.bakedImagePath).toBe('string')
    expect(fs.existsSync(result.bakedImagePath as string)).toBe(true)

    fs.rmSync(path.dirname(result.bakedImagePath as string), { recursive: true, force: true })
  })

  it('renderToImage success=false → bakedImagePath 为 undefined（根本没写盘）', async () => {
    setupTabtinGlobal('https://oss.example.com/should-not-reach')
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: false,
        error: 'BrowserWindow OOM',
      } as OffscreenRenderResult)),
    })

    const result = await bake('w-render-fail')

    expect(result.imageUrl).toBe('')
    expect(result.bakingError).toMatch(/OOM/)
    expect(result.bakedImagePath).toBeUndefined()
  })

  it('OffscreenRenderAPI 未注册（headless）→ bakedImagePath 为 undefined', async () => {
    setupTabtinGlobal('https://oss.example.com/should-not-reach')
    setOffscreenRenderAPI(null)

    const result = await bake('w-no-offscreen')

    expect(result.imageUrl).toBe('')
    expect(result.bakingError).toMatch(/OffscreenRenderAPI not registered/)
    expect(result.bakedImagePath).toBeUndefined()
  })

  it('R3 M4：失败 bakingError 文案不再硬塞 tmpPath（用 output_path 字段引用）', async () => {
    setupTabtinGlobal(null)
    setOffscreenRenderAPI({
      renderToImage: vi.fn(async () => ({
        success: true,
        buffer: Buffer.from('png-bytes'),
      } as OffscreenRenderResult)),
    })

    const result = await bake('w-msg-shape')

    expect(result.imageUrl).toBe('')
    expect(result.bakingError).toMatch(/output_path/)
    expect(result.bakingError).not.toMatch(/\/tmp\//)
    expect(typeof result.bakedImagePath).toBe('string')

    fs.rmSync(path.dirname(result.bakedImagePath as string), { recursive: true, force: true })
  })
})

/**
 * R1 review must-fix：守住"show-widget execute 失败回执用统一字段名 output_path"。
 *
 * show-widget/index.ts（仍在 agent-runtime）把上传失败保留的本地 PNG 路径写到
 * LLM result 的 `output_path`（与 export-tool / mg-tool 一致），不回退到旧命名
 * `baked_image_path`。
 */
describe('show-widget execute · W1.3 失败回执字段命名一致性（R1 review）', () => {
  it('源码层面：index.ts 在 LLM result 上写的是 `output_path`，不是 `baked_image_path`', async () => {
    const fsReader = await import('node:fs')
    const pathHelper = await import('node:path')
    const urlHelper = await import('node:url')
    const dir = pathHelper.dirname(urlHelper.fileURLToPath(import.meta.url))
    const indexPath = pathHelper.resolve(
      dir,
      '..',
      '..',
      'agent-runtime',
      'src',
      'tools',
      'show-widget',
      'index.ts',
    )
    const content = fsReader.readFileSync(indexPath, 'utf-8')

    expect(content).toMatch(/result\.output_path\s*=\s*bakedImagePath/)
    expect(content).not.toMatch(/result\.baked_image_path/)
    expect(content).not.toMatch(/['"`]baked_image_path['"`]/)
  })
})

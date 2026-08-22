/**
 * uploadFileToOSS 单测 — 把 dogfood baking_error 复盘的根因链固化成测试。
 *
 * 历史 bug 复盘（2026-05-02）：
 *
 * widget 烤图调 uploadFileToOSS 时没传 contextId，Django `confirm-upload`
 * 强制校验 `context_id` 非空，拒绝写库返回 VALIDATION_ERROR。oss-client 的
 * confirm 函数 throw `Error('context_id is required and cannot be empty')`，
 * 旧版 oss-upload.ts 用 try/catch 抓住后**直接吞错误信息返 null**，调用方拿
 * 到 null 编了一个 "OSS upload returned null URL" 这种**毫无信息量的兜底文
 * 案**塞给 LLM。LLM 把 "OSS upload returned null URL" 误判为 "widget 渲染整体
 * 失败"，给用户道歉 + 给文本 fallback。
 *
 * 修复后 uploadFileToOSS 返回 UploadOutcome 结构：
 *   - `url`        : 成功时的 access URL；失败时 null
 *   - `error`      : 失败时的精确人话错误（适合塞给 LLM 看）
 *   - `errorCode`  : 失败原因分类（用于 retry / fallback 路由判断）
 *
 * 本测试守住的核心契约：
 *   1. 提前 contextId 校验 → errorCode='context-id-required'（避免错误绕道吞）
 *   2. 缺 apiBase → errorCode='no-api-base'
 *   5. 缺 auth bridge → errorCode='no-auth'
 *   6. error message 永远存在且非空（可以原样塞给 LLM）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// 成功路径会动态 import('@tabtin/oss-client') 并调 client.upload()。
// 用 vi.hoisted + vi.mock 拦截，断言 uploadFileToOSS 把 oss-client 返回的
// fileId/fileKey/cdnUrl 透传出来（供 doc import file 等回引文件的下游消费）。
const { mockUpload } = vi.hoisted(() => ({ mockUpload: vi.fn() }))
vi.mock('@tabtin/oss-client', () => ({
  createOSSClient: () => ({ upload: mockUpload }),
}))

// 直接造 tmp 文件，覆盖真实异步文件读取与 oss-client 上传边界。
let tmpFile: string

function setTabtin(value: unknown): void {
  ;(globalThis as unknown as { tabtin?: unknown }).tabtin = value
}

function delTabtin(): void {
  delete (globalThis as unknown as { tabtin?: unknown }).tabtin
}

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `oss-upload-test-${Date.now()}.png`)
  fs.writeFileSync(tmpFile, Buffer.from('fake-png-bytes'))
})

afterEach(() => {
  try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  delTabtin()
  mockUpload.mockReset()
  vi.restoreAllMocks()
})

describe('uploadFileToOSS — dogfood baking_error 复盘契约', () => {
  it('contextId 缺失 → 提前校验，errorCode=context-id-required（不走 createOSSClient）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      folder: 'widget/renders',
      module: 'widget',
      contextType: 'widget_render',
      // contextId 故意不传 —— 模拟 dogfood bug 现场
      mimeType: 'image/png',
    })

    expect(result.url).toBeNull()
    expect(result.errorCode).toBe('context-id-required')
    // error message 必须有信息量，能让 LLM 看懂为什么失败
    expect(result.error).toMatch(/contextId is required/)
    expect(result.error).toMatch(/Django.*confirm-upload/)
  })

  it('contextId 为空字符串 → 视作未传，同样 errorCode=context-id-required', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: '   ',  // 全空白
    })

    expect(result.url).toBeNull()
    expect(result.errorCode).toBe('context-id-required')
  })

  it('oss-client 直传成功 → 透传 fileId/fileKey/cdnUrl（doc import file 回引依赖）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    mockUpload.mockResolvedValueOnce({
      fileId: 'frec_abc123',
      fileName: 'report.pdf',
      fileKey: 'agent/uploads/abc.pdf',
      fileSize: 1234,
      accessUrl: 'https://oss.example.com/agent/uploads/abc.pdf',
      cdnUrl: 'https://cdn.example.com/agent/uploads/abc.pdf',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      folder: 'agent/uploads',
      module: 'agent',
      contextType: 'present',
      contextId: 'cli-upload-123',
      mimeType: 'application/pdf',
    })

    expect(result.url).toBe('https://oss.example.com/agent/uploads/abc.pdf')
    // 关键契约：file_id 必须透传，否则 `doc import file --file-record-id` 拿不到引用
    expect(result.fileId).toBe('frec_abc123')
    expect(result.fileKey).toBe('agent/uploads/abc.pdf')
    expect(result.cdnUrl).toBe('https://cdn.example.com/agent/uploads/abc.pdf')
    expect(result.error).toBeUndefined()
    expect(result.errorCode).toBeUndefined()
    // 校验 contextId 确实传到了 oss-client（Django confirm-upload 强制非空）
    expect(mockUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ contextId: 'cli-upload-123', module: 'agent' }),
    )
  })

  it('把 AbortSignal 贯穿到 oss-client 上传', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    mockUpload.mockResolvedValueOnce({
      fileId: 'frec_abortable',
      accessUrl: 'https://oss.example.com/file.png',
    })
    const controller = new AbortController()
    const { uploadFileToOSS } = await import('../oss-upload')

    await uploadFileToOSS(tmpFile, {
      contextId: 'abortable-upload',
      signal: controller.signal,
    })

    expect(mockUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ signal: controller.signal }),
    )
  })

  it('isPublic=false 时走 oss-client 并透传 isPublic/fileId（#7767）', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    mockUpload.mockResolvedValueOnce({
      fileId: 'frec_html_private',
      fileName: 'demo.html',
      fileKey: 'tabdoc/html/demo.html',
      fileSize: 32,
      accessUrl: 'https://oss.example.com/tabdoc/html/demo.html',
      cdnUrl: '',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      folder: 'tabdoc/html',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
      mimeType: 'text/html',
      isPublic: false,
    })

    expect(result.fileId).toBe('frec_html_private')
    expect(result.url).toBe('https://oss.example.com/tabdoc/html/demo.html')
    expect(mockUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        folder: 'tabdoc/html',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-1',
        isPublic: false,
      }),
    )
  })

  it('isPublic=true 时走 oss-client，确保 TabDoc 图片真实公开', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    mockUpload.mockResolvedValueOnce({
      fileId: 'frec_doc_image_public',
      fileName: 'image.png',
      fileKey: 'tabdoc/images/image.png',
      fileSize: 32,
      accessUrl: 'https://oss.example.com/tabdoc/images/image.png',
      cdnUrl: '',
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      folder: 'tabdoc/images',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
      mimeType: 'image/png',
      isPublic: true,
    })

    expect(result.fileId).toBe('frec_doc_image_public')
    expect(mockUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        folder: 'tabdoc/images',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-1',
        isPublic: true,
      }),
    )
  })

  it('apiBaseUrl 未注入 → errorCode=no-api-base + 提示 host bridge 未初始化', async () => {
    setTabtin({}) // 空 tabtin 对象
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: 'widget-test',  // 即使传了 contextId，apiBase 缺失也应该报这条
    })

    expect(result.url).toBeNull()
    expect(result.errorCode).toBe('no-api-base')
    expect(result.error).toMatch(/apiBaseUrl/)
  })

  it('auth.getAccessToken 不可用 → errorCode=no-auth', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      // auth 不注入
    })
    const { uploadFileToOSS } = await import('../oss-upload')

    const result = await uploadFileToOSS(tmpFile, {
      contextId: 'widget-test',
    })

    expect(result.url).toBeNull()
    expect(result.errorCode).toBe('no-auth')
    expect(result.error).toMatch(/getAccessToken/)
  })

  it('永远 resolve（不 reject）—— 调用方可以信赖 await 永不抛', async () => {
    setTabtin({})
    const { uploadFileToOSS } = await import('../oss-upload')

    // 文件不存在 → fs.readFileSync 抛错 —— 但 uploadFileToOSS 应该 catch
    const result = await uploadFileToOSS('/nonexistent/path/to/file.png', {
      contextId: 'x',
    })

    expect(result.url).toBeNull()
    expect(result.error).toBeDefined()
  })
})

describe('uploadFileToOSSLegacy — 兼容包装（仅过渡期使用）', () => {
  it('成功时返 url 字符串', async () => {
    setTabtin({
      apiBaseUrl: 'http://localhost:7070/api',
      auth: { getAccessToken: () => 'fake-token' },
    })
    mockUpload.mockResolvedValueOnce({
      fileId: 'frec_legacy',
      fileName: 'file.bin',
      fileKey: 'uploads/file.bin',
      fileSize: 32,
      accessUrl: 'https://oss.example.com/uploads/file.bin',
      cdnUrl: '',
    })
    const { uploadFileToOSSLegacy } = await import('../oss-upload')

    const url = await uploadFileToOSSLegacy(tmpFile, { contextId: 'legacy-ctx' })
    expect(url).toBe('https://oss.example.com/uploads/file.bin')
  })

  it('失败时返 null（与历史签名兼容）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setTabtin({})
    const { uploadFileToOSSLegacy } = await import('../oss-upload')

    const url = await uploadFileToOSSLegacy(tmpFile, { contextId: 'x' })

    expect(url).toBeNull()
    // 但此时 console.warn 必须含可读 errorCode 提示，方便排错
    expect(warnSpy).toHaveBeenCalledWith(
      '[oss-upload] 上传失败:',
      'no-api-base',
      expect.stringMatching(/apiBaseUrl/),
    )
  })
})

/**
 * @tabtin/local-docparse — error-classifier 纯函数单测
 *
 * 与 Electron 的 H1-D-MAIN classifyWorkerError 用例集合等价（含 Verifier-B
 * 必修 3 修复后的 HTTP status 归类规则）。共享包内最小化保留以保证独立可测。
 *
 * **W1（2026-05-13）**：测试断言值改为 `FilePipelineErrorCode` 全局 enum 字面
 * 值（与 `@tabtin/file-pipeline-errors` SSoT 对齐）。HTTP 5xx/429 现在返
 * `NETWORK_ERROR`（不再压扁到 `UNKNOWN_ERROR`），让 LLM 能拿到"网络问题"的精
 * 确信号。
 */

import { describe, it, expect } from 'vitest'
import {
  DownloadHttpError,
  classifyWorkerError,
  errorClassToFallback,
} from '../error-classifier.js'
import { FilePipelineErrorCode } from '../types.js'

describe('classifyWorkerError (shared package)', () => {
  it('PDF 加密 → ENCRYPTED（name 命中）', () => {
    const err = new Error('No password given')
    err.name = 'PasswordException'
    expect(classifyWorkerError(err)).toBe(FilePipelineErrorCode.ENCRYPTED)
  })

  it('message 含 password → ENCRYPTED', () => {
    expect(classifyWorkerError(new Error('File requires password'))).toBe(
      FilePipelineErrorCode.ENCRYPTED,
    )
  })

  it('PDF 损坏（name 命中）→ CORRUPTED', () => {
    const err = new Error('Invalid PDF structure')
    err.name = 'InvalidPDFException'
    expect(classifyWorkerError(err)).toBe(FilePipelineErrorCode.CORRUPTED)
  })

  it('docx 损坏（mammoth）→ CORRUPTED', () => {
    expect(classifyWorkerError(new Error('not a valid zip'))).toBe(
      FilePipelineErrorCode.CORRUPTED,
    )
  })

  it('xlsx 真损坏（"Corrupt sheet"）→ CORRUPTED', () => {
    expect(classifyWorkerError(new Error('Corrupt sheet'))).toBe(
      FilePipelineErrorCode.CORRUPTED,
    )
  })

  // **W1.1 Review 反馈**：SheetJS 读 .xls 老格式抛 "Unsupported file: foo.xls"
  // / "Unsupported ZIP"——**不是文件损坏**，而是格式不支持。引导用户拖入 chat
  // 走云端解析（cloud python-pptx / openpyxl 兼容更广），不要让用户白白"重新
  // 导出"一份本来正常的文件。
  it('xlsx 不支持的子格式（"Unsupported ZIP" / "Unsupported file"）→ UNSUPPORTED_FORMAT', () => {
    expect(classifyWorkerError(new Error('Unsupported ZIP'))).toBe(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
    )
    expect(classifyWorkerError(new Error('Unsupported file: foo.xls'))).toBe(
      FilePipelineErrorCode.UNSUPPORTED_FORMAT,
    )
  })

  it('文件不存在 → FILE_NOT_FOUND', () => {
    expect(classifyWorkerError(new Error('ENOENT: no such file'))).toBe(
      FilePipelineErrorCode.FILE_NOT_FOUND,
    )
  })

  it('超时 → PARSE_TIMEOUT', () => {
    expect(
      classifyWorkerError(new Error('Task "parse-pdf" timed out after 5000ms')),
    ).toBe(FilePipelineErrorCode.PARSE_TIMEOUT)
  })

  it('未分类 → UNKNOWN_ERROR', () => {
    expect(classifyWorkerError(new Error('something weird'))).toBe(
      FilePipelineErrorCode.UNKNOWN_ERROR,
    )
    expect(classifyWorkerError('string error')).toBe(
      FilePipelineErrorCode.UNKNOWN_ERROR,
    )
    expect(classifyWorkerError(null)).toBe(FilePipelineErrorCode.UNKNOWN_ERROR)
  })

  // H2-E Verifier-B Review 必修：用户主动 abort 应识别为 USER_ABORTED，
  // 不切云端，避免"停止生成"后还偷偷打云端 DocParse 浪费用户流量
  it('WorkerTaskAbortedError → USER_ABORTED（用户取消）', () => {
    const err = new Error('Worker task aborted')
    err.name = 'WorkerTaskAbortedError'
    expect(classifyWorkerError(err)).toBe(FilePipelineErrorCode.USER_ABORTED)
  })

  it('AbortError（fetch 取消）→ USER_ABORTED', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    expect(classifyWorkerError(err)).toBe(FilePipelineErrorCode.USER_ABORTED)
  })

  // HTTP status 归类（Verifier-B 必修 3 + W1 网络错误细分）
  it('DownloadHttpError 404 → FILE_NOT_FOUND', () => {
    expect(classifyWorkerError(new DownloadHttpError(404, 'Not Found'))).toBe(
      FilePipelineErrorCode.FILE_NOT_FOUND,
    )
  })

  it('DownloadHttpError 403 → FILE_NOT_FOUND（权限撤销）', () => {
    expect(classifyWorkerError(new DownloadHttpError(403, 'Forbidden'))).toBe(
      FilePipelineErrorCode.FILE_NOT_FOUND,
    )
  })

  it('DownloadHttpError 410 → FILE_NOT_FOUND（OSS 预签名过期）', () => {
    expect(classifyWorkerError(new DownloadHttpError(410, 'Gone'))).toBe(
      FilePipelineErrorCode.FILE_NOT_FOUND,
    )
  })

  it('DownloadHttpError 500/503/429 → NETWORK_ERROR（W1 修正：不再压扁到 UNKNOWN）', () => {
    expect(
      classifyWorkerError(new DownloadHttpError(500, 'Server Error')),
    ).toBe(FilePipelineErrorCode.NETWORK_ERROR)
    expect(
      classifyWorkerError(new DownloadHttpError(503, 'Service Unavailable')),
    ).toBe(FilePipelineErrorCode.NETWORK_ERROR)
    expect(
      classifyWorkerError(new DownloadHttpError(429, 'Too Many Requests')),
    ).toBe(FilePipelineErrorCode.NETWORK_ERROR)
  })

  // W1.1（Review 反馈）：裸 fetch TypeError 不再压扁到 UNKNOWN，归到 NETWORK_ERROR
  it('裸 fetch TypeError → NETWORK_ERROR (W1.1)', () => {
    const err = new TypeError('fetch failed')
    expect(classifyWorkerError(err)).toBe(FilePipelineErrorCode.NETWORK_ERROR)
  })

  it('ECONNREFUSED / ENOTFOUND / ETIMEDOUT → NETWORK_ERROR (W1.1)', () => {
    expect(classifyWorkerError(new Error('ECONNREFUSED 127.0.0.1:443'))).toBe(
      FilePipelineErrorCode.NETWORK_ERROR,
    )
    expect(
      classifyWorkerError(new Error('getaddrinfo ENOTFOUND oss.example.com')),
    ).toBe(FilePipelineErrorCode.NETWORK_ERROR)
    expect(classifyWorkerError(new Error('ETIMEDOUT'))).toBe(
      FilePipelineErrorCode.NETWORK_ERROR,
    )
  })
})

describe('errorClassToFallback (shared package)', () => {
  it('ENCRYPTED / CORRUPTED / FILE_TOO_LARGE / USER_ABORTED 不切云端', () => {
    expect(errorClassToFallback(FilePipelineErrorCode.ENCRYPTED)).toBe(false)
    expect(errorClassToFallback(FilePipelineErrorCode.CORRUPTED)).toBe(false)
    expect(errorClassToFallback(FilePipelineErrorCode.FILE_TOO_LARGE)).toBe(
      false,
    )
    // H2-E Review：用户主动 abort 不应继续打云端
    expect(errorClassToFallback(FilePipelineErrorCode.USER_ABORTED)).toBe(false)
  })

  it('其他错误均切云端', () => {
    expect(errorClassToFallback(FilePipelineErrorCode.SCANNED_PDF)).toBe(true)
    expect(errorClassToFallback(FilePipelineErrorCode.GARBLED_TEXT_LAYER)).toBe(
      true,
    )
    expect(errorClassToFallback(FilePipelineErrorCode.PARSE_TIMEOUT)).toBe(true)
    expect(errorClassToFallback(FilePipelineErrorCode.UNSUPPORTED_FORMAT)).toBe(
      true,
    )
    expect(errorClassToFallback(FilePipelineErrorCode.FILE_NOT_FOUND)).toBe(
      true,
    )
    expect(errorClassToFallback(FilePipelineErrorCode.NETWORK_ERROR)).toBe(true)
    expect(errorClassToFallback(FilePipelineErrorCode.UNKNOWN_ERROR)).toBe(true)
  })
})

// **W5 L32（2026-05-14）SSoT 运行时校验契约**：
// `classifyWorkerError` 返回的 LocalDocParseErrorClass 是 `FilePipelineErrorCode`
// 子集（USER_ABORTED / FILE_NOT_FOUND / ENCRYPTED / CORRUPTED / NETWORK_ERROR /
// PARSE_TIMEOUT / UNSUPPORTED_FORMAT / UNKNOWN_ERROR）——参见 `types.ts::LocalDocParseErrorClass`
// 类型 jsdoc 与 file-pipeline-errors 数字段分配 jsdoc 互引。
//
// 本测试钉死 classifier 返值字面量**始终属于** SSoT 14 类全集（避免 SSoT 加
// 新 kind 时 classifier 漏 case 走 default 兜底的潜在 regression）。SSoT 加
// 新 kind 时本契约测试自动覆盖（FILE_PIPELINE_ERROR_KINDS 全集自动遍历）。
//
// **不要试图把 classifier 返值集合 ⊇ SSoT 全集**——classifier 只产一个固定
// 子集是正确语义（worker 不会抛出 IMAGE_RESIZE_FAILED / SCANNED_PDF 等）；本
// 测试的角色是"返值落在 SSoT 集合内"约束（包含约束），不是"覆盖所有 SSoT enum"
// （等价约束）。
describe('W5 L32 — classifyWorkerError 返值在 FILE_PIPELINE_ERROR_KINDS SSoT 集合内', () => {
  it('多种代表性 worker 错误的返值都属于 FILE_PIPELINE_ERROR_KINDS（SSoT 集合）', async () => {
    const { FILE_PIPELINE_ERROR_KINDS } = await import(
      '@tabtin/file-pipeline-errors'
    )
    const sampleErrors: unknown[] = [
      Object.assign(new Error('No password given'), { name: 'PasswordException' }),
      Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' }),
      new Error('not a valid zip file'),
      new Error('ENOENT: no such file or directory'),
      new Error('Unsupported file: legacy.xls'),
      new Error('parsing timed out after 30s'),
      new TypeError('fetch failed'),
      new Error('ECONNREFUSED 127.0.0.1'),
      new DownloadHttpError(404, 'Not Found'),
      new DownloadHttpError(500, 'Server Error'),
      Object.assign(new Error('user cancelled'), { name: 'AbortError' }),
      new Error('totally unknown weird error xyz'),
    ]
    for (const err of sampleErrors) {
      const result = classifyWorkerError(err)
      // 全集合包含约束：classifier 返值字面量必属于 SSoT 14 类
      expect(FILE_PIPELINE_ERROR_KINDS as readonly string[]).toContain(result)
    }
  })
})

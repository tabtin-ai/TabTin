/**
 * localDocParse 单元测试
 *
 * 覆盖三类：
 *   A. 纯函数（无 worker）：质量得分、mime 分类、错误分类
 *   B. parseLocalAttachment 决策分支：mock `runDocParserTask` 模拟 worker 返回，
 *      验证 scanned_pdf / garbled_text_layer / encrypted / corrupted /
 *      file_too_large / unsupported_format / file_not_found / parse_timeout 全部
 *      正确 classify + fallbackToCloud 决策（W1 字面值已对齐 file-pipeline-errors）
 *   C. URL 下载路径：mock fetch 模拟 file_too_large / 下载失败 / 正常流
 *
 * Worker handlers 真跑集成测试在 `../../workers/__tests__/doc-parser-handlers.test.ts`
 * （handlers 直接导入，不经 worker_threads；与 worker 协议等价，覆盖 pdfjs 真实行为）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseLocalAttachment,
  computeTextLayerQuality,
  classifyWorkerError,
  DownloadHttpError,
  __forTesting,
  DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
  type LocalDocParseResult,
} from '../localDocParse'

// 必须 mock logger（避免 electron/electron-log 依赖）
vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

// mock worker runner（Part B / C 用这个 mock）
vi.mock('../../workers/doc-parser-runner', () => ({
  runDocParserTask: vi.fn(),
}))

import { runDocParserTask } from '../../workers/doc-parser-runner'

const runDocParserTaskMock = runDocParserTask as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  runDocParserTaskMock.mockReset()
})

// ─── A. 纯函数测试 ──────────────────────────────────────────────

describe('computeTextLayerQuality（对齐 Django _is_text_layer_reliable）', () => {
  // v1.1 改为严格二值（全通过 → 1.0，任一维度 fail → 0），与 Django 精确对齐
  // H1-D-MAIN Review fix1：字符集用 Unicode \p{L}\p{N} 覆盖全部脚本

  it('正常英文文本得分 1.0', () => {
    expect(
      computeTextLayerQuality(
        'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
      ),
    ).toBe(1.0)
  })

  it('正常中文文本得分 1.0', () => {
    expect(
      computeTextLayerQuality(
        '本协议由甲乙双方于本日订立，就本地 PDF 解析主路径事宜达成如下共识。第一条 目标。第二条 交付。',
      ),
    ).toBe(1.0)
  })

  it('正常俄语文本得分 1.0（Unicode 字符集修复）', () => {
    expect(
      computeTextLayerQuality(
        'Быстрая коричневая лиса прыгает через ленивую собаку. Упакуй мою коробку пятью дюжинами бутылок.',
      ),
    ).toBe(1.0)
  })

  it('正常阿拉伯语文本得分 1.0（Unicode 字符集修复）', () => {
    expect(
      computeTextLayerQuality(
        'هذه وثيقة اختبار للتحقق من دعم النصوص العربية في مسار التحليل المحلي للمستندات.',
      ),
    ).toBe(1.0)
  })

  it('希腊字母文本得分 1.0（v1.0 曾误判为乱码）', () => {
    // Django `str.isalnum()` 视希腊字母为 alnum；v1.1 修复对齐
    expect(
      computeTextLayerQuality(
        'αβγδεζηθικλμνξοπρστυφχψω αβγδεζηθικλμνξοπρστυφχψω αβγδεζ',
      ),
    ).toBe(1.0)
  })

  it('空文本返回 0', () => {
    expect(computeTextLayerQuality('')).toBe(0)
  })

  it('极短文本 (< 20 字符) 返回 0', () => {
    expect(computeTextLayerQuality('hello')).toBe(0)
  })

  it('乱码控制字符 > 10% 返回 0（OCR 伪文本）', () => {
    // 20 有效 + 5 控制字符 = 25 cleaned，5/25 = 20% 乱码
    const text = 'abcdefghijklmnopqrst\x01\x02\x03\x04\x05'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('单字符重复 > 40% 返回 0（OCR 残影）', () => {
    // 45 个 "a" + 10 个其他字符 = 55 cleaned, 45/55 ≈ 82% > 40%
    const text = 'a'.repeat(45) + 'bcdefghij'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('大量纯符号（无字母数字）返回 0', () => {
    // 纯数学符号 + 货币符号，不属于 \p{L}\p{N} 也不在标点白名单
    const text = '∂∆∑∏√∞≠≈≤≥' + '¡¢£¤¥¦§¨©ª«¬®¯' + '±×÷°…‽﹡﹢﹣﹤﹥'
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('meaningfulRatio 恰好 0.3 时通过二值阈值', () => {
    // 6 字母 + 14 非 meaningful（全部用纯符号填充）= 30% 有意义
    const text = 'abcdef' + '¥¦§¨©ª«¬®¯±×÷°' // 6 + 14 = 20 字符
    expect(computeTextLayerQuality(text)).toBe(1.0)
  })

  it('meaningfulRatio 低于 0.3 但高于 0.09 也判乱码（修复 v1.0 宽松 3.3× 的偏差）', () => {
    // 20% 字母 + 80% 纯符号：v1.0 得 0.67 → 高于 0.3 阈值错误放行；v1.1 得 0
    const text = 'abcd' + '¥¦§¨©ª«¬®¯±×÷°¡¢£¤'.repeat(1)
    // 4 / (4 + 18) ≈ 0.18 < 0.3
    expect(computeTextLayerQuality(text)).toBe(0)
  })

  it('典型 OCR 乱码底层 PDF → 得分 0', () => {
    const text = '\x01\x02\x03\x04\x05\x06\x07\x08\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19abc'
    expect(computeTextLayerQuality(text)).toBe(0)
  })
})

describe('classifyMimeForLocal', () => {
  const { classifyMimeForLocal } = __forTesting

  it('识别 PDF mime', () => {
    expect(classifyMimeForLocal('application/pdf')).toBe('pdf')
    expect(classifyMimeForLocal('APPLICATION/PDF')).toBe('pdf')
  })

  it('识别 docx mime', () => {
    expect(
      classifyMimeForLocal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('docx')
  })

  it('识别 xlsx mime', () => {
    expect(
      classifyMimeForLocal('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe('xlsx')
  })

  it('PPT / 老 Office 标记为 unsupported（切云端）', () => {
    expect(classifyMimeForLocal('application/vnd.ms-powerpoint')).toBe('unsupported')
    expect(
      classifyMimeForLocal('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    ).toBe('unsupported')
    expect(classifyMimeForLocal('application/msword')).toBe('unsupported')
    expect(classifyMimeForLocal('application/vnd.ms-excel')).toBe('unsupported')
  })

  it('mime 缺失时走文件名扩展名兜底', () => {
    expect(classifyMimeForLocal('', 'report.pdf')).toBe('pdf')
    expect(classifyMimeForLocal('application/octet-stream', 'data.xlsx')).toBe('xlsx')
  })

  it('未知 mime + 未知扩展名 → unsupported', () => {
    expect(classifyMimeForLocal('application/zip', 'archive.zip')).toBe('unsupported')
    expect(classifyMimeForLocal('')).toBe('unsupported')
  })
})

describe('classifyWorkerError', () => {
  it('PDF 加密识别为 encrypted', () => {
    const err = new Error('No password given')
    err.name = 'PasswordException'
    expect(classifyWorkerError(err)).toBe('encrypted')
  })

  it('message 含 password 也识别为 encrypted', () => {
    expect(classifyWorkerError(new Error('File requires password'))).toBe('encrypted')
  })

  it('PDF 损坏识别为 corrupted', () => {
    const err = new Error('Invalid PDF structure')
    err.name = 'InvalidPDFException'
    expect(classifyWorkerError(err)).toBe('corrupted')
  })

  it('docx 损坏（mammoth） 识别为 corrupted', () => {
    expect(classifyWorkerError(new Error('not a valid zip'))).toBe('corrupted')
  })

  it('xlsx 真损坏（"Corrupt sheet"）识别为 corrupted', () => {
    expect(classifyWorkerError(new Error('Corrupt sheet'))).toBe('corrupted')
  })

  // **W1.1（2026-05-13 Review 反馈）**：SheetJS 抛 "Unsupported file" / "Unsupported ZIP"
  // 实际是格式不支持（如读 .xls 老格式 / 罕见 zip 子格式），不是文件损坏。
  // 引导用户拖入 chat 走云端 openpyxl / python-pptx 兼容更广，避免让用户白
  // 白"重新导出"一份本来正常的文件。
  it('xlsx 不支持子格式（"Unsupported ZIP" / "Unsupported file"）识别为 unsupported_format（W1.1）', () => {
    expect(classifyWorkerError(new Error('Unsupported ZIP'))).toBe('unsupported_format')
    expect(classifyWorkerError(new Error('Unsupported file: foo.xls'))).toBe('unsupported_format')
  })

  it('文件不存在识别为 FILE_NOT_FOUND (W1)', () => {
    expect(classifyWorkerError(new Error('ENOENT: no such file'))).toBe('file_not_found')
  })

  it('超时识别为 PARSE_TIMEOUT (W1)', () => {
    expect(classifyWorkerError(new Error('Task "parse-pdf" timed out after 5000ms'))).toBe('parse_timeout')
  })

  it('未分类错误返回 UNKNOWN_ERROR (W1)', () => {
    expect(classifyWorkerError(new Error('something weird happened'))).toBe('upstream_error')
    expect(classifyWorkerError('string error')).toBe('upstream_error')
    expect(classifyWorkerError(null)).toBe('upstream_error')
  })

  // Verifier-B 必修 3：HTTP status 码归类
  it('DownloadHttpError 404 → FILE_NOT_FOUND (W1)', () => {
    expect(classifyWorkerError(new DownloadHttpError(404, 'Not Found'))).toBe('file_not_found')
  })

  it('DownloadHttpError 403 → FILE_NOT_FOUND（权限撤销）(W1)', () => {
    expect(classifyWorkerError(new DownloadHttpError(403, 'Forbidden'))).toBe('file_not_found')
  })

  it('DownloadHttpError 410 → FILE_NOT_FOUND（OSS 预签名过期）(W1)', () => {
    expect(classifyWorkerError(new DownloadHttpError(410, 'Gone'))).toBe('file_not_found')
  })

  it('DownloadHttpError 500/503 → NETWORK_ERROR (W1：细分到网络错误)', () => {
    expect(classifyWorkerError(new DownloadHttpError(500, 'Server Error'))).toBe('network_failed')
    expect(classifyWorkerError(new DownloadHttpError(503, 'Service Unavailable'))).toBe('network_failed')
  })

  it('DownloadHttpError 429（限流）→ NETWORK_ERROR (W1)', () => {
    expect(classifyWorkerError(new DownloadHttpError(429, 'Too Many Requests'))).toBe('network_failed')
  })
})

describe('errorClassToFallback', () => {
  const { errorClassToFallback } = __forTesting

  it('ENCRYPTED / CORRUPTED / FILE_TOO_LARGE / USER_ABORTED 不切云端 (W1)', () => {
    expect(errorClassToFallback('encrypted')).toBe(false)
    expect(errorClassToFallback('corrupted')).toBe(false)
    expect(errorClassToFallback('file_too_large')).toBe(false)
    expect(errorClassToFallback('aborted')).toBe(false)
  })

  it('其他所有错误类都切云端 (W1)', () => {
    expect(errorClassToFallback('scanned_pdf')).toBe(true)
    expect(errorClassToFallback('garbled_text_layer')).toBe(true)
    expect(errorClassToFallback('parse_timeout')).toBe(true)
    expect(errorClassToFallback('unsupported_format')).toBe(true)
    expect(errorClassToFallback('file_not_found')).toBe(true)
    expect(errorClassToFallback('upstream_error')).toBe(true)
    expect(errorClassToFallback('network_failed')).toBe(true)
  })
})

// ─── B. parseLocalAttachment 分支测试（mock worker） ─────────────

describe('parseLocalAttachment — 不支持类型（切云端）', () => {
  it('PPT 返回 unsupported + fallbackToCloud=true', async () => {
    const r = (await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/ignored.pptx' }, mimeType: 'application/vnd.ms-powerpoint' },
    )) as LocalDocParseResult

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('unsupported_format')
    expect(r.fallbackToCloud).toBe(true)
    // 不应调用 worker
    expect(runDocParserTaskMock).not.toHaveBeenCalled()
  })

  it('未知 mime 返回 unsupported + fallbackToCloud=true', async () => {
    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/x.zip' }, mimeType: 'application/zip' },
    )
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errorClass).toBe('unsupported_format')
  })
})

describe('parseLocalAttachment — oversize（不切云端，明确提示）', () => {
  it('预知体积 > 50MB 直接返回 oversize', async () => {
    const sizeMb = DEFAULT_MAX_LOCAL_FILE_SIZE_MB + 10
    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/big.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: sizeMb * 1024 * 1024,
      },
    )
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('file_too_large')
    expect(r.fallbackToCloud).toBe(false)
    expect(runDocParserTaskMock).not.toHaveBeenCalled()
  })

  it('自定义 maxFileSizeMb 生效', async () => {
    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/medium.pdf' },
        mimeType: 'application/pdf',
        fileSizeBytes: 10 * 1024 * 1024,
      },
      { maxFileSizeMb: 5 },
    )
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errorClass).toBe('file_too_large')
  })
})

describe('parseLocalAttachment — PDF（mock worker）', () => {
  it('正常 PDF 返回 success + text + pages + qualityScore（来自 worker）', async () => {
    // Verifier-B 必修 2：qualityScore 由 worker 返回（主进程不再计算）
    runDocParserTaskMock.mockResolvedValue({
      text: 'Hello World. This is a normal PDF with enough text to pass quality check. 本协议由甲乙双方订立。',
      pages: 3,
      charCount: 120,
      charsPerPageAvg: 40,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 1.0, // worker 在 handleParsePdf 里计算并返回
      fileSizeBytes: 1024,
      parseDurationMs: 12,
      firstPageDurationMs: 4,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/normal.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 1024 },
    )

    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.text).toContain('本协议')
    expect(r.pages).toBe(3)
    expect(r.qualityScore).toBe(1.0) // 直接透传 worker 的计算值
    expect(r.mimeType).toBe('application/pdf')
  })

  it('扫描件 → scanned + fallbackToCloud=true', async () => {
    runDocParserTaskMock.mockResolvedValue({
      text: '',
      pages: 5,
      charCount: 20,
      charsPerPageAvg: 4,
      emptyPages: 5,
      isScanned: true,
      qualityScore: 0,
      fileSizeBytes: 2048,
      parseDurationMs: 8,
      firstPageDurationMs: 3,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/scan.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 2048 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('scanned_pdf')
    expect(r.fallbackToCloud).toBe(true)
  })

  it('乱码文本层 → garbled_text_layer + fallbackToCloud=true（worker 已计算低分）', async () => {
    // Verifier-B 必修 2：worker 已经计算好 qualityScore，主进程只比较阈值
    runDocParserTaskMock.mockResolvedValue({
      text: '\x01\x02\x03\x04\x05\x06\x07\x08\x0e\x0f\x10\x11'.repeat(20),
      pages: 1,
      charCount: 240,
      charsPerPageAvg: 240,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 0, // worker 判定为乱码
      fileSizeBytes: 5000,
      parseDurationMs: 10,
      firstPageDurationMs: 4,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/garbled.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 5000 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('garbled_text_layer')
    expect(r.fallbackToCloud).toBe(true)
  })

  it('quality 0.2（恰好低于阈值 0.3）→ garbled_text_layer', async () => {
    runDocParserTaskMock.mockResolvedValue({
      text: 'some mid-quality text',
      pages: 1,
      charCount: 21,
      charsPerPageAvg: 121,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 0.2, // 低于默认 0.3 阈值
      fileSizeBytes: 3000,
      parseDurationMs: 5,
      firstPageDurationMs: 2,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/lowq.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 3000 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('garbled_text_layer')
  })

  it('quality 0.5（高于阈值但不够好）→ 仍视为 success', async () => {
    // 边界确认：只要 >= qualityMin（默认 0.3）就 success
    runDocParserTaskMock.mockResolvedValue({
      text: 'ok quality text',
      pages: 1,
      charCount: 15,
      charsPerPageAvg: 115,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 0.5,
      fileSizeBytes: 3000,
      parseDurationMs: 5,
      firstPageDurationMs: 2,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/midq.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 3000 },
    )

    expect(r.success).toBe(true)
    if (r.success) expect(r.qualityScore).toBe(0.5)
  })

  it('加密 PDF → encrypted + fallbackToCloud=false', async () => {
    const err = new Error('Password required')
    err.name = 'PasswordException'
    runDocParserTaskMock.mockRejectedValue(err)

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/enc.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 3400 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('encrypted')
    expect(r.fallbackToCloud).toBe(false)
  })

  it('损坏 PDF → corrupted + fallbackToCloud=false', async () => {
    const err = new Error('Invalid PDF structure')
    err.name = 'InvalidPDFException'
    runDocParserTaskMock.mockRejectedValue(err)

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/corrupt.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 1900 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('corrupted')
    expect(r.fallbackToCloud).toBe(false)
  })

  it('worker 超时 → timeout + fallbackToCloud=true', async () => {
    runDocParserTaskMock.mockRejectedValue(new Error('[doc-parser] Task "parse-pdf" timed out after 5000ms'))

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/big.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 20 * 1024 * 1024 },
      { timeoutMs: 5000 },
    )

    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('parse_timeout')
    expect(r.fallbackToCloud).toBe(true)
  })

  it('路径不存在 → not_found + fallbackToCloud=true', async () => {
    // stat 会抛 ENOENT；不走 worker
    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/does-not-exist-' + Date.now() + '.pdf' }, mimeType: 'application/pdf' },
    )
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('file_not_found')
    expect(r.fallbackToCloud).toBe(true)
  })
})

describe('parseLocalAttachment — docx（mock worker）', () => {
  it('正常 docx 返回 success', async () => {
    runDocParserTaskMock.mockResolvedValue({
      text: 'Hello. This is a normal Word document with reasonable content.',
      fileSizeBytes: 5000,
      parseDurationMs: 8,
      messageCount: 0,
    })

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/doc.docx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 5000,
      },
    )
    expect(r.success).toBe(true)
    if (r.success) expect(r.text).toContain('Word document')
  })

  it('不是真正的 docx（zip 解不开） → corrupted', async () => {
    runDocParserTaskMock.mockRejectedValue(new Error('not a valid zip file'))

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/fake.docx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileSizeBytes: 1000,
      },
    )
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('corrupted')
      expect(r.fallbackToCloud).toBe(false)
    }
  })
})

describe('parseLocalAttachment — xlsx（mock worker）', () => {
  it('正常 xlsx 返回 success', async () => {
    runDocParserTaskMock.mockResolvedValue({
      text: '## Sheet1\n\n| Name | Age |\n|---|---|\n| Alice | 30 |\n| Bob | 25 |',
      sheetCount: 1,
      sheetsTruncated: 0,
      rowsTruncatedCount: 0,
      cellCount: 6,
      fileSizeBytes: 3000,
      parseDurationMs: 5,
    })

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/data.xlsx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSizeBytes: 3000,
      },
    )
    expect(r.success).toBe(true)
    if (r.success) expect(r.text).toContain('Sheet1')
  })

  it('损坏 xlsx → corrupted', async () => {
    runDocParserTaskMock.mockRejectedValue(new Error('Corrupt workbook'))

    const r = await parseLocalAttachment(
      {
        source: { kind: 'path', path: '/tmp/bad.xlsx' },
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSizeBytes: 1000,
      },
    )
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errorClass).toBe('corrupted')
  })
})

describe('parseLocalAttachment — 埋点字段齐全', () => {
  it('成功时含 pages / duration / qualityScore / fileSize', async () => {
    runDocParserTaskMock.mockResolvedValue({
      text: 'Just enough ordinary text to pass quality check for metric verification.',
      pages: 2,
      charCount: 80,
      charsPerPageAvg: 40,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 0.95, // worker 已算好，主进程不再计算
      fileSizeBytes: 1024,
      parseDurationMs: 10,
      firstPageDurationMs: 4,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/p.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 1024 },
    )
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(typeof r.durationMs).toBe('number')
    expect(r.pages).toBe(2)
    expect(r.fileSizeBytes).toBe(1024)
    expect(r.qualityScore).toBe(0.95)
  })

  it('失败时含 errorClass / fallbackToCloud / duration', async () => {
    runDocParserTaskMock.mockRejectedValue(new Error('weird'))

    const r = await parseLocalAttachment(
      { source: { kind: 'path', path: '/tmp/weird.pdf' }, mimeType: 'application/pdf', fileSizeBytes: 500 },
    )
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.errorClass).toBe('upstream_error')
    expect(r.fallbackToCloud).toBe(true)
    expect(typeof r.durationMs).toBe('number')
  })
})

// ─── C. URL 下载路径（mock fetch） ───────────────────────────────

describe('parseLocalAttachment — URL 下载路径', () => {
  it('content-length 标记 oversize → errorClass=oversize（不切云端）', async () => {
    const bigBytes = (DEFAULT_MAX_LOCAL_FILE_SIZE_MB + 10) * 1024 * 1024
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(bigBytes) }),
      body: new ReadableStream(),
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/big.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('file_too_large')
      expect(r.fallbackToCloud).toBe(false)
    }
    expect(runDocParserTaskMock).not.toHaveBeenCalled()
  })

  it('HTTP 404 → errorClass=not_found（fallbackToCloud=true，Verifier-B 必修 3）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
      body: null,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/missing.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('file_not_found')
      expect(r.fallbackToCloud).toBe(true)
    }
  })

  it('HTTP 403 → errorClass=not_found（权限撤销视为不存在）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers(),
      body: null,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/denied.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('file_not_found')
      expect(r.fallbackToCloud).toBe(true)
    }
  })

  it('HTTP 410 → errorClass=not_found（OSS 预签名过期常见 410）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 410,
      statusText: 'Gone',
      headers: new Headers(),
      body: null,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/expired.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) expect(r.errorClass).toBe('file_not_found')
  })

  it('HTTP 500 / 其他错误 → errorClass=unknown（非 not_found，让上层切云端）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      body: null,
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/broken.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      // W1（2026-05-13）：HTTP 5xx 现在归类为 NETWORK_ERROR（'network_failed'），
      // 让 LLM 拿到"网络异常"的精确信号，而不是被压扁到 generic 'upstream_error'。
      expect(r.errorClass).toBe('network_failed')
      expect(r.fallbackToCloud).toBe(true)
    }
  })

  // **W1.1（2026-05-13 Review 反馈）**：fetch 裸 TypeError 之前归到
  // UNKNOWN_ERROR(upstream_error)，让 LLM / UI 拿到的 hint 是 generic
  // "drag into chat" —— 网络抖动场景给错误的引导。修复后归到 NETWORK_ERROR
  // (network_failed)，hint 变成 "检查网络后重试"，与 DownloadHttpError 5xx
  // 同款分支。
  it('fetch 抛网络错误 → errorClass=network_failed（fallbackToCloud=true，W1.1）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/unreachable.pdf' }, mimeType: 'application/pdf' },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('network_failed')
      expect(r.fallbackToCloud).toBe(true)
    }
  })

  it('fetch AbortError（超时）→ errorClass=parse_timeout（fallbackToCloud=true）', async () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    const fetchMock = vi.fn().mockRejectedValue(err)
    vi.stubGlobal('fetch', fetchMock)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/slow.pdf' }, mimeType: 'application/pdf' },
      { timeoutMs: 100 },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.errorClass).toBe('parse_timeout')
      expect(r.fallbackToCloud).toBe(true)
    }
  })

  it('上游 AbortSignal 触发时会中断 fetch + 归类为 aborted（H2-E：用户取消不切云端）', async () => {
    // 模拟一个永远不返回的 fetch，但支持 abort
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit | undefined) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
          return
        }
        signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/slow.pdf' }, mimeType: 'application/pdf' },
      { timeoutMs: 10000, signal: controller.signal },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(false)
    if (!r.success) {
      // H2-E Verifier-B Review 必修：用户主动 abort（options.signal.aborted=true）
      // 应识别为 'aborted'（不切云端）；区别于内部 timeout（'timeout'，切云端兜底）
      expect(r.errorClass).toBe('aborted')
      expect(r.fallbackToCloud).toBe(false)
    }
  })
})

describe('parseLocalAttachment — 超时预算串行扣减（fix4）', () => {
  it('URL 下载耗时后，worker 预算至少留 500ms 兜底', async () => {
    // 模拟下载耗时 2s 的 fetch，timeoutMs 设 2500
    const slowFetch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([37, 80, 68, 70]))
            controller.close()
          },
        }),
      }
    })
    vi.stubGlobal('fetch', slowFetch)

    // worker 返回正常结果（包含 qualityScore，Verifier-B 必修 2 后 worker 侧计算）
    runDocParserTaskMock.mockResolvedValue({
      text: 'Just enough text to pass the sanity check for budget verification testing.',
      pages: 1,
      charCount: 76,
      charsPerPageAvg: 76,
      emptyPages: 0,
      isScanned: false,
      qualityScore: 1.0,
      fileSizeBytes: 4,
      parseDurationMs: 5,
      firstPageDurationMs: 2,
    })

    const r = await parseLocalAttachment(
      { source: { kind: 'url', url: 'https://oss.example/x.pdf' }, mimeType: 'application/pdf' },
      { timeoutMs: 2500 },
    )

    vi.unstubAllGlobals()
    expect(r.success).toBe(true)
    // 验证 worker 被调用时 timeoutMs 比总预算小（因为下载已耗了一点）
    expect(runDocParserTaskMock).toHaveBeenCalled()
    const workerCallOptions = runDocParserTaskMock.mock.calls[0][2] as { timeoutMs: number }
    expect(workerCallOptions.timeoutMs).toBeLessThan(2500)
    expect(workerCallOptions.timeoutMs).toBeGreaterThanOrEqual(500)
  })
})

import { describe, expect, it } from 'vitest'

import {
  RESOURCE_IMPORT_ACCEPT,
  RESOURCE_IMPORT_ACCEPT_BY_APP_ID,
  RESOURCE_IMPORT_CONFIG,
  TABFILES_IMPORT_MAX_SIZE_BYTES,
  formatResourceImportFormats,
  getImportMaxSizeBytes,
  getImportedResourceTitle,
  resolveResourceImportTargetAppId,
} from '../resourceFileImportRouting'

describe('cloud resource import routing', () => {
  it.each([
    'report.xlsx',
    'report.docx',
    'deck.pptx',
    'report.pdf',
    'archive.zip',
  ])('routes cloud drive file %s to tabfiles', (fileName) => {
    expect(resolveResourceImportTargetAppId(fileName)).toBe('tabfiles')
  })

  it.each([
    ['report.xlsx', 'tabdata'],
    ['report.json', 'tabdata'],
    ['report.doc', 'tabdoc'],
    ['report.docx', 'tabdoc'],
    ['notes.mark', 'tabdoc'],
  ] as const)('keeps explicit %s imports in %s', (fileName, appId) => {
    expect(resolveResourceImportTargetAppId(fileName, appId)).toBe(appId)
  })

  // ：TabSlide App UI 隐藏（默认 TABSLIDE_UI_ENABLED=false）时，
  // 显式 tabslide 白名单为空，.pptx 也不能进 TabSlide。
  it.each([
    ['report.pdf', 'tabdata'],
    ['report.pdf', 'tabdoc'],
    ['deck.pptx', 'tabslide'],
    ['deck.ppt', 'tabslide'],
  ] as const)('rejects %s outside the explicit %s allowlist', (fileName, appId) => {
    expect(resolveResourceImportTargetAppId(fileName, appId)).toBeNull()
  })

  it('keeps the file picker allowlist aligned with per-app routing (TabSlide UI hidden → no .pptx)', () => {
    expect(RESOURCE_IMPORT_ACCEPT_BY_APP_ID).toEqual({
      tabdata: '.csv,.xlsx,.xls,.json',
      tabdoc: '.md,.markdown,.mark,.txt,.doc,.docx',
      tabslide: '',
    })
    expect(RESOURCE_IMPORT_ACCEPT).toBe(
      '.csv,.xlsx,.xls,.json,.md,.markdown,.mark,.txt,.doc,.docx',
    )
  })

  it('preserves each importer file-size limit', () => {
    expect(TABFILES_IMPORT_MAX_SIZE_BYTES).toBe(100 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdata.maxImportSizeBytes).toBe(25 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdata.maxImportSizeBytesByExtension?.json).toBe(10 * 1024 * 1024)
    expect(getImportMaxSizeBytes('tabdata', 'json')).toBe(10 * 1024 * 1024)
    expect(getImportMaxSizeBytes('tabdata', 'xlsx')).toBe(25 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdoc.maxImportSizeBytes).toBe(5 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdoc.maxImportSizeBytesByExtension?.doc).toBe(50 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdoc.maxImportSizeBytesByExtension?.docx).toBe(50 * 1024 * 1024)
    expect(RESOURCE_IMPORT_CONFIG.tabdoc.maxImportSizeBytesByExtension?.pdf).toBeUndefined()
    expect(RESOURCE_IMPORT_CONFIG.tabslide.maxImportSizeBytes).toBe(50 * 1024 * 1024)
  })

  it.each([
    ['季度报告.pdf', '季度报告.pdf', '季度报告'],
    ['季度报告.PDF', '季度报告.PDF', '季度报告'],
    ['季度报告.pdf', '财务汇总.pdf', '财务汇总'],
    ['季度报告.pdf', '财务汇总.v2.pdf', '财务汇总.v2'],
    ['季度报告.pdf', '财务汇总.v2', '财务汇总.v2'],
    ['季度报告.pdf', '财务汇总', '财务汇总'],
  ])('removes only the source file extension from imported titles', (
    fileName,
    importedTitle,
    expected,
  ) => {
    expect(getImportedResourceTitle(fileName, '未命名', importedTitle)).toBe(expected)
  })

  it('uses the source file name when no parsed title is available', () => {
    expect(getImportedResourceTitle('季度报告.pdf', '未命名')).toBe('季度报告')
  })

  it('formats accepted extensions for the active language', () => {
    expect(formatResourceImportFormats('.pdf,.docx', 'zh-CN')).toBe('.pdf、.docx')
    expect(formatResourceImportFormats('.pdf,.docx', 'en-US')).toBe('.pdf, .docx')
  })
})

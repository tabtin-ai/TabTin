import { describe, expect, it } from 'vitest'

async function readPptxViewerSource() {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const srcPath = path.resolve(__dirname, '../../../shared/file-preview/PptxViewer.tsx')
  return fs.readFileSync(srcPath, 'utf-8')
}

describe('PptxViewer high-fidelity import path', () => {
  it('tries the main-process rendered office preview before DOM-based PPTX import', async () => {
    const source = await readPptxViewerSource()

    expect(source).toContain('renderOfficePreview')
    expect(source).toContain('OfficeRenderedPagesViewer')
    expect(source.indexOf('renderOfficePreview')).toBeLessThan(source.indexOf('importPPTXFromFile'))
  })

  // ：聊天对话框以内存 data 打开 PPTX，必须先走高保真逐页渲染，
  // 不能直接掉进 TabSlide 元素级低保真预览（文字重叠 / 版式错乱）。
  // 用调用点字面量比较顺序，避免命中文件头注释里的 importPPTXFromBuffer。
  it('chat/data mode tries renderOfficePreviewData before low-fidelity TabSlide import', async () => {
    const source = await readPptxViewerSource()

    expect(source).toContain('renderOfficePreviewData({')
    expect(source.indexOf('renderOfficePreviewData({')).toBeLessThan(
      source.indexOf('importPPTXFromFile(fileForBackendImport)'),
    )
    expect(source.indexOf('renderOfficePreviewData({')).toBeLessThan(
      source.indexOf('importPPTXFromBuffer(buffer, resolvedFilename)'),
    )
  })

  it('registers the backend import adapter and tries importPPTXFromFile before the low-fidelity buffer fallback', async () => {
    const source = await readPptxViewerSource()

    expect(source).toContain('ensureBackendImportAdapterRegistered')
    expect(source).toContain('importPPTXFromFile')
    expect(source).toContain('importPPTXFromBuffer')
    expect(source.indexOf('ensureBackendImportAdapterRegistered()')).toBeLessThan(source.indexOf('importPPTXFromFile(fileForBackendImport)'))
    expect(source.indexOf('importPPTXFromFile(fileForBackendImport)')).toBeLessThan(source.indexOf('importPPTXFromBuffer(buffer, resolvedFilename)'))
  })

  // ：元素级预览必须带 CJK fallback，不能裸套 Arial / sans-serif。
  it('element preview uses CJK font fallback instead of a bare latin family', async () => {
    const source = await readPptxViewerSource()
    expect(source).toContain('buildPptxPreviewFontFamily(')
    expect(source).not.toMatch(/fontFamily:\s*el\.defaultFontName\s*\|\|\s*'sans-serif'/)
    expect(source).not.toMatch(/fontFamily:\s*el\.text\.defaultFontName\s*\|\|\s*'sans-serif'/)
  })
})

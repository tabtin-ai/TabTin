/**
 * TabData / TabDoc 单文件导入入口图标契约：与云盘同款 Lucide FileInput。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(process.cwd(), '../..')
const read = (relativeFromRepo: string) =>
  readFileSync(resolve(repoRoot, relativeFromRepo), 'utf8')

describe('TabData/TabDoc single-file import icons use FileInput', () => {
  it('ContextHome toolbar import overrides to FileInput', () => {
    const source = read(
      'apps/tabtin-electron/src/renderer/src/components/context-space/ContextHome.tsx',
    )
    expect(source).toContain('<ContextPageToolbarImportButton')
    expect(source).toContain('icon={FileInput}')
  })

  it('TabDoc DocList import button uses FileInput', () => {
    const source = read('packages/tabdoc-ui/src/editor/DocList.tsx')
    expect(source).toContain('<FileInput className="h-3.5 w-3.5" />')
    expect(source).not.toContain('FileUp')
  })

  it('TabData more-menu import uses FileInput', () => {
    const source = read('packages/table-ui/src/components/toolbar/GridToolbarMoreMenu.tsx')
    expect(source).toContain('<FileInput className="h-4 w-4" />')
    expect(source).toContain('onShowImportDialog')
  })

  it('TabData import dialog dropzone uses FileInput', () => {
    const source = read('packages/smartsheet-ui/src/components/import/file-upload.tsx')
    expect(source).toContain('<FileInput')
    expect(source).not.toContain('<Upload')
  })
})

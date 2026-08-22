import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ：本地目录删文件夹后搜索框 IME 能出、字进不了框。
 * 契约：删除确认不得再用同步 window.confirm（会卡住 ContextMenu 关闭）。
 */
describe('FileTree delete confirm contract ', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../FileTree.tsx'),
    'utf8',
  )

  it('does not use synchronous window.confirm for delete', () => {
    // 去掉注释后再断言，避免注释里提到旧 API 误伤
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bconfirm\s*\(/)
    expect(code).not.toMatch(/window\.confirm/)
  })

  it('uses ConfirmDialog with pendingDelete + restoreFocusOnClose', () => {
    expect(source).toContain('ConfirmDialog')
    expect(source).toContain('pendingDelete')
    expect(source).toContain('setPendingDelete')
    expect(source).toContain('restoreFocusOnClose')
  })
})

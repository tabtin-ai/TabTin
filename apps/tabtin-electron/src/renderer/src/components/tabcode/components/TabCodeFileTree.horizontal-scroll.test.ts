import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/tabcode/components/TabCodeFileTree.tsx'),
  'utf8',
)

describe('TabCodeFileTree deep-name horizontal scrolling', () => {
  const renderTreeItemSource = source.slice(
    source.indexOf('const renderTreeItem = useCallback'),
    source.indexOf('const renderGitChangeRow = useCallback'),
  )

  it('keeps the normal tree row content-sized and the filename on one line', () => {
    expect(renderTreeItemSource).toContain("width: 'max-content'")
    expect(renderTreeItemSource).toContain("minWidth: 'calc(100% - 8px)'")
    expect(renderTreeItemSource).toContain('flex-1 whitespace-nowrap')
    expect(renderTreeItemSource).not.toContain('flex-1 truncate')
  })

  it('enables horizontal scrolling on the TabCode tree viewport', () => {
    const treeViewportSource = source.slice(
      source.indexOf('ref={scrollRef}'),
      source.indexOf('{...getRootDropHandlers(rootPath)}'),
    )

    expect(treeViewportSource).toContain('overflow-x-auto')
    expect(treeViewportSource).toContain('overflow-y-auto')
  })
})

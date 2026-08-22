import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const contextSpaceDir = dirname(fileURLToPath(import.meta.url))

describe('失权资源返回会话的关闭意图', () => {
  it('TabData 的“返回空间”记录用户显式关闭意图', () => {
    const source = readFileSync(
      join(contextSpaceDir, '../table/TablePaneView.tsx'),
      'utf8',
    )
    const returnHandler = source.match(
      /const handleCloseTab = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[tableId, tabScopeKey\]\)/,
    )?.[0]

    expect(returnHandler).toContain('closeExplicitTab')
  })

  it('TabDoc 的“返回空间”记录用户显式关闭意图', () => {
    const source = readFileSync(
      join(contextSpaceDir, 'tabdoc/components/DocEditorView.tsx'),
      'utf8',
    )
    const returnHandler = source.match(
      /const handleReturnFromRemoved = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[activeDocumentId, docTabScopeKey\]\)/,
    )?.[0]

    expect(returnHandler).toContain('closeExplicitTab')
  })
})

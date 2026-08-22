/**
 * 云盘文件夹嵌套拖拽契约（对齐 ：dragStart 禁同步 setState）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/hooks/useCollectionFolderMenu.tsx'),
  'utf8',
)

describe('useCollectionFolderMenu folder DnD contract', () => {
  it('uses ref for folder drag payload; defers visual setState to rAF', () => {
    expect(source).toContain('draggingFolderIdRef')
    expect(source).toContain('draggingFolderIdRef.current = collection.id')
    const dragStartBody = source.slice(
      source.indexOf('const handleFolderDragStart = useCallback'),
      source.indexOf('const handleFolderDragEnd = useCallback'),
    )
    const beforeRaf = dragStartBody.slice(0, dragStartBody.indexOf('requestAnimationFrame'))
    expect(beforeRaf).not.toMatch(/setDraggingFolderId\s*\(/)
    expect(dragStartBody).toContain('requestAnimationFrame')
    expect(dragStartBody).toMatch(/requestAnimationFrame[\s\S]*setDraggingFolderId\s*\(\s*collection\.id\s*\)/)
  })

  it('reads ref on dragOver/drop for Windows MIME gaps', () => {
    expect(source).toContain('draggingFolderIdRef.current || event.dataTransfer.getData(COLLECTION_FOLDER_MIME)')
    expect(source).toContain('isFolderDragActive')
  })

  it('exposes folder pin/unpin menu entry ', () => {
    expect(source).toContain('handleToggleFolderPin')
    expect(source).toContain("t('home.pin'")
    expect(source).toContain("t('home.unpin'")
    expect(source).toContain('is_pinned: !collection.is_pinned')
  })

  it('exposes breadcrumb parent drop handlers for folder reposition', () => {
    expect(source).toContain('handleFolderDragOverParent')
    expect(source).toContain('handleFolderDropToParent')
    expect(source).toContain('folder drop to breadcrumb parent')
  })
})

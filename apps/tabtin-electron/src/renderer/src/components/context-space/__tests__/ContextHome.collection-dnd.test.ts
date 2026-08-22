/**
 * ContextHome 资源→文件夹 DnD 契约（ 残留）
 *
 * CloudResourcesHome 已接 useCollectionDnD；ContextHome（文档/表格 apphome）
 * 曾只写聊天拖拽 payload，导致资源无法拖进文件夹。本测试锁定接线，防止回退。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const contextHomeSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/ContextHome.tsx'),
  'utf8',
)

describe('ContextHome collection DnD wiring ', () => {
  it('reuses useCollectionDnD and writes collection MIME on resource dragStart', () => {
    expect(contextHomeSource).toContain('useCollectionDnD')
    expect(contextHomeSource).toContain('COLLECTION_ITEM_MIME')
    expect(contextHomeSource).toContain('buildCollectionDragItem')
    expect(contextHomeSource).toContain("effectAllowed = 'copyMove'")
  })

  it('routes folder and breadcrumb drops through moveItems path', () => {
    expect(contextHomeSource).toContain('handleDropOnCollection')
    expect(contextHomeSource).toContain('handleDropOnUncategorized')
    expect(contextHomeSource).toContain('handleResourceDropTarget')
    expect(contextHomeSource).toContain('onItemDragEnd={handleResourceDragEnd}')
    expect(contextHomeSource).toContain('isFolderDropActive')
    expect(contextHomeSource).toContain('onItemDrop=')
    expect(contextHomeSource).toContain('isItemDropActive')
  })

  it('routes folder drops on breadcrumb through parent_id move', () => {
    expect(contextHomeSource).toContain('handleBreadcrumbDragOver')
    expect(contextHomeSource).toContain('handleBreadcrumbDrop')
    expect(contextHomeSource).toContain('handleFolderDropToParent')
    expect(contextHomeSource).toContain('handleFolderDragOverParent')
  })

  it('keeps chat drag payload while enabling collection moves', () => {
    expect(contextHomeSource).toContain('writeChatContextDragPayload')
    expect(contextHomeSource).toContain('buildSpaceItemChatContextDragPayload')
    expect(contextHomeSource).toContain('isMovableContextItemId')
  })

  it('uses the compact drag preview on the actual TabDoc/TabData resource drag path ', () => {
    expect(contextHomeSource).toContain("import { setResourceDragPreview } from './hooks/resourceDragPreview'")
    expect(contextHomeSource).toContain('setResourceDragPreview(event.dataTransfer, {')
    expect(contextHomeSource).toContain('resolveCloudResourceEmoji(')
  })

  it('does not leave resource drag as copy-only chat payload', () => {
    expect(contextHomeSource).not.toMatch(/effectAllowed\s*=\s*'copy'\s*$/m)
  })

  it('keeps Windows drag alive by using ref-only drag payload (no setState in dragStart)', () => {
    expect(contextHomeSource).toContain('activeDragItemRef')
    expect(contextHomeSource).toContain('activeDragItemRef.current = dragItem')
    expect(contextHomeSource).not.toMatch(/setActiveDragItem\s*\(\s*dragItem\s*\)/)
    expect(contextHomeSource).toContain('isCrossSpace:')
  })

  it('allows organization-scope cross-space moves ', () => {
    expect(contextHomeSource).toContain(
      "allowOrganizationCrossSpaceMove: effectiveResourceScope === 'organization'",
    )
  })
})

describe('ContextHome TabData/TabDoc hide workspace scope toggle', () => {
  it('locks organization scope on tabdata/tabdoc app home and hides the toggle', () => {
    expect(contextHomeSource).toContain("forcedAssetTab === 'tabdata' || forcedAssetTab === 'tabdoc'")
    expect(contextHomeSource).toContain('lockOrganizationScopeAppHome')
    expect(contextHomeSource).toContain('!lockOrganizationScopeAppHome')
    expect(contextHomeSource).toMatch(
      /lockOrganizationScopeAppHome\s*\n?\s*\?\s*'organization'/,
    )
  })
})

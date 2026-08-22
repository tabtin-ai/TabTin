/**
 * CloudResourcesHome 资源→文件夹 DnD 契约（ Windows 回归）
 *
 * 线上诊断包（0.0.4 / d6e87b493）显示云盘页无 CollectionDnD drop 日志。
 * Windows/Chromium 上 dragStart 同步 setState 会打断原生拖拽，导致 ref MIME
 * 兜底失效。本测试锁定 ref-only + 诊断日志 + 跨 Space 标记。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const cloudResourcesSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/registry/homeSections/cloudResources.tsx'),
  'utf8',
)

describe('CloudResourcesHome collection DnD wiring ( Windows)', () => {
  it('reuses useCollectionDnD and writes collection MIME on resource dragStart', () => {
    expect(cloudResourcesSource).toContain('useCollectionDnD')
    expect(cloudResourcesSource).toContain('COLLECTION_ITEM_MIME')
    expect(cloudResourcesSource).toContain('buildCollectionDragItem')
    expect(cloudResourcesSource).toContain("effectAllowed = 'copyMove'")
  })

  it('keeps Windows drag alive by using ref-only drag payload (no setState in dragStart)', () => {
    expect(cloudResourcesSource).toContain('activeDragItemRef')
    expect(cloudResourcesSource).toContain('activeDragItemRef.current = dragItem')
    expect(cloudResourcesSource).not.toMatch(/setActiveDragItem\s*\(/)
    expect(cloudResourcesSource).not.toMatch(/useState<\s*CollectionDragItem/)
  })

  it('logs dragStart/dragEnd and marks cross-space org items', () => {
    expect(cloudResourcesSource).toContain("createLogger('CloudResourcesDnD')")
    expect(cloudResourcesSource).toContain("log.info('dragStart'")
    expect(cloudResourcesSource).toContain("log.info('dragEnd'")
    expect(cloudResourcesSource).toContain('isCrossSpace:')
  })

  it('allows same-workteam cross-space moves in cloud drive ', () => {
    expect(cloudResourcesSource).toContain('allowOrganizationCrossSpaceMove: true')
  })

  it('uses the shared compact card for the cloud drive drag preview ', () => {
    expect(cloudResourcesSource).toContain(
      "import { setResourceDragPreview } from '../../hooks/resourceDragPreview'",
    )
    expect(cloudResourcesSource).toContain('setResourceDragPreview(e.dataTransfer, {')
    expect(cloudResourcesSource).toContain('resolveCloudResourceEmoji(')
  })

  it('logs canDrag=false blind spots and heals empty-id optimistic items', () => {
    expect(cloudResourcesSource).toContain('logResourceDragBlocked')
    expect(cloudResourcesSource).toContain('healUnsyncedContextItems')
    expect(cloudResourcesSource).toContain('isFolderDragActive()')
  })

  it('accepts folder drops on breadcrumb ancestors / root', () => {
    expect(cloudResourcesSource).toContain('handleBreadcrumbDragOver')
    expect(cloudResourcesSource).toContain('handleBreadcrumbDrop')
    expect(cloudResourcesSource).toContain('handleFolderDropToParent')
    expect(cloudResourcesSource).toContain('handleFolderDragOverParent')
    expect(cloudResourcesSource).toContain("force: true")
  })
})

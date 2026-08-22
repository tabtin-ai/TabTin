/**
 * 本地文件树 DnD 契约（对齐云盘  Windows 根因）
 *
 * dragStart 同步 setState 会在 Windows/Chromium 上取消原生 HTML5 拖拽。
 * 本测试锁定：路径走 ref、dragStart 不同步 setDraggingPath、有诊断日志。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/shared/file-ops/useFileTreeDragDrop.ts'),
  'utf8',
)

describe('useFileTreeDragDrop Windows DnD contract', () => {
  it('keeps drag alive with ref-only path payload (no sync setState in dragStart)', () => {
    expect(source).toContain('draggingPathRef')
    expect(source).toContain('draggingPathRef.current = node.path')
    // 同步路径：写 ref / setData 之后才允许 rAF 里更新视觉态
    const dragStartBody = source.slice(
      source.indexOf('const onDragStart = useCallback'),
      source.indexOf('const onDragEnd = useCallback'),
    )
    const beforeRaf = dragStartBody.slice(0, dragStartBody.indexOf('requestAnimationFrame'))
    expect(beforeRaf).not.toMatch(/setDraggingPath\s*\(/)
    expect(dragStartBody).toContain('requestAnimationFrame')
    expect(dragStartBody).toMatch(/requestAnimationFrame[\s\S]*setDraggingPath\s*\(\s*node\.path\s*\)/)
  })

  it('falls back to ref when text/plain is omitted on drop', () => {
    expect(source).toContain("draggingPathRef.current || e.dataTransfer.getData('text/plain')")
  })

  it('logs dragStart, dragEnd and drop for diagnostics', () => {
    expect(source).toContain("createLogger('FileTreeDnD')")
    expect(source).toContain("log.info('dragStart'")
    expect(source).toContain("log.info('dragEnd'")
    expect(source).toContain("log.info('drop on directory'")
  })
})

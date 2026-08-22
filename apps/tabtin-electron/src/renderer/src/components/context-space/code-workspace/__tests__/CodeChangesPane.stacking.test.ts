import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 列 stacking 用源码字面量锁定（对齐 ShellResizableSplits 测法）：
 * 左栏 z-0 isolate，右栏 z-sticky isolate，避免 sticky Diff 头压过文件树。
 */
describe('CodeChangesPane column stacking', () => {
  const source = readFileSync(
    resolve(__dirname, '../CodeChangesPane.tsx'),
    'utf8',
  )

  it('当前变更左右栏建立独立 stacking context', () => {
    expect(source).toContain('changes-diff-column')
    expect(source).toContain(
      'relative z-0 isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    )
    expect(source).toContain('data-testid="changes-file-tree-panel"')
    expect(source).toContain(
      'relative z-sticky isolate flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/[0.04]',
    )
    expect(source).toContain('data-testid="changes-tree-resize-handle"')
    expect(source).toContain('group relative z-sticky flex w-2 shrink-0 cursor-col-resize')
  })

  it('Agent 视图复用当前变更双栏 stacking，不再堆逐 hunk 卡片', () => {
    expect(source).toContain('changes-agent-ops')
    expect(source).toContain('changes-diff-column')
    expect(source).toContain('readOnly={showAgentReview}')
    expect(source).not.toContain('changes-agent-hunk')
    expect(source).not.toContain('changes-agent-file-list')
  })

  it('提交历史双栏使用同一 stacking 契约', () => {
    expect(source).toContain('data-testid="history-diff-column"')
    expect(source).toContain('data-testid="commit-history-aside"')
    expect(source).toContain(
      'relative z-0 isolate flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    )
    expect(source).toContain(
      'relative z-sticky isolate flex min-h-0 shrink-0 flex-col overflow-hidden bg-muted/[0.04]',
    )
  })
})

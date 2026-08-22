import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const editorCss = readFileSync(resolve(process.cwd(), 'src/editor/prosemirror.css'), 'utf8')

function commentDecorationCss(): string {
  const start = editorCss.indexOf('.ProseMirror .tabdoc-comment-highlight')
  const end = editorCss.indexOf('.ProseMirror .tabdoc-comment-block-badge', start)
  return editorCss.slice(start, end)
}

describe('comment decoration theme', () => {
  it('评论下划线和激活背景使用当前主题主色', () => {
    const css = commentDecorationCss()

    expect(css).toContain('hsl(var(--primary)')
    expect(css).not.toContain('hsl(var(--warning)')
  })
})

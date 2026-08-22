import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

async function readSource() {
  return readFile(resolve(__dirname, '../MarkdownRenderer.tsx'), 'utf8')
}

describe('MarkdownRenderer preview intercept', () => {
  it('routes Markdown https xlsx links to tryOpenPreviewableDirectUrl before tabweb', async () => {
    const source = await readSource()
    expect(source).toContain('tryOpenPreviewableDirectUrl')
    const onClickStart = source.indexOf('const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {')
    const onClickEnd = source.indexOf('const onContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {')
    const onClick = source.slice(onClickStart, onClickEnd)
    expect(onClick).toContain('if (!isExternalShortcut && tryOpenPreviewableDirectUrl(href))')
    expect(onClick.indexOf('tryOpenPreviewableDirectUrl(href)')).toBeLessThan(
      onClick.indexOf('resourceRouter'),
    )
  })
})

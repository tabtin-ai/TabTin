import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const panePath = path.resolve(__dirname, '../SharedSessionFilePreviewPane.tsx')

/**
 * ：共享会话文件预览挂在 absolute inset-0 上时，根节点若只有 flex-1
 * 而无 h-full，子级 overflow 滚轮容器拿不到有界高度。
 */
describe('SharedSessionFilePreviewPane layout source ', () => {
  it('pins a bounded height chain for binary/PDF preview hosts', async () => {
    const source = await readFile(panePath, 'utf8')

    expect(source).toContain(
      'flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden',
    )
    expect(source).toContain('data-testid="shared-session-file-preview-pane"')

    // text inline / PDF signed_url / Office binary 三处宿主都必须有界高度
    const boundedHostMatches = source.match(
      /className="flex min-h-0 flex-1 flex-col overflow-hidden"/g,
    )
    expect(boundedHostMatches?.length).toBe(3)
  })
})

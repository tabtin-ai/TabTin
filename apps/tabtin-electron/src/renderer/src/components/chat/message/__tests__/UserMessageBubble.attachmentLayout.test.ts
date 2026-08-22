import { describe, expect, it } from 'vitest'

describe('UserMessageBubble attachment layout', () => {
  it('混合图片和文件时附件行不拉伸普通文件卡', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/UserMessageBubble.tsx'),
      'utf-8',
    )

    const attachmentSection = content.slice(
      content.indexOf('{hasAttachments && ('),
      content.indexOf('{conversationReferenceParsed && ('),
    )

    expect(attachmentSection).toContain('flex flex-wrap items-start gap-2')
    expect(attachmentSection).not.toContain('flex flex-wrap gap-2')
  })

  it('外来历史用户气泡走 MarkdownRenderer', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/UserMessageBubble.tsx'),
      'utf-8',
    )
    expect(content).toContain('isExternalArchive')
    expect(content).toContain('MarkdownRenderer')
  })
})

describe('deriveUserBubbleModel external archive gate', () => {
  it('外来历史禁止 canEdit', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../../../../stores/chat/presentation/messageBubble/deriveUserBubbleModel.ts'),
      'utf-8',
    )
    expect(content).toContain('external_archive')
    expect(content).toMatch(/isExternalArchive[\s\S]*canEdit = !isExternalArchive/)
  })
})

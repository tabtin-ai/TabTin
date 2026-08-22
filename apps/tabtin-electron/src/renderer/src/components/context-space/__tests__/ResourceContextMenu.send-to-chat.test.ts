/**
 * 云盘右键「发送到对话」：走 Agent 对话投递，除文件夹外均可发送
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/context-space/ResourceContextMenu.tsx'),
  'utf8',
)
const zhContext = JSON.parse(readFileSync(
  join(process.cwd(), 'src/renderer/src/i18n/locales/zh-CN/context.json'),
  'utf8',
))
const enContext = JSON.parse(readFileSync(
  join(process.cwd(), 'src/renderer/src/i18n/locales/en-US/context.json'),
  'utf8',
))

describe('ResourceContextMenu send-to-chat contract', () => {
  it('routes send-to-chat via deliverContextInjectToChat for non-folder items', () => {
    expect(source).toContain("t('home.sendToChat'")
    expect(source).toContain('canSendToChat')
    expect(source).toContain('!isLocal && !isFolder')
    expect(source).toContain('buildSpaceItemChatContextDragPayload')
    expect(source).toContain('deliverContextInjectToChat')
    expect(source).not.toContain('ConversationPickerDialog')
    expect(source).not.toContain('shareResourceToConversation')
    expect(source).not.toContain("item?.item_type === 'tabdata' || item?.item_type === 'tabdoc'")
    expect(source).not.toContain("defaultValue: '分享到私信'")
  })

  it('defines send-to-chat copy in context locales', () => {
    expect(zhContext.home.sendToChat).toBe('发送到对话')
    expect(zhContext.home.sendToChatSupportedTypesHint).toContain('文件夹')
    expect(enContext.home.sendToChat).toBeTruthy()
    expect(enContext.home.sendToChatSupportedTypesHint).toMatch(/folder/i)
  })
})

/**
 * 资源右键「发送到私信」：与「发送到对话」并列，走 SendToIMDialog
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

describe('ResourceContextMenu send-to-im contract', () => {
  it('opens SendToIMDialog without replacing send-to-chat', () => {
    expect(source).toContain("t('home.sendToIM'")
    expect(source).toContain('canSendResourceToIM')
    expect(source).toContain('canSendToIM')
    expect(source).toContain('SendToIMDialog')
    expect(source).toContain('handleSendToIM')
    expect(source).toContain("t('home.sendToChat'")
    expect(source).toContain('deliverContextInjectToChat')
    expect(source).not.toContain('ConversationPickerDialog')
  })

  it('defines send-to-im copy in context locales', () => {
    expect(zhContext.home.sendToIM).toBe('发送到私信')
    expect(enContext.home.sendToIM).toBeTruthy()
  })
})

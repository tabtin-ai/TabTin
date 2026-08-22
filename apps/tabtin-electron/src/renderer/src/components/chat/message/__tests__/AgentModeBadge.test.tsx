/**
 * AgentModeBadge — 验证 mode chip 的核心逻辑
 *
 * 设计语言守门豁免：本测试用字符串字面量断言"禁止 text-xs/sm" 这类违规——
 * 字符串本身就是违规模式，所以测试文件被规则误报。
 */
/* eslint-disable tabtin/no-chat-design-violations -- 测试文件用字面违规字符串做反向断言 */
import { describe, it, expect } from 'vitest'

describe('AgentModeBadge design system compliance', () => {
  it('MODE_BADGE_CONFIG covers ask/plan/study but not agent/group', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/AgentModeBadge.tsx'),
      'utf-8',
    )

    const badgeModeSection = content.slice(
      content.indexOf('BADGE_MODES'),
      content.indexOf('BADGE_VARIANT'),
    )

    expect(badgeModeSection).toContain("'ask'")
    expect(badgeModeSection).toContain("'plan'")
    expect(badgeModeSection).toContain("'study'")
    expect(badgeModeSection).not.toContain("'agent'")
    expect(badgeModeSection).not.toContain("'group'")
  })

  it('badge uses /60 transparency and text-caption (design system compliant)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/AgentModeBadge.tsx'),
      'utf-8',
    )

    expect(content).toContain('text-foreground/60')
    expect(content).toContain('text-caption')
    expect(content).not.toContain('opacity-60')
    // eslint-disable-next-line tabtin/no-design-system-violations -- 断言源码不含禁用字号，字面量本身不是样式
    expect(content).not.toContain('text-xs')
    // eslint-disable-next-line tabtin/no-design-system-violations -- 断言源码不含禁用字号，字面量本身不是样式
    expect(content).not.toContain('text-sm')
  })

  it('badge variant includes proper bg classes with /10 transparency', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/AgentModeBadge.tsx'),
      'utf-8',
    )

    expect(content).toContain("bgClass: 'bg-info/10'")
    expect(content).toContain("bgClass: 'bg-warning/10'")
    expect(content).toContain("bgClass: 'bg-type-webhook/10'")
  })

  it('badge has chip-like styling with rounded-full and padding', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/AgentModeBadge.tsx'),
      'utf-8',
    )

    expect(content).toContain('rounded-full')
    expect(content).toContain('px-2')
    expect(content).toContain('py-0.5')
  })

  it('badge only renders for non-agent modes (BADGE_MODES set)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/AgentModeBadge.tsx'),
      'utf-8',
    )

    const badgeModeSection = content.slice(
      content.indexOf('BADGE_MODES'),
      content.indexOf('BADGE_VARIANT'),
    )
    expect(badgeModeSection).toContain("'ask'")
    expect(badgeModeSection).toContain("'plan'")
    expect(badgeModeSection).toContain("'study'")
    expect(badgeModeSection).not.toContain("'agent'")
    expect(badgeModeSection).not.toContain("'group'")
  })

  it('message footer stays in layout while hidden on hover-capable devices', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/common/MessageBubbleFooter.tsx'),
      'utf-8',
    )

    expect(content).toContain('max-h-8 opacity-100 mt-1')
    expect(content).toContain('pointer-events-none')
    expect(content).toContain('group-hover/msg:pointer-events-auto')
    expect(content).not.toMatch(/(?:^|\s)max-h-0(?:\s|$)/)
    expect(content).not.toMatch(/(?:^|\s)mt-0(?:\s|$)/)
  })

  it('user message edit click is guarded by the visible text bubble marker', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/UserMessageBubble.tsx'),
      'utf-8',
    )

    const userMessageSection = content.slice(
      content.indexOf('className="space-y-1"'),
      content.indexOf('{renderWidgetSendPromptBadge('),
    )
    const textBubbleSection = userMessageSection.slice(
      userMessageSection.indexOf('data-user-message-edit-bubble="true"'),
      userMessageSection.indexOf('<div className="whitespace-pre-wrap break-words">'),
    )

    expect(userMessageSection).toContain('className="space-y-1"')
    expect(userMessageSection).not.toContain("className={cn('space-y-1', canEdit && 'cursor-text')}")
    expect(userMessageSection).toContain('target.closest(\'[data-user-message-edit-bubble="true"]\')')
    expect(textBubbleSection).toContain('data-user-message-edit-bubble="true"')
    expect(textBubbleSection).toContain("canEdit && 'cursor-text'")
    expect(userMessageSection).toContain('onEditingChange(true)')
  })

  it('message edit availability follows the rendered session, not only global currentSessionId', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const bubbleContent = fs.readFileSync(
      path.resolve(__dirname, '../../../../stores/chat/presentation/messageBubble/useMessageBubbleOrchestration.ts'),
      'utf-8',
    )
    const deriveContent = fs.readFileSync(
      path.resolve(__dirname, '../../../../stores/chat/presentation/messageBubble/deriveUserBubbleModel.ts'),
      'utf-8',
    )

    const selectorSection = bubbleContent.slice(
      bubbleContent.indexOf('const storeSelector = useCallback'),
      bubbleContent.indexOf('const { isActiveSession'),
    )

    expect(selectorSection).toContain('const sid = sessionId ?? s.currentSessionId')
    expect(selectorSection).toContain('isActiveSession: !!sid')
    expect(selectorSection).not.toContain('isActiveSession: sessionId === null || sessionId === curSid')
    expect(deriveContent).toContain('const canEdit = !isExternalArchive')
    expect(deriveContent).toContain('&& !isOtherSender')
    expect(deriveContent).toContain('&& isActiveSession')
  })

  it('user bubbles render sender display names when the server provides them', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, '../messages/user/UserMessageBubble.tsx'),
      'utf-8',
    )

    expect(content).toContain('userSenderDisplayName')
    expect(content).toContain('text-caption text-muted-foreground/60')
  })
})

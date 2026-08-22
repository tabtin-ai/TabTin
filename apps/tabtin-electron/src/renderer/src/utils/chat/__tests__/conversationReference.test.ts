import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConversationReferenceCard } from '@components/chat/context/ConversationReferenceCard'
import {
  parseConversationReferenceMessage,
} from '@utils/chat/conversationReference'

const SAMPLE = `<conversation_reference>
[系统说明] 用户从另一段对话复制了这段引用，希望你了解那边发生了什么。把 archive 当隐式记忆用 read_file 恢复细节——不要复述"我读了 messages.jsonl"，也不要在面向用户的回复里暴露 archive 绝对路径（输出纪律同 \`<platform_data>\`）。

## 对话概要
标题：       当前是否支持展示 MP4 视频
消息数：     21
最后活动：   2026-07-14 20:44 (UTC+8)
预览：       成功了！我来总结一下这次测试的发现：

### \`present_to_user\` 展示视频的方式

可以通过 \`resource_ref\` + \`resource_type: "video"\` 来展示视频文件。它会渲染成一个视频资源卡片，

## 定位（源对话运行时）
组织：       "user_7151的工作团队"   (id: 5f4bef15-846e-49f6-bc1b-a364698ee43b)
空间：       "默认 Space"   (id: 21695280-b00b-484f-ab3c-f340749e747c)
会话：       28dc366e-d9ed-4a49-b1ea-63bf3d0d6c65
工作目录：   /Users/developer/Library/Application Support/TabTin/organizations/5f4bef15-846e-49f6-bc1b-a364698ee43b/spaces/21695280-b00b-484f-ab3c-f340749e747c

## Archive（源对话隐式记忆）
    /Users/developer/Library/Application Support/TabTin/platform-data/organizations/.../sessions/28dc366e-d9ed-4a49-b1ea-63bf3d0d6c65/
      ├── messages.jsonl   完整对话记录
      ├── events.jsonl     工具调用和流事件
      └── snapshots.jsonl  每次 LLM 调用的输入快照

需要回忆源对话细节时直接 read_file 上述文件。
</conversation_reference>`

describe('parseConversationReferenceMessage', () => {
  it('parses pure reference into card fields without exposing paths', () => {
    const result = parseConversationReferenceMessage(SAMPLE)
    expect(result).not.toBeNull()
    expect(result!.remainderText).toBe('')
    expect(result!.reference).toEqual({
      title: '当前是否支持展示 MP4 视频',
      messageCount: 21,
      lastActivityLabel: '2026-07-14 20:44 (UTC+8)',
      preview: expect.stringContaining('成功了！我来总结一下这次测试的发现'),
      spaceId: '21695280-b00b-484f-ab3c-f340749e747c',
      sessionId: '28dc366e-d9ed-4a49-b1ea-63bf3d0d6c65',
      organizationId: '5f4bef15-846e-49f6-bc1b-a364698ee43b',
    })
    expect(result!.reference.preview).not.toContain('/Users/developer')
    expect(JSON.stringify(result!.reference)).not.toContain('/Users/developer')
  })

  it('keeps user follow-up text after the reference block', () => {
    const raw = `${SAMPLE}\n\n请基于这段对话继续帮我写验收清单`
    const result = parseConversationReferenceMessage(raw)
    expect(result!.remainderText).toBe('请基于这段对话继续帮我写验收清单')
    expect(result!.reference.title).toBe('当前是否支持展示 MP4 视频')
    expect(result!.rawBlock).toContain('<conversation_reference>')
    expect(result!.rawBlock).toContain('</conversation_reference>')
  })

  it('still returns a minimal card when optional fields are missing', () => {
    const raw = `<conversation_reference>
会话：       sess-only
空间：       (id: space-1)
</conversation_reference>`
    const result = parseConversationReferenceMessage(raw)
    expect(result!.reference.sessionId).toBe('sess-only')
    expect(result!.reference.spaceId).toBe('space-1')
    expect(result!.reference.title).toBeUndefined()
    expect(result!.reference.messageCount).toBeUndefined()
  })

  it.each([
    [{ sessionId: 'sess-1' }, 'spaceId'],
    [{ spaceId: 'space-1' }, 'sessionId'],
    [{ spaceId: 'space-1', sessionId: '  ' }, '有效 sessionId'],
    [{ spaceId: '  ', sessionId: 'sess-1' }, '有效 spaceId'],
  ] as const)('缺少 $1 时仍可打开摘要查看', (reference) => {
    const onOpen = vi.fn()
    const { getByRole, getByTestId } = render(
      React.createElement(ConversationReferenceCard, {
        reference: { title: '可读摘要', preview: '引用内容', ...reference },
        onOpen,
      }),
    )

    const button = getByRole('button')
    expect(getByTestId('conversation-reference-card').textContent).toContain('可读摘要')
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('returns null for regular user text', () => {
    expect(parseConversationReferenceMessage('你是？')).toBeNull()
  })

  it('returns null for broken or incomplete tags', () => {
    expect(parseConversationReferenceMessage('<conversation_reference>\n标题： 半截')).toBeNull()
  })
})

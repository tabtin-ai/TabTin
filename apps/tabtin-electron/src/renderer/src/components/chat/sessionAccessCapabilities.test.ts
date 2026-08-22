import { describe, expect, it } from 'vitest'
import {
  OWNER_SESSION_ACCESS_CAPABILITIES,
  resolveSessionAccessCapabilities,
} from './sessionAccessCapabilities'

const sharedBase = {
  isSharedSession: true,
  isOwner: false,
  isGrantee: true,
  shareActive: true,
  denied: false,
  shareCanFork: false,
  shareCanChat: false,
  sessionShareCanChatEnabled: false,
}

describe('resolveSessionAccessCapabilities', () => {
  it('普通会话保留完整消息操作能力', () => {
    expect(resolveSessionAccessCapabilities({
      ...sharedBase,
      isSharedSession: false,
    })).toMatchObject({
      sendMode: 'owner',
      canMutateHistory: true,
      canReply: true,
      canCopy: true,
      canOpenArtifacts: true,
      canChangeModel: true,
    })
  })

  it('共享会话所有者仍使用普通会话能力', () => {
    expect(resolveSessionAccessCapabilities({
      ...sharedBase,
      isOwner: true,
      isGrantee: false,
    })).toBe(OWNER_SESSION_ACCESS_CAPABILITIES)
  })

  it('只读共享只允许复制与查看产物', () => {
    expect(resolveSessionAccessCapabilities(sharedBase)).toEqual({
      sendMode: null,
      canSendSharedChat: false,
      canForkWholeSession: false,
      canMutateHistory: false,
      canReply: false,
      canCopy: true,
      canOpenArtifacts: true,
      canChangeModel: false,
    })
  })

  it('can_fork 只开放整会话复制，不开放逐消息历史操作', () => {
    expect(resolveSessionAccessCapabilities({
      ...sharedBase,
      shareCanFork: true,
    })).toMatchObject({
      canForkWholeSession: true,
      canMutateHistory: false,
      canReply: false,
    })
  })

  it('can_chat 只开放共享发送，现有协议不开放引用回复', () => {
    expect(resolveSessionAccessCapabilities({
      ...sharedBase,
      shareCanChat: true,
      sessionShareCanChatEnabled: true,
    })).toMatchObject({
      sendMode: 'shared-chat',
      canSendSharedChat: true,
      canMutateHistory: false,
      canReply: false,
    })
  })

  it.each([
    { denied: true },
    { shareActive: false },
    { isGrantee: false },
  ])('无权访问时所有共享能力关闭: %o', (override) => {
    expect(resolveSessionAccessCapabilities({ ...sharedBase, ...override })).toEqual({
      sendMode: null,
      canSendSharedChat: false,
      canForkWholeSession: false,
      canMutateHistory: false,
      canReply: false,
      canCopy: false,
      canOpenArtifacts: false,
      canChangeModel: false,
    })
  })
})

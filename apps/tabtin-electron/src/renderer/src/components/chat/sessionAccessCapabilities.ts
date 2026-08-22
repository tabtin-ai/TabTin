export type SessionAccessSendMode = 'owner' | 'shared-chat'

export interface SessionAccessCapabilities {
  sendMode: SessionAccessSendMode | null
  canSendSharedChat: boolean
  canForkWholeSession: boolean
  canMutateHistory: boolean
  canReply: boolean
  canCopy: boolean
  canOpenArtifacts: boolean
  canChangeModel: boolean
}

export interface ResolveSessionAccessCapabilitiesInput {
  isSharedSession: boolean
  isOwner: boolean
  isGrantee: boolean
  shareActive: boolean
  denied: boolean
  shareCanFork: boolean
  shareCanChat: boolean
  sessionShareCanChatEnabled: boolean
}

export const OWNER_SESSION_ACCESS_CAPABILITIES: SessionAccessCapabilities = {
  sendMode: 'owner',
  canSendSharedChat: false,
  canForkWholeSession: false,
  canMutateHistory: true,
  canReply: true,
  canCopy: true,
  canOpenArtifacts: true,
  canChangeModel: true,
}

const NO_SESSION_ACCESS_CAPABILITIES: SessionAccessCapabilities = {
  sendMode: null,
  canSendSharedChat: false,
  canForkWholeSession: false,
  canMutateHistory: false,
  canReply: false,
  canCopy: false,
  canOpenArtifacts: false,
  canChangeModel: false,
}

/**
 * 会话访问能力的单一来源。Composer、消息操作和资源入口只消费能力，
 * 不再各自解释 SessionShare 字段。
 */
export function resolveSessionAccessCapabilities(
  input: ResolveSessionAccessCapabilitiesInput,
): SessionAccessCapabilities {
  if (!input.isSharedSession || input.isOwner) {
    return OWNER_SESSION_ACCESS_CAPABILITIES
  }
  if (input.denied || !input.shareActive || !input.isGrantee) {
    return NO_SESSION_ACCESS_CAPABILITIES
  }

  const canSendSharedChat = input.sessionShareCanChatEnabled && input.shareCanChat
  return {
    sendMode: canSendSharedChat ? 'shared-chat' : null,
    canSendSharedChat,
    canForkWholeSession: input.shareCanFork,
    canMutateHistory: false,
    // sharedChat 当前只接收纯文本，不支持 conversation_reference。
    canReply: false,
    canCopy: true,
    canOpenArtifacts: true,
    canChangeModel: false,
  }
}

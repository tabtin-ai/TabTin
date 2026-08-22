import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatModelStore } from '@/stores/useChatModelStore'

export function useChatActions() {
  return {
    sendMessage: useChatStore(s => s.sendMessage),
    abortStream: useChatStore(s => s.abortStream),
    abortStreamForUserEdit: useChatStore(s => s.abortStreamForUserEdit),
    abortStreamFromComposer: useChatStore(s => s.abortStreamFromComposer),
    syncContext: useChatStore(s => s.syncContext),
    createSession: useChatStore(s => s.createSession),
    ensureSessionForSpace: useChatStore(s => s.ensureSessionForSpace),
    startDraftSessionForSpace: useChatStore(s => s.startDraftSessionForSpace),
    loadSessions: useChatStore(s => s.loadSessions),
    selectSession: useChatStore(s => s.selectSession),
    deleteSession: useChatStore(s => s.deleteSession),
    renameSession: useChatStore(s => s.renameSession),
    forkSession: useChatStore(s => s.forkSession),
    loadModels: useChatModelStore(s => s.loadModels),
    switchModel: useChatModelStore(s => s.switchModel),
    switchContextTier: useChatModelStore(s => s.switchContextTier),
    setModelParamOverride: useChatModelStore(s => s.setModelParamOverride),
    getCurrentModel: useChatModelStore(s => s.getCurrentModel),
    loadMoreMessages: useChatStore(s => s.loadMoreMessages),
    submitApprovalDecisions: useChatStore(s => s.submitApprovalDecisions),
    submitAskUserAnswer: useChatStore(s => s.submitAskUserAnswer),
    submitAskUserText: useChatStore(s => s.submitAskUserText),
    submitAskUserFieldValues: useChatStore(s => s.submitAskUserFieldValues),
    submitAskUserApproval: useChatStore(s => s.submitAskUserApproval),
    skipAskUser: useChatStore(s => s.skipAskUser),
    dismissApprovalForSession: useChatStore(s => s.dismissApprovalForSession),
  }
}

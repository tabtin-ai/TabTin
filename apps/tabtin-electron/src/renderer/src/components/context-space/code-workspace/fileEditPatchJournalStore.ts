import { create } from 'zustand'
import type { EditorTurnJournalRecord } from './agentTurnEditorOps'

interface FileEditPatchJournalState {
  byThread: Record<string, EditorTurnJournalRecord[]>
  load: (threadId: string) => Promise<void>
}

export const useFileEditPatchJournalStore = create<FileEditPatchJournalState>((set, get) => ({
  byThread: {},
  load: async (threadId: string) => {
    const id = threadId.trim()
    if (!id) return
    const api = window.tabtin?.fileEditPatches
    if (!api) return
    try {
      const result = await api.list(id)
      if (!result.success) return
      const current = get().byThread[id]
      if (
        current
        && current.length === result.records.length
        && current.every((item, index) => item.toolUseId === result.records[index]?.toolUseId)
      ) {
        return
      }
      set({
        byThread: {
          ...get().byThread,
          [id]: result.records,
        },
      })
    } catch {
      // 账本缺失时 Agent 视图仍可从 edit_file tool_result 降级。
    }
  },
}))

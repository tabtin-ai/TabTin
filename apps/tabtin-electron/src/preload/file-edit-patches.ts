import { ipcRenderer } from 'electron'
import type { FileEditPatch } from '@tabtin/agent-host/tools'

export interface FileEditPatchRecord {
  toolUseId: string
  recordedAt: string
  codeRootPath?: string
  patch: FileEditPatch
}

export interface FileEditPatchesApi {
  list: (
    threadId: string,
  ) => Promise<
    | { success: true; records: FileEditPatchRecord[] }
    | { success: false; error: string; records: [] }
  >
  record: (
    threadId: string,
    toolUseId: string,
    patch: FileEditPatch,
  ) => Promise<{ success: true } | { success: false; error: string }>
}

export function createFileEditPatchesApi(): FileEditPatchesApi {
  return {
    list: (threadId: string) =>
      ipcRenderer.invoke('file-edit-patches:list', threadId),
    record: (threadId: string, toolUseId: string, patch: FileEditPatch) =>
      ipcRenderer.invoke('file-edit-patches:record', threadId, toolUseId, patch),
  }
}

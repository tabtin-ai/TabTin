type ActionResultLogPayload = {
  threadId?: string
  taskId?: string
  traceId?: string | null
  success?: boolean
  resultKeys?: string[]
}

export function logActionResultToMain(payload: ActionResultLogPayload): void {
  const ipc = window.electron?.ipcRenderer
  if (!ipc?.send) return
  ipc.send('agent:log-action-result', payload)
}

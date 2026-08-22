type DownloadToastSilenceState = {
  pendingNames: Map<string, string[]>
  pendingTimers: Map<string, ReturnType<typeof setTimeout>>
  silentIds: Set<string>
}

type DownloadToastItem = {
  id: string
  name: string
}

const SILENT_DOWNLOAD_TTL_MS = 30_000

function getDownloadToastSilenceState(): DownloadToastSilenceState {
  const globalState = globalThis as typeof globalThis & {
    __tabtinDownloadToastSilence?: DownloadToastSilenceState
  }
  globalState.__tabtinDownloadToastSilence ??= {
    pendingNames: new Map<string, string[]>(),
    pendingTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    silentIds: new Set<string>(),
  }
  return globalState.__tabtinDownloadToastSilence
}

function releasePendingNameToken(name: string, token: string): void {
  const state = getDownloadToastSilenceState()
  const tokens = state.pendingNames.get(name)
  if (!tokens) return

  const nextTokens = tokens.filter((item) => item !== token)
  if (nextTokens.length > 0) {
    state.pendingNames.set(name, nextTokens)
  } else {
    state.pendingNames.delete(name)
  }
  const timer = state.pendingTimers.get(token)
  if (timer) {
    clearTimeout(timer)
    state.pendingTimers.delete(token)
  }
}

export function markNextDownloadToastSilent(name: string): void {
  const state = getDownloadToastSilenceState()
  const token = `${Date.now()}-${Math.random()}`
  const tokens = state.pendingNames.get(name) ?? []
  state.pendingNames.set(name, [...tokens, token])
  const timer = setTimeout(() => {
    releasePendingNameToken(name, token)
  }, SILENT_DOWNLOAD_TTL_MS)
  state.pendingTimers.set(token, timer)
}

export function shouldSilenceDownloadStartToast(info: DownloadToastItem): boolean {
  const state = getDownloadToastSilenceState()
  const tokens = state.pendingNames.get(info.name)
  const token = tokens?.[0]
  if (!token) return false

  releasePendingNameToken(info.name, token)
  state.silentIds.add(info.id)
  return true
}

export function shouldSilenceDownloadCompletionToast(info: Pick<DownloadToastItem, 'id'>): boolean {
  const state = getDownloadToastSilenceState()
  if (!state.silentIds.has(info.id)) return false
  state.silentIds.delete(info.id)
  return true
}

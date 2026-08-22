import { create } from 'zustand'

export type AgentContextSwitchKind = 'organization' | 'logout'

export interface BusyAgentSessionSummary {
  sessionId: string
  title: string
  queuedCount: number
}

interface AgentContextSwitchConfirmState {
  open: boolean
  kind: AgentContextSwitchKind
  sessions: BusyAgentSessionSummary[]
  isStopping: boolean
  error: string | null
  stop: (() => Promise<boolean>) | null
}

const initialState: Omit<AgentContextSwitchConfirmState, 'stop'> = {
  open: false,
  kind: 'organization',
  sessions: [],
  isStopping: false,
  error: null,
}

export const useAgentContextSwitchConfirmStore = create<AgentContextSwitchConfirmState>(() => ({
  ...initialState,
  stop: null,
}))

let pendingResolve: ((proceed: boolean) => void) | null = null

export function requestAgentContextSwitchConfirm(input: {
  kind: AgentContextSwitchKind
  sessions: BusyAgentSessionSummary[]
  stop: () => Promise<boolean>
}): Promise<boolean> {
  if (pendingResolve) return Promise.resolve(false)

  return new Promise((resolve) => {
    pendingResolve = resolve
    useAgentContextSwitchConfirmStore.setState({
      open: true,
      kind: input.kind,
      sessions: input.sessions,
      isStopping: false,
      error: null,
      stop: input.stop,
    })
  })
}

export function cancelAgentContextSwitchConfirm(): void {
  settleAgentContextSwitchConfirm(false)
}

export async function confirmAgentContextSwitch(): Promise<void> {
  const { stop } = useAgentContextSwitchConfirmStore.getState()
  if (!stop) return

  useAgentContextSwitchConfirmStore.setState({ isStopping: true, error: null })
  try {
    if (await stop()) {
      settleAgentContextSwitchConfirm(true)
      return
    }
    useAgentContextSwitchConfirmStore.setState({
      isStopping: false,
      error: '任务尚未完全停止，请稍后重试。',
    })
  } catch {
    useAgentContextSwitchConfirmStore.setState({
      isStopping: false,
      error: '停止任务失败，请稍后重试。',
    })
  }
}

function settleAgentContextSwitchConfirm(proceed: boolean): void {
  const resolve = pendingResolve
  pendingResolve = null
  useAgentContextSwitchConfirmStore.setState({
    ...initialState,
    stop: null,
  })
  resolve?.(proceed)
}

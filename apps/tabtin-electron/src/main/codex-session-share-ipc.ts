import { okResponse } from '@tabtin/agent-wire'
import { guardedHandle } from './utils/guarded-handle'
import {
  importCodexSessionFile,
  listCodexLocalProjects,
  openCodexSession,
  readCodexSessionForShare,
} from './codex-session-share'

export const CODEX_SESSION_SHARE_IPC_CHANNELS = [
  'codex-session-share:read',
  'codex-session-share:projects',
  'codex-session-share:import',
  'codex-session-share:open',
] as const

export function registerCodexSessionShareIpc(): void {
  guardedHandle('codex-session-share:read', async (_event, sessionId: string) => (
    okResponse(await readCodexSessionForShare(sessionId))
  ))
  guardedHandle('codex-session-share:projects', async () => (
    okResponse(await listCodexLocalProjects())
  ))
  guardedHandle(
    'codex-session-share:import',
    async (_event, input: {
      filePath: string
      projectId: string
      projectPath: string
      expectedSessionId?: string
      expectedSessionName?: string
    }) => (
      okResponse(await importCodexSessionFile(input))
    ),
  )
  guardedHandle('codex-session-share:open', async (
    _event,
    sessionId: string,
    projectId: string,
    projectPath: string,
  ) => {
    await openCodexSession(sessionId, projectPath, projectId)
    return okResponse({ opened: true })
  })
}

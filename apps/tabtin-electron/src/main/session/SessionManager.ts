import { createLogger } from '../logger'

const log = createLogger('SessionManager')

export type SessionMode = 'chat'

export interface SessionTrace {
  traceId: string
  runId: string
  status: 'running' | 'completed' | 'error'
  startedAt: number
  endedAt: number | null
  error?: string
}

export interface SessionContext {
  sessionId: string
  name: string
  mode: SessionMode
  threadIdGeneratedBy: 'frontend' | 'backend'
  currentTraceId: string | null
  traces: SessionTrace[]
  sseStatus: 'disconnected' | 'connecting' | 'connected' | 'error'
  createdAt: number
  updatedAt: number
}

class SessionManager {
  private sessions = new Map<string, SessionContext>()

  createSession(config: {
    sessionId: string
    name: string
    mode: SessionMode
    threadIdGeneratedBy: 'frontend' | 'backend'
  }): SessionContext {
    const existing = this.sessions.get(config.sessionId)
    if (existing) return existing

    const now = Date.now()
    const session: SessionContext = {
      sessionId: config.sessionId,
      name: config.name,
      mode: config.mode,
      threadIdGeneratedBy: config.threadIdGeneratedBy,
      currentTraceId: null,
      traces: [],
      sseStatus: 'disconnected',
      createdAt: now,
      updatedAt: now
    }

    this.sessions.set(config.sessionId, session)
    log.info('Session 已创建', { sessionId: config.sessionId, mode: config.mode })
    return session
  }

  getSession(sessionId: string): SessionContext | null {
    return this.sessions.get(sessionId) || null
  }

  setCurrentTrace(sessionId: string, traceId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.currentTraceId = traceId
    session.updatedAt = Date.now()
  }

  addTrace(sessionId: string, trace: SessionTrace): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.traces.push(trace)
    session.currentTraceId = trace.traceId
    session.updatedAt = Date.now()
  }

  updateTraceStatus(
    sessionId: string,
    traceId: string,
    status: 'running' | 'completed' | 'error',
    error?: string
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const trace = session.traces.find(item => item.traceId === traceId)
    if (!trace) return

    trace.status = status
    if (status !== 'running') {
      trace.endedAt = Date.now()
    }
    if (error) {
      trace.error = error
    }
    session.updatedAt = Date.now()
  }

  listSessions(): SessionContext[] {
    return Array.from(this.sessions.values())
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }
}

let singleton: SessionManager | null = null

export function getSessionManager(): SessionManager {
  if (!singleton) {
    singleton = new SessionManager()
  }
  return singleton
}

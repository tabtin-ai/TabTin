export type AgentInteractionMode = 'interactive' | 'solo' | 'scheduled' | 'batch'

/** Owns auxiliary state whose lifetime is exactly one Agent session. */
export class AgentSessionState<Request extends { sessionId?: unknown }, CredentialResolver> {
  private readonly interactionModes = new Map<string, AgentInteractionMode>()
  private readonly contextTiers = new Map<string, string>()
  private readonly credentialResolvers = new Map<string, CredentialResolver>()
  private readonly pendingTurns = new Map<string, { request: Request }>()

  getInteractionMode(sessionId: string): AgentInteractionMode | undefined {
    return this.interactionModes.get(sessionId)
  }

  setInteractionMode(sessionId: string, mode: AgentInteractionMode): void {
    this.interactionModes.set(sessionId, mode)
  }

  deleteInteractionMode(sessionId: string): void {
    this.interactionModes.delete(sessionId)
  }

  getContextTier(sessionId: string): string | undefined {
    return this.contextTiers.get(sessionId)
  }

  setCredentialResolver(sessionId: string, resolver: CredentialResolver): void {
    this.credentialResolvers.set(sessionId, resolver)
  }

  getCredentialResolver(sessionId: string): CredentialResolver | undefined {
    return this.credentialResolvers.get(sessionId)
  }

  deleteCredentialResolver(sessionId: string): void {
    this.credentialResolvers.delete(sessionId)
  }

  forEachCredentialResolver(visitor: (resolver: CredentialResolver) => void): void {
    this.credentialResolvers.forEach(visitor)
  }

  setPendingTurn(runId: string, request: Request): void {
    this.pendingTurns.set(runId, { request })
  }

  getPendingTurn(runId: string): { request: Request } | undefined {
    return this.pendingTurns.get(runId)
  }

  deletePendingTurn(runId: string): void {
    this.pendingTurns.delete(runId)
  }

  setContextTier(sessionId: string, tierId: string | null | undefined): void {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) return
    const normalizedTierId = tierId?.trim() ?? ''
    if (normalizedTierId) this.contextTiers.set(normalizedSessionId, normalizedTierId)
    else this.contextTiers.delete(normalizedSessionId)
  }

  deleteSession(sessionId: string): void {
    this.interactionModes.delete(sessionId)
    this.contextTiers.delete(sessionId)
    this.credentialResolvers.delete(sessionId)
    for (const [runId, turn] of this.pendingTurns) {
      if (turn.request.sessionId === sessionId) this.pendingTurns.delete(runId)
    }
  }

  clear(): void {
    this.interactionModes.clear()
    this.contextTiers.clear()
    this.credentialResolvers.clear()
    this.pendingTurns.clear()
  }
}

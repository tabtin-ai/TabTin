type SessionClient = {
  sessions: {
    create: (spaceId: string, organizationId: string) => Promise<{ id: string }>
  }
}

const sessionCache = new Map<string, string>()
const inflightSessionCreation = new Map<string, Promise<string>>()

export async function getOrCreateTinsAgentSession(
  client: SessionClient,
  spaceId: string,
  organizationId: string,
): Promise<string> {
  const cached = sessionCache.get(spaceId)
  if (cached) return cached

  const existing = inflightSessionCreation.get(spaceId)
  if (existing) return existing

  const promise = client.sessions
    .create(spaceId, organizationId)
    .then((session) => {
      sessionCache.set(spaceId, session.id)
      return session.id
    })
    .finally(() => {
      inflightSessionCreation.delete(spaceId)
    })

  inflightSessionCreation.set(spaceId, promise)
  return promise
}

export async function rebuildTinsAgentSession(
  client: SessionClient,
  spaceId: string,
  organizationId: string,
): Promise<string> {
  sessionCache.delete(spaceId)
  inflightSessionCreation.delete(spaceId)

  const promise = client.sessions
    .create(spaceId, organizationId)
    .then((session) => {
      sessionCache.set(spaceId, session.id)
      return session.id
    })
    .finally(() => {
      inflightSessionCreation.delete(spaceId)
    })

  inflightSessionCreation.set(spaceId, promise)
  return promise
}

export function clearTinsSessionCache(): void {
  sessionCache.clear()
  inflightSessionCreation.clear()
}

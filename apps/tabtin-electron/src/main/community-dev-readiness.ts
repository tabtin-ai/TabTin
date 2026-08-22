export const COMMUNITY_DEV_READY_MARKER = '[tabtin-community] electron-ready'

interface CommunityDevReadinessOptions {
  env?: Record<string, string | undefined>
  write?: (message: string) => unknown
}

export function reportCommunityDevReady({
  env = process.env,
  write = (message) => process.stdout.write(message),
}: CommunityDevReadinessOptions = {}): boolean {
  if (env.TABTIN_COMMUNITY_DEV_BOOTSTRAP !== '1') return false
  write(`${COMMUNITY_DEV_READY_MARKER}\n`)
  return true
}

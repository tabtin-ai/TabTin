export type CleanupPlatform = 'windows' | 'mac' | 'linux'

export function resolveCleanupPlatform(platform: string): CleanupPlatform {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

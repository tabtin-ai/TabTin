import i18n from '@/i18n'

const MICROPHONE_PERMISSION_KIND = 'microphone'

export type OsPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'not-applicable'

/**
 * 麦克风按钮在 UI 层关心的四态：
 * - granted：已授权，可直接录音
 * - prompt：尚未决定，点击时会触发系统授权弹窗
 * - denied：被拒绝 / 受限，按钮应禁用并提示去系统设置开启
 * - unknown：无法判定（平台不适用或探测失败），放行让实际采集去兜底
 */
export type MicPermissionGateStatus = 'granted' | 'prompt' | 'denied' | 'unknown'

export function mapMicPermissionStatus(status: OsPermissionStatus): MicPermissionGateStatus {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'not-determined':
      return 'prompt'
    case 'denied':
    case 'restricted':
      return 'denied'
    default:
      return 'unknown'
  }
}

interface OsPermissionsIpc {
  check?: (kind: typeof MICROPHONE_PERMISSION_KIND) => Promise<{ status: OsPermissionStatus }>
  request?: (kind: typeof MICROPHONE_PERMISSION_KIND) => Promise<OsPermissionStatus>
}

export type VoiceRecordingErrorKind = 'microphone-permission'

export class MicrophonePermissionError extends Error {
  constructor() {
    super(getMicrophonePermissionMessage())
    this.name = 'MicrophonePermissionError'
  }
}

export function getMicrophonePermissionMessage(): string {
  return i18n.t('chat:voice.micPermission', {
    defaultValue: '麦克风权限被拒绝，请在系统设置中允许使用麦克风。',
  })
}

function getOsPermissions(): OsPermissionsIpc | null {
  if (typeof window === 'undefined') return null
  return (
    window as unknown as {
      tabtin?: { osPermissions?: OsPermissionsIpc }
    }
  ).tabtin?.osPermissions ?? null
}

export async function ensureMicrophonePermission(): Promise<boolean> {
  const osPermissions = getOsPermissions()
  if (!osPermissions?.check) return true

  try {
    const current = await osPermissions.check(MICROPHONE_PERMISSION_KIND)
    if (current.status === 'granted') return true
    if (current.status === 'not-determined' && osPermissions.request) {
      return await osPermissions.request(MICROPHONE_PERMISSION_KIND) === 'granted'
    }
    if (current.status === 'denied' || current.status === 'restricted') return false
    return true
  } catch (err) {
    console.warn('[VoiceRecording] microphone permission preflight failed:', err)
    return true
  }
}

export function isMicrophonePermissionError(err: unknown): boolean {
  if (err instanceof MicrophonePermissionError) return true
  if (!(err instanceof Error)) return false
  return err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError'
}

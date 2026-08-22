import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureMicrophonePermission,
  isMicrophonePermissionError,
  mapMicPermissionStatus,
  MicrophonePermissionError,
} from '../voiceMicrophonePermission'

function setOsPermissions(osPermissions?: {
  check?: (kind: 'microphone') => Promise<{ status: 'granted' | 'denied' | 'restricted' | 'not-determined' }>
  request?: (kind: 'microphone') => Promise<'granted' | 'denied'>
}) {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: osPermissions ? { osPermissions } : undefined,
  })
}

describe('voiceMicrophonePermission', () => {
  afterEach(() => {
    vi.clearAllMocks()
    setOsPermissions(undefined)
  })

  it('allows recording when OS microphone permission is already granted', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'granted' })
    const request = vi.fn()
    setOsPermissions({ check, request })

    await expect(ensureMicrophonePermission()).resolves.toBe(true)

    expect(check).toHaveBeenCalledWith('microphone')
    expect(request).not.toHaveBeenCalled()
  })

  it('requests first-run microphone permission before recording', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'not-determined' })
    const request = vi.fn().mockResolvedValue('granted')
    setOsPermissions({ check, request })

    await expect(ensureMicrophonePermission()).resolves.toBe(true)

    expect(request).toHaveBeenCalledWith('microphone')
  })

  it('blocks recording when OS microphone permission is denied', async () => {
    setOsPermissions({
      check: vi.fn().mockResolvedValue({ status: 'denied' }),
      request: vi.fn(),
    })

    await expect(ensureMicrophonePermission()).resolves.toBe(false)
  })

  it('falls back to getUserMedia when the Electron permission bridge is unavailable', async () => {
    setOsPermissions(undefined)

    await expect(ensureMicrophonePermission()).resolves.toBe(true)
  })

  it('recognizes browser microphone permission errors from getUserMedia', () => {
    const notAllowed = new Error('Permission denied')
    notAllowed.name = 'NotAllowedError'

    expect(isMicrophonePermissionError(notAllowed)).toBe(true)
    expect(isMicrophonePermissionError(new MicrophonePermissionError())).toBe(true)
    expect(isMicrophonePermissionError(new Error('ASR backend failed'))).toBe(false)
  })

  it('maps OS permission status to the mic button gate state', () => {
    expect(mapMicPermissionStatus('granted')).toBe('granted')
    expect(mapMicPermissionStatus('not-determined')).toBe('prompt')
    expect(mapMicPermissionStatus('denied')).toBe('denied')
    expect(mapMicPermissionStatus('restricted')).toBe('denied')
    expect(mapMicPermissionStatus('unknown')).toBe('unknown')
    expect(mapMicPermissionStatus('not-applicable')).toBe('unknown')
  })
})

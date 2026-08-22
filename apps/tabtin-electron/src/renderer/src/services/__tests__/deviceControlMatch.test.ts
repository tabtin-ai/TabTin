import { describe, expect, it } from 'vitest'
import {
  isCurrentDeviceControl,
  isDeviceReachable,
  isSamePhysicalDevice,
  isWorkspaceExecutionSelectable,
} from '../deviceControlMatch'

describe('deviceControlMatch', () => {
  it('isDeviceReachable treats online and busy as reachable', () => {
    expect(isDeviceReachable('online')).toBe(true)
    expect(isDeviceReachable('busy')).toBe(true)
    expect(isDeviceReachable('offline')).toBe(false)
    expect(isDeviceReachable('draining')).toBe(false)
  })

  it('matches by exact device id', () => {
    const device = { id: 'dev-a', fingerprint: 'fp-a', name: 'Mac (darwin)', status: 'online' }
    expect(isSamePhysicalDevice(device, device)).toBe(true)
    expect(isCurrentDeviceControl('dev-a', device, [device])).toBe(true)
  })

  it('matches by fingerprint when ids differ', () => {
    const stale = { id: 'dev-old', fingerprint: 'fp-same', name: 'Host (win32)', status: 'offline' }
    const current = { id: 'dev-new', fingerprint: 'fp-same', name: 'Host (win32)', status: 'online' }
    expect(isSamePhysicalDevice(stale, current)).toBe(true)
    expect(isCurrentDeviceControl('dev-old', current, [stale, current])).toBe(true)
  })

  it('does not match by machine_key when installation identities differ', () => {
    const stale = {
      id: 'dev-old',
      fingerprint: 'fp-old',
      machine_key: 'mk-same',
      name: 'Host (win32)',
      status: 'offline',
    }
    const current = {
      id: 'dev-new',
      fingerprint: 'fp-new',
      machine_key: 'mk-same',
      name: 'Host (win32)',
      status: 'online',
    }
    expect(isSamePhysicalDevice(stale, current)).toBe(false)
    expect(isCurrentDeviceControl('dev-old', current, [stale, current])).toBe(false)
  })

  it('does not treat same hostname as same machine (no silent takeover)', () => {
    const stale = {
      id: 'dev-old',
      fingerprint: 'fp-old',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'offline',
    }
    const current = {
      id: 'dev-new',
      fingerprint: 'fp-new',
      name: 'LAPTOP-FKICRALO (win32)',
      status: 'online',
    }
    expect(isSamePhysicalDevice(stale, current)).toBe(false)
    expect(isCurrentDeviceControl('dev-old', current, [stale, current])).toBe(false)
  })

  it('does not match unrelated devices', () => {
    const bound = { id: 'dev-b', fingerprint: 'fp-b', name: 'Office Mac (darwin)', status: 'online' }
    const current = { id: 'dev-a', fingerprint: 'fp-a', name: 'Home Mac (darwin)', status: 'online' }
    expect(isSamePhysicalDevice(bound, current)).toBe(false)
    expect(isCurrentDeviceControl('dev-b', current, [bound, current])).toBe(false)
  })

  describe('isWorkspaceExecutionSelectable', () => {
    const local = { id: 'dev-local', fingerprint: 'fp-local', status: 'online' }
    const remoteOnline = { id: 'dev-remote', fingerprint: 'fp-remote', status: 'online' }
    const remoteOffline = { id: 'dev-remote', fingerprint: 'fp-remote', status: 'offline' }

    it.each([
      {
        name: 'no control device → selectable',
        input: {
          controlDeviceId: null,
          controlDeviceStatus: null,
          currentDevice: local,
          devices: [local],
        },
        expected: true,
      },
      {
        name: 'local control → selectable even if status offline',
        input: {
          controlDeviceId: 'dev-local',
          controlDeviceStatus: 'offline',
          currentDevice: local,
          devices: [{ ...local, status: 'offline' }],
        },
        expected: true,
      },
      {
        name: 'remote online → selectable',
        input: {
          controlDeviceId: 'dev-remote',
          controlDeviceStatus: 'online',
          currentDevice: local,
          devices: [local, remoteOnline],
        },
        expected: true,
      },
      {
        name: 'remote busy → selectable',
        input: {
          controlDeviceId: 'dev-remote',
          controlDeviceStatus: 'busy',
          currentDevice: local,
          devices: [local, { ...remoteOnline, status: 'busy' }],
        },
        expected: true,
      },
      {
        name: 'remote offline → not selectable',
        input: {
          controlDeviceId: 'dev-remote',
          controlDeviceStatus: 'offline',
          currentDevice: local,
          devices: [local, remoteOffline],
        },
        expected: false,
      },
      {
        name: 'status missing (list lag) → selectable',
        input: {
          controlDeviceId: 'dev-remote',
          controlDeviceStatus: null,
          currentDevice: local,
          devices: [local],
        },
        expected: true,
      },
      {
        name: 'fingerprint-matched local control → selectable',
        input: {
          controlDeviceId: 'dev-stale',
          controlDeviceStatus: 'offline',
          currentDevice: { id: 'dev-new', fingerprint: 'fp-same', status: 'online' },
          devices: [
            { id: 'dev-stale', fingerprint: 'fp-same', status: 'offline' },
            { id: 'dev-new', fingerprint: 'fp-same', status: 'online' },
          ],
        },
        expected: true,
      },
    ])('$name', ({ input, expected }) => {
      expect(isWorkspaceExecutionSelectable(input)).toBe(expected)
    })
  })
})

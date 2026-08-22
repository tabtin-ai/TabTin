import { describe, expect, it } from 'vitest'
import {
  getHostPlatform,
  resolveRevealInOsLabel,
} from '../revealInOsLabel'

describe('getHostPlatform', () => {
  it('prefers Electron getPlatform over navigator', () => {
    expect(getHostPlatform(() => 'win32', 'MacIntel')).toBe('win32')
    expect(getHostPlatform(() => 'darwin', 'Win32')).toBe('darwin')
  })

  it('falls back to navigator.platform', () => {
    expect(getHostPlatform(undefined, 'MacIntel')).toBe('darwin')
    expect(getHostPlatform(undefined, 'Win32')).toBe('win32')
    expect(getHostPlatform(undefined, 'Linux x86_64')).toBe('linux')
  })
})

describe('resolveRevealInOsLabel', () => {
  const t = (key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? key

  it('uses Finder on macOS', () => {
    expect(resolveRevealInOsLabel(t, 'darwin')).toBe('Reveal in Finder')
  })

  it('uses File Explorer on Windows', () => {
    expect(resolveRevealInOsLabel(t, 'win32')).toBe('Reveal in File Explorer')
  })

  it('uses neutral file manager elsewhere', () => {
    expect(resolveRevealInOsLabel(t, 'linux')).toBe('Reveal in file manager')
    expect(resolveRevealInOsLabel(t, 'unknown')).toBe('Reveal in file manager')
  })

  it('selects the locale keys that en-US / zh-CN both define', () => {
    const seen: string[] = []
    const tSpy = (key: string, options?: { defaultValue?: string }) => {
      seen.push(key)
      return options?.defaultValue ?? key
    }
    resolveRevealInOsLabel(tSpy, 'darwin')
    resolveRevealInOsLabel(tSpy, 'win32')
    resolveRevealInOsLabel(tSpy, 'linux')
    expect(seen).toEqual([
      'card.openFile.revealInFinder',
      'card.openFile.revealInExplorer',
      'card.openFile.revealInOs',
    ])
  })
})

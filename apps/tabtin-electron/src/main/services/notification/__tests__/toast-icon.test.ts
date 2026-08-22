import { describe, expect, it } from 'vitest'
import {
  isWinRtReadableFsPath,
  resolveWinRtToastIconCandidates,
  resolveWinRtToastIconFileUrl,
} from '../toast-icon'

describe('isWinRtReadableFsPath', () => {
  it('rejects paths inside app.asar', () => {
    expect(isWinRtReadableFsPath('C:/App/resources/app.asar/static/icon.png')).toBe(false)
    expect(isWinRtReadableFsPath('C:\\App\\resources\\app.asar\\static\\icon.png')).toBe(false)
  })

  it('allows app.asar.unpacked and plain resources paths', () => {
    expect(
      isWinRtReadableFsPath('C:/App/resources/app.asar.unpacked/static/icon.png'),
    ).toBe(true)
    expect(isWinRtReadableFsPath('C:/App/resources/static/icon.png')).toBe(true)
  })
})

describe('resolveWinRtToastIconFileUrl', () => {
  it('prefers extraResources physical path over asar when both exist', () => {
    const resourcesPath = 'C:/TabTin Preprod/resources'
    const appPath = 'C:/TabTin Preprod/resources/app.asar'

    const url = resolveWinRtToastIconFileUrl({
      resourcesPath,
      appPath,
      existsSync: (p) => {
        const normalized = p.replace(/\\/g, '/')
        return (
          normalized === `${resourcesPath}/static/icon.png` ||
          normalized === `${appPath}/static/icon.png`
        )
      },
    })

    expect(url).toContain('/resources/static/icon.png')
    expect(url).not.toMatch(/app\.asar\//)
  })

  it('returns undefined when only asar path exists (WinRT cannot read it)', () => {
    const url = resolveWinRtToastIconFileUrl({
      resourcesPath: 'C:/App/resources',
      appPath: 'C:/App/resources/app.asar',
      existsSync: (p) => p.replace(/\\/g, '/').endsWith('app.asar/static/icon.png'),
    })
    expect(url).toBeUndefined()
  })

  it('falls back to app.asar.unpacked when extraResources missing', () => {
    const url = resolveWinRtToastIconFileUrl({
      resourcesPath: 'C:/App/resources',
      appPath: 'C:/App/resources/app.asar',
      existsSync: (p) =>
        p.replace(/\\/g, '/') === 'C:/App/resources/app.asar.unpacked/static/icon.png',
    })
    expect(url).toBe('file:///C:/App/resources/app.asar.unpacked/static/icon.png')
  })

  it('uses real appPath in unpackaged/dev layout', () => {
    const url = resolveWinRtToastIconFileUrl({
      resourcesPath: '',
      appPath: 'C:/tabtin/TabTin/apps/tabtin-electron',
      existsSync: (p) =>
        p.replace(/\\/g, '/') === 'C:/tabtin/TabTin/apps/tabtin-electron/static/icon.png',
    })
    expect(url).toBe('file:///C:/tabtin/TabTin/apps/tabtin-electron/static/icon.png')
  })

  it('candidate order puts resources/static before asar appPath', () => {
    const candidates = resolveWinRtToastIconCandidates({
      resourcesPath: 'R',
      appPath: 'R/app.asar',
    }).map((p) => p.replace(/\\/g, '/'))
    expect(candidates[0]).toBe('R/static/icon.png')
    expect(candidates[1]).toBe('R/app.asar.unpacked/static/icon.png')
    expect(candidates[2]).toBe('R/app.asar/static/icon.png')
  })
})

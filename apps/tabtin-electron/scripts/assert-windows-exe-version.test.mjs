import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  desktopVersionsAligned,
  isElectronBuilderNsisSetupName,
  normalizeDesktopVersion,
  selectElectronBuilderNsisSetup,
  setupNameMatchesVersion,
} from './assert-windows-exe-version.mjs'

describe('normalizeDesktopVersion', () => {
  it('strips trailing .0 beyond major.minor.patch', () => {
    assert.equal(normalizeDesktopVersion('0.7.56.0'), '0.7.56')
    assert.equal(normalizeDesktopVersion('v0.7.56'), '0.7.56')
  })

  it('keeps prerelease labels', () => {
    assert.equal(normalizeDesktopVersion('0.0.1-alpha.158'), '0.0.1-alpha.158')
  })
})

describe('desktopVersionsAligned', () => {
  it('matches equal and FileVersion-style suffixes', () => {
    assert.equal(desktopVersionsAligned('0.7.56', '0.7.56'), true)
    assert.equal(desktopVersionsAligned('0.7.56', '0.7.56.0'), true)
    assert.equal(desktopVersionsAligned('0.7.56', '0.7.54'), false)
  })

  it('compares prerelease expectations to the numeric PE core version', () => {
    assert.equal(desktopVersionsAligned('0.0.1-alpha.158', '0.0.1.0'), true)
    assert.equal(desktopVersionsAligned('0.0.1-alpha.158', '0.0.2.0'), false)
    assert.equal(desktopVersionsAligned('0.0.1-alpha.158', '0.0.1.9999'), false)
  })
})

describe('selectElectronBuilderNsisSetup', () => {
  it('picks version-matching builder Setup, not renamed share artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-setup-select-'))
    try {
      const stale = join(dir, 'TabTin Setup 0.7.54.exe')
      const current = join(dir, 'TabTin Preprod Setup 0.7.56.exe')
      const renamed = join(dir, 'TabTin-beta-0.7.56-x64-plain-upload-local-fast-setup.exe')
      writeFileSync(stale, '54')
      writeFileSync(current, '56')
      writeFileSync(renamed, 'renamed')
      // 故意让旧包 mtime 更新，复现「只按最新会选错」
      const now = Date.now() / 1000
      utimesSync(current, now - 100, now - 100)
      utimesSync(stale, now, now)

      assert.equal(isElectronBuilderNsisSetupName('TabTin Setup 0.7.54.exe'), true)
      assert.equal(isElectronBuilderNsisSetupName(basenameRenamed()), false)
      assert.equal(setupNameMatchesVersion('TabTin Preprod Setup 0.7.56.exe', '0.7.56'), true)

      const selected = selectElectronBuilderNsisSetup(dir, '0.7.56')
      assert.ok(selected)
      assert.equal(selected.name, 'TabTin Preprod Setup 0.7.56.exe')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    function basenameRenamed() {
      return 'TabTin-beta-0.7.56-x64-plain-upload-local-fast-setup.exe'
    }
  })
})

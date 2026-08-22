import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TABTIN_USER_DATA_DIR_NAMES,
  CREDENTIALS_FILE_NAME,
  TABTIN_CONFIG_DIR_RELATIVE_PATHS,
  TABTIN_UPDATER_CACHE_DIR_NAMES,
} from '../uninstall-cleanup-paths.js'

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
const electronRoot = join(repoRoot, 'apps', 'tabtin-electron')

describe('uninstall cleanup path sync (Windows NSIS)', () => {
  it('NSIS installer.nsh lists profiles + config wipe, and never RMDir whole TabTin / organizations', () => {
    const nsis = readFileSync(join(electronRoot, 'build', 'installer.nsh'), 'utf8')
    expect(nsis).toContain(CREDENTIALS_FILE_NAME)
    for (const name of TABTIN_USER_DATA_DIR_NAMES) {
      expect(nsis).toContain(name)
    }
    for (const name of TABTIN_CONFIG_DIR_RELATIVE_PATHS) {
      expect(nsis).toContain(name)
    }
    for (const name of TABTIN_UPDATER_CACHE_DIR_NAMES) {
      expect(nsis).toContain(name)
    }
    expect(nsis).not.toMatch(/RMDir \/r "\$APPDATA\\TabTin"/)
    expect(nsis).toMatch(/NEVER delete organizations/i)
  })
})

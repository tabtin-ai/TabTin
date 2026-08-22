import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildLibreOfficeFontSubstitutionXcu,
  resolveCjkFallbackFont,
  writeLibreOfficeCjkFallbackProfile,
} from '../office-preview-cjk-fonts'

describe('LibreOffice CJK font fallback ', () => {
  it('picks the first candidate whose font file exists', () => {
    const fallback = resolveCjkFallbackFont([
      { name: 'Missing', files: ['/definitely-not-a-font.ttf'] },
      { name: 'Hiragino Sans GB', files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'] },
    ])
    if (process.platform === 'darwin') {
      expect(fallback?.name).toBe('Hiragino Sans GB')
      expect(fallback?.files[0]).toContain('Hiragino Sans GB')
    }
  })

  it('writes a replacement table that maps 微软雅黑 to the fallback font', () => {
    const xcu = buildLibreOfficeFontSubstitutionXcu('Hiragino Sans GB')
    expect(xcu).toContain('<value>true</value>')
    expect(xcu).toContain('<value>Microsoft YaHei</value>')
    expect(xcu).toContain('<value>微软雅黑</value>')
    expect(xcu).toContain('<value>Hiragino Sans GB</value>')
    expect(xcu).not.toMatch(/<prop oor:name="ReplaceFont"[^>]*>\s*<value>Hiragino Sans GB<\/value>/)
  })

  it('seeds the LibreOffice user profile with fonts and registrymodifications.xcu', async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-lo-cjk-'))
    try {
      const fallback = await writeLibreOfficeCjkFallbackProfile(profileDir, {
        name: 'Hiragino Sans GB',
        files: ['/System/Library/Fonts/Hiragino Sans GB.ttc'],
      })
      expect(fallback?.name).toBe('Hiragino Sans GB')
      const xcu = await fs.readFile(path.join(profileDir, 'user', 'registrymodifications.xcu'), 'utf-8')
      expect(xcu).toContain('Microsoft YaHei')
      const seeded = await fs.readdir(path.join(profileDir, 'user', 'fonts'))
      expect(seeded).toContain('Hiragino Sans GB.ttc')
    } finally {
      await fs.rm(profileDir, { recursive: true, force: true })
    }
  })
})

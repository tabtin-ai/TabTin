import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { app } from 'electron'
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/downloads') },
  dialog: { showMessageBox: vi.fn() },
}))

import {
  isDangerousFile,
  sanitizeFilename,
  validateDownloadUrl,
  isPathSafe,
  normalizeDownloadFilename,
} from '../main/download-security'

const TMP_REALPATH = mkdtempSync(path.join(tmpdir(), 'download-safe-'))
const TMP_FILE = path.join(TMP_REALPATH, 'sample.txt')
writeFileSync(TMP_FILE, 'ok', 'utf8')

describe('isDangerousFile', () => {
  it('detects Windows executables', () => {
    expect(isDangerousFile('setup.exe')).toBe(true)
    expect(isDangerousFile('install.msi')).toBe(true)
    expect(isDangerousFile('script.bat')).toBe(true)
    expect(isDangerousFile('SETUP.EXE')).toBe(true)
  })

  it('detects macOS executables', () => {
    expect(isDangerousFile('my.app')).toBe(true)
    expect(isDangerousFile('install.dmg')).toBe(true)
    expect(isDangerousFile('setup.pkg')).toBe(true)
  })

  it('detects Linux executables', () => {
    expect(isDangerousFile('setup.sh')).toBe(true)
    expect(isDangerousFile('package.deb')).toBe(true)
    expect(isDangerousFile('package.rpm')).toBe(true)
  })

  it('detects Office macro files', () => {
    expect(isDangerousFile('report.docm')).toBe(true)
    expect(isDangerousFile('data.xlsm')).toBe(true)
  })

  it('returns false for safe file types', () => {
    expect(isDangerousFile('photo.jpg')).toBe(false)
    expect(isDangerousFile('document.pdf')).toBe(false)
    expect(isDangerousFile('data.csv')).toBe(false)
    expect(isDangerousFile('archive.zip')).toBe(false)
    expect(isDangerousFile('video.mp4')).toBe(false)
    expect(isDangerousFile('readme.txt')).toBe(false)
    expect(isDangerousFile('index.html')).toBe(false)
  })

  it('handles files without extension', () => {
    expect(isDangerousFile('Makefile')).toBe(false)
    expect(isDangerousFile('.gitignore')).toBe(false)
  })
})

describe('sanitizeFilename', () => {
  it('removes control characters and reserved chars', () => {
    expect(sanitizeFilename('file<name>.txt')).toBe('file_name_.txt')
    expect(sanitizeFilename('path/to\\file.txt')).toBe('path_to_file.txt')
    expect(sanitizeFilename('file:name?.txt')).toBe('file_name_.txt')
    expect(sanitizeFilename('file"name|test.txt')).toBe('file_name_test.txt')
  })

  it('prefixes Windows reserved names', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFilename('PRN.txt')).toBe('_PRN.txt')
    expect(sanitizeFilename('NUL')).toBe('_NUL')
    expect(sanitizeFilename('COM1.ext')).toBe('_COM1.ext')
    expect(sanitizeFilename('LPT3.log')).toBe('_LPT3.log')
  })

  it('does not prefix non-reserved names', () => {
    expect(sanitizeFilename('normal.txt')).toBe('normal.txt')
    expect(sanitizeFilename('CONNECTION.log')).toBe('CONNECTION.log')
  })

  it('truncates overly long filenames preserving extension', () => {
    const longName = 'a'.repeat(300) + '.txt'
    const result = sanitizeFilename(longName)
    expect(result.length).toBeLessThanOrEqual(200)
    expect(result.endsWith('.txt')).toBe(true)
  })

  it('returns "download" for empty input', () => {
    expect(sanitizeFilename('')).toBe('download')
  })

  it('handles normal filenames unchanged', () => {
    expect(sanitizeFilename('my-photo.jpg')).toBe('my-photo.jpg')
    expect(sanitizeFilename('document_2024.pdf')).toBe('document_2024.pdf')
  })
})

describe('normalizeDownloadFilename', () => {
  it('accepts safe plain filename', () => {
    expect(normalizeDownloadFilename('video.mp4')).toBe('video.mp4')
  })

  it('rejects path traversal filename', () => {
    expect(() => normalizeDownloadFilename('../secret.txt')).toThrow()
  })

  it('rejects filename with path separators', () => {
    expect(() => normalizeDownloadFilename('a/b.txt')).toThrow()
    expect(() => normalizeDownloadFilename('a\\b.txt')).toThrow()
  })

  it('rejects absolute filename', () => {
    expect(() => normalizeDownloadFilename('/tmp/x.txt')).toThrow()
    expect(() => normalizeDownloadFilename('C:\\tmp\\x.txt')).toThrow()
  })
})

describe('validateDownloadUrl', () => {
  it('accepts http URLs', () => {
    const result = validateDownloadUrl('http://example.com/file.zip')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('accepts https URLs', () => {
    const result = validateDownloadUrl('https://cdn.example.com/asset.js')
    expect(result.valid).toBe(true)
  })

  it('rejects file:// protocol', () => {
    const result = validateDownloadUrl('file:///etc/passwd')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects ftp:// protocol', () => {
    const result = validateDownloadUrl('ftp://files.example.com/file.zip')
    expect(result.valid).toBe(false)
  })

  it('rejects javascript: protocol', () => {
    const result = validateDownloadUrl('javascript:alert(1)')
    expect(result.valid).toBe(false)
  })

  it('rejects invalid URLs', () => {
    const result = validateDownloadUrl('not-a-url')
    expect(result.valid).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('rejects empty string', () => {
    const result = validateDownloadUrl('')
    expect(result.valid).toBe(false)
  })
})

describe('isPathSafe', () => {
  beforeEach(() => {
    vi.mocked(app.getPath).mockReturnValue(TMP_REALPATH)
  })

  it('allows paths within default downloads directory', () => {
    expect(isPathSafe(TMP_FILE)).toBe(true)
  })

  it('rejects paths outside downloads directory', () => {
    expect(isPathSafe('/etc/passwd')).toBe(false)
    expect(isPathSafe('/usr/local/bin/bad')).toBe(false)
  })

  it('allows exact match of directory', () => {
    expect(isPathSafe(TMP_REALPATH)).toBe(true)
  })

  it('allows paths within custom allowed directories', () => {
    expect(isPathSafe(TMP_FILE, [TMP_REALPATH])).toBe(true)
  })

  it('rejects paths outside custom allowed directories', () => {
    expect(isPathSafe('/other/path/file.txt', [TMP_REALPATH])).toBe(false)
  })

  it('ignores non-existent dirs and still validates existing allowed dirs', () => {
    expect(isPathSafe(TMP_FILE, ['/missing/dir', TMP_REALPATH])).toBe(true)
  })

  it('rejects when all allowed dirs are invalid', () => {
    expect(isPathSafe('/tmp/file.txt', ['/none/a', '/none/b'])).toBe(false)
  })

  // --- EEL-015: symlink in intermediate directory should not bypass allowlist ---
  it('rejects non-existent path under symlink that escapes allowed boundary', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'outside-'))
    const symlinkName = path.join(TMP_REALPATH, 'escape-link')
    try {
      symlinkSync(outsideDir, symlinkName)
      const maliciousPath = path.join(symlinkName, 'nonexistent.txt')
      expect(isPathSafe(maliciousPath, [TMP_REALPATH])).toBe(false)
    } finally {
      try { rmSync(symlinkName) } catch { /* cleanup */ }
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects path traversal via .. even when intermediate dirs exist', () => {
    const subDir = path.join(TMP_REALPATH, 'subdir')
    try {
      mkdirSync(subDir, { recursive: true })
    } catch { /* already exists */ }
    const traversalPath = path.join(subDir, '..', '..', '..', 'etc', 'passwd')
    expect(isPathSafe(traversalPath, [TMP_REALPATH])).toBe(false)
  })
})

// --- EEL-015 regression: resolveWithNearestRealAncestor robustness ---
describe('isPathSafe — EEL-015 ancestor resolution hardening', () => {
  beforeEach(() => {
    vi.mocked(app.getPath).mockReturnValue(TMP_REALPATH)
  })

  it('rejects when path is under a symlink that resolves outside allowlist', () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'eel015-outside-'))
    const subDir = path.join(TMP_REALPATH, 'sub015')
    const symlinkName = path.join(subDir, 'escape')
    try {
      mkdirSync(subDir, { recursive: true })
      symlinkSync(outsideDir, symlinkName)
      const targetFile = path.join(symlinkName, 'secret.txt')
      expect(isPathSafe(targetFile, [TMP_REALPATH])).toBe(false)
    } finally {
      try { rmSync(symlinkName) } catch { /* cleanup */ }
      try { rmSync(subDir, { recursive: true, force: true }) } catch { /* cleanup */ }
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('rejects deeply non-existent paths that resolve outside allowlist via ..', () => {
    const fakePath = path.join(TMP_REALPATH, 'a', '..', '..', '..', 'etc', 'shadow')
    expect(isPathSafe(fakePath, [TMP_REALPATH])).toBe(false)
  })

  it('allows non-existent file under valid allowed dir (no symlink escape)', () => {
    const newFile = path.join(TMP_REALPATH, 'newdir', 'newfile.txt')
    expect(isPathSafe(newFile, [TMP_REALPATH])).toBe(true)
  })
})

afterAll(() => {
  rmSync(TMP_REALPATH, { recursive: true, force: true })
})

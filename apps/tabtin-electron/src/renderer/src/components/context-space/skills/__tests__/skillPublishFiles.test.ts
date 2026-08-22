import { describe, it, expect } from 'vitest'
import {
  collectSkillFiles,
  hasSkillMd,
  toSkillRelPath,
  arrayBufferToBase64,
  isLikelyBinaryPath,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_BUNDLE_BYTES,
  type SkillFsDirEntry,
  type SkillFsLike,
} from '../skillPublishFiles'

interface FakeFile {
  kind?: string
  content?: string
  size?: number
  truncated?: boolean
  fail?: boolean
  missing?: boolean
}

interface FakeBinary {
  bytes?: number[]
  fail?: boolean
  missing?: boolean
}

function makeFs(
  dirs: Record<string, SkillFsDirEntry[]>,
  files: Record<string, FakeFile>,
): SkillFsLike {
  return {
    async readDir(path: string) {
      const entries = dirs[path]
      if (!entries) return { success: false }
      return { success: true, entries }
    },
    async readFilePreview(path: string) {
      const f = files[path]
      if (!f || f.missing) return { success: false }
      if (f.fail) throw new Error('boom')
      return {
        success: true,
        data: {
          kind: f.kind ?? 'text',
          content: f.content ?? '',
          size: f.size,
          truncated: f.truncated,
        },
      }
    },
  }
}

/** makeFs + readBinaryFile 能力（模拟新版 preload，能读二进制字节）。 */
function makeFsBin(
  dirs: Record<string, SkillFsDirEntry[]>,
  files: Record<string, FakeFile>,
  binaries: Record<string, FakeBinary>,
): SkillFsLike {
  return {
    ...makeFs(dirs, files),
    async readBinaryFile(path: string) {
      const b = binaries[path]
      if (!b || b.missing) return { success: false }
      if (b.fail) throw new Error('boom')
      return { success: true, data: new Uint8Array(b.bytes ?? []).buffer }
    },
  }
}

/** base64 → 字节数组（测试断言用）。 */
function b64ToBytes(b64: string): number[] {
  return Array.from(atob(b64), c => c.charCodeAt(0))
}

function dirEntry(name: string, path: string, isDirectory = false): SkillFsDirEntry {
  return { name, path, isDirectory }
}

describe('toSkillRelPath', () => {
  it('returns posix relative path under root', () => {
    expect(toSkillRelPath('/skill', '/skill/SKILL.md')).toBe('SKILL.md')
    expect(toSkillRelPath('/skill', '/skill/references/style.md')).toBe('references/style.md')
  })

  it('tolerates trailing slash and backslashes in root', () => {
    expect(toSkillRelPath('/skill/', '/skill/a.md')).toBe('a.md')
    expect(toSkillRelPath('C:\\skill', 'C:\\skill\\a.md')).toBe('a.md')
  })

  it('falls back to basename when path is not under root', () => {
    expect(toSkillRelPath('/skill', '/elsewhere/a.md')).toBe('a.md')
  })
})

describe('hasSkillMd', () => {
  it('detects SKILL.md at root or nested', () => {
    expect(hasSkillMd([{ path: 'SKILL.md', content: '' }])).toBe(true)
    expect(hasSkillMd([{ path: 'nested/SKILL.md', content: '' }])).toBe(true)
    expect(hasSkillMd([{ path: 'references/style.md', content: '' }])).toBe(false)
  })
})

describe('collectSkillFiles', () => {
  it('recursively collects text files with posix relative paths', async () => {
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('references', '/skill/references', true),
        ],
        '/skill/references': [
          dirEntry('style.md', '/skill/references/style.md'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '---\nname: demo\n---\n# Demo\n' },
        '/skill/references/style.md': { content: '# Style' },
      },
    )

    const result = await collectSkillFiles('/skill', fs)

    expect(result.files).toEqual([
      { path: 'SKILL.md', content: '---\nname: demo\n---\n# Demo\n' },
      { path: 'references/style.md', content: '# Style' },
    ])
    expect(result.skipped).toEqual([])
    expect(hasSkillMd(result.files)).toBe(true)
  })

  it('skips binary and too-large files, keeps text ones', async () => {
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('logo.png', '/skill/logo.png'),
          dirEntry('.gitignore', '/skill/.gitignore'),
          dirEntry('.eslintrc.js', '/skill/.eslintrc.js'),
          dirEntry('references', '/skill/references', true),
          dirEntry('.git', '/skill/.git', true),
          dirEntry('node_modules', '/skill/node_modules', true),
        ],
        '/skill/references': [
          dirEntry('style.md', '/skill/references/style.md'),
          dirEntry('.keep', '/skill/references/.keep'),
          dirEntry('big.txt', '/skill/references/big.txt'),
        ],
        // .* / node_modules 不应被遍历——给个内容也无所谓，断言里不应出现
        '/skill/.git': [dirEntry('HEAD', '/skill/.git/HEAD')],
        '/skill/node_modules': [dirEntry('pkg.js', '/skill/node_modules/pkg.js')],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/logo.png': { kind: 'image' },
        '/skill/.gitignore': { content: 'node_modules/\n' },
        '/skill/.eslintrc.js': { content: 'module.exports = {}\n' },
        '/skill/references/style.md': { content: '# Style' },
        '/skill/references/.keep': { content: '' },
        '/skill/references/big.txt': { kind: 'text', truncated: true, size: MAX_SKILL_FILE_BYTES + 100 },
        '/skill/.git/HEAD': { content: 'ref: refs/heads/main' },
        '/skill/node_modules/pkg.js': { content: 'export {}\n' },
      },
    )

    const result = await collectSkillFiles('/skill', fs)

    expect(result.files.map(f => f.path)).toEqual(['SKILL.md', 'references/style.md'])
    expect(result.skipped).toEqual([
      { path: 'logo.png', reason: 'binary' },
      { path: 'references/big.txt', reason: 'too-large' },
    ])
    // .* / node_modules 不进收集结果，也不进 skipped
    expect(result.files.some(f => f.path.split('/').some(p => p.startsWith('.')))).toBe(false)
    expect(result.files.some(f => f.path.includes('node_modules'))).toBe(false)
    expect(result.skipped.some(s => s.path.includes('.git') || s.path.includes('node_modules'))).toBe(false)
  })

  it('skips a file whose reported size exceeds the per-file cap even without truncation flag', async () => {
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('huge.txt', '/skill/huge.txt'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/huge.txt': { kind: 'text', content: 'partial', size: MAX_SKILL_FILE_BYTES + 1 },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([{ path: 'huge.txt', reason: 'too-large' }])
  })

  it('records read errors as skipped', async () => {
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('boom.md', '/skill/boom.md'),
          dirEntry('gone.md', '/skill/gone.md'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/boom.md': { fail: true },
        '/skill/gone.md': { missing: true },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([
      { path: 'boom.md', reason: 'read-error' },
      { path: 'gone.md', reason: 'read-error' },
    ])
  })

  it('prefers override (in-memory buffer) content over disk', async () => {
    const fs = makeFs(
      {
        '/skill': [dirEntry('SKILL.md', '/skill/SKILL.md')],
      },
      {
        '/skill/SKILL.md': { content: 'ON DISK' },
      },
    )

    const result = await collectSkillFiles('/skill', fs, { '/skill/SKILL.md': 'IN MEMORY' })
    expect(result.files).toEqual([{ path: 'SKILL.md', content: 'IN MEMORY' }])
  })

  it('strips file-maintained SKILL.md versions from disk and overrides', async () => {
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('nested', '/skill/nested', true),
        ],
        '/skill/nested': [
          dirEntry('SKILL.md', '/skill/nested/SKILL.md'),
        ],
      },
      {
        '/skill/SKILL.md': {
          content: '---\nname: demo\nversion: 0.1.0\nmetadata:\n  version: 0.2.0\n  tabtin:\n    displayName: Demo\n---\n# Demo\n',
        },
        '/skill/nested/SKILL.md': {
          content: 'unused',
        },
      },
    )

    const result = await collectSkillFiles('/skill', fs, {
      '/skill/nested/SKILL.md': '---\nname: nested\nmetadata:\n  version: 9.9.9\n---\n# Nested\n',
    })

    const root = result.files.find(f => f.path === 'SKILL.md')?.content ?? ''
    const nested = result.files.find(f => f.path === 'nested/SKILL.md')?.content ?? ''
    expect(root).toContain('metadata:')
    expect(root).toContain('  tabtin:')
    expect(root).not.toContain('version:')
    expect(nested).not.toContain('version:')
  })

  it('skips override content that exceeds the per-file cap', async () => {
    const tooBig = 'a'.repeat(MAX_SKILL_FILE_BYTES + 1)
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('notes.txt', '/skill/notes.txt'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/notes.txt': { content: 'small on disk' },
      },
    )

    const result = await collectSkillFiles('/skill', fs, { '/skill/notes.txt': tooBig })
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([{ path: 'notes.txt', reason: 'too-large' }])
  })

  it('enforces the 20MB bundle limit while always keeping SKILL.md', async () => {
    // 11 个各 2MB 的文件（共享同一字符串引用省内存），合计 > 20MB：超预算的尾部 pad 被跳过，
    // 但必备的 SKILL.md 永远收进（SKILL.md 优先排序，不会被大文件挤出预算）。
    const oneFile = 'a'.repeat(MAX_SKILL_FILE_BYTES) // 恰好 2MB，per-file 不超限
    const fileCount = Math.ceil(MAX_SKILL_BUNDLE_BYTES / MAX_SKILL_FILE_BYTES) + 1 // 11
    const entries: SkillFsDirEntry[] = [dirEntry('SKILL.md', '/skill/SKILL.md')]
    const files: Record<string, FakeFile> = { '/skill/SKILL.md': { content: '# Demo' } }
    const overrides: Record<string, string> = {}
    for (let i = 0; i < fileCount; i += 1) {
      const name = `pad-${String(i).padStart(2, '0')}.txt`
      const abs = `/skill/${name}`
      entries.push(dirEntry(name, abs))
      files[abs] = { content: 'unused on disk' }
      overrides[abs] = oneFile
    }
    const fs = makeFs({ '/skill': entries }, files)

    const result = await collectSkillFiles('/skill', fs, overrides)

    expect(hasSkillMd(result.files)).toBe(true)
    expect(result.totalBytes).toBeLessThanOrEqual(MAX_SKILL_BUNDLE_BYTES)
    // 至少有一个 pad 因超预算被跳过，且没把全部 pad 收进。
    expect(result.skipped.some(s => s.reason === 'bundle-limit')).toBe(true)
    const padIncluded = result.files.filter(f => f.path.startsWith('pad-')).length
    expect(padIncluded).toBeLessThan(fileCount)
    // 被跳过的都是 pad，绝不会是 SKILL.md。
    expect(result.skipped.every(s => s.path.startsWith('pad-'))).toBe(true)
  })

  it('returns empty result when root dir cannot be read', async () => {
    const fs = makeFs({}, {})
    const result = await collectSkillFiles('/missing', fs)
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.totalBytes).toBe(0)
  })
})

describe('arrayBufferToBase64', () => {
  it('round-trips arbitrary bytes (0..255) through atob', () => {
    const bytes = Array.from({ length: 256 }, (_, i) => i)
    const b64 = arrayBufferToBase64(new Uint8Array(bytes).buffer)
    expect(b64ToBytes(b64)).toEqual(bytes)
  })

  it('encodes an empty buffer to an empty string', () => {
    expect(arrayBufferToBase64(new Uint8Array([]).buffer)).toBe('')
  })

  it('round-trips a buffer larger than the 32KB chunk size', () => {
    const bytes = Array.from({ length: 0x8000 + 123 }, (_, i) => i % 256)
    const b64 = arrayBufferToBase64(new Uint8Array(bytes).buffer)
    expect(b64ToBytes(b64)).toEqual(bytes)
  })
})

describe('isLikelyBinaryPath', () => {
  it('treats svg as text (must NOT be on the binary path)', () => {
    expect(isLikelyBinaryPath('icon.svg')).toBe(false)
    expect(isLikelyBinaryPath('assets/Icon.SVG')).toBe(false)
  })

  it('flags images / icons / fonts / archives / binaries', () => {
    for (const p of [
      'logo.png', 'a.jpg', 'b.jpeg', 'c.gif', 'd.webp', 'e.ico', 'f.bmp',
      'g.woff', 'h.woff2', 'i.ttf', 'j.otf', 'k.eot',
      'l.zip', 'm.tar', 'n.gz', 'o.pdf', 'p.bin', 'q.dat',
    ]) {
      expect(isLikelyBinaryPath(p)).toBe(true)
    }
  })

  it('treats markdown / source / text as non-binary', () => {
    expect(isLikelyBinaryPath('SKILL.md')).toBe(false)
    expect(isLikelyBinaryPath('references/style.md')).toBe(false)
    expect(isLikelyBinaryPath('scripts/run.py')).toBe(false)
    expect(isLikelyBinaryPath('data.json')).toBe(false)
  })
})

describe('collectSkillFiles (binary assets)', () => {
  it('collects binary assets as base64 (encoding flag), keeps svg + md as text', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]
    const fs = makeFsBin(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('icon.svg', '/skill/icon.svg'),
          dirEntry('assets', '/skill/assets', true),
        ],
        '/skill/assets': [dirEntry('logo.png', '/skill/assets/logo.png')],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/icon.svg': { kind: 'text', content: '<svg/>' },
        '/skill/assets/logo.png': { kind: 'image', size: png.length },
      },
      {
        '/skill/assets/logo.png': { bytes: png },
      },
    )

    const result = await collectSkillFiles('/skill', fs)

    // 文本项不带 encoding（与旧契约逐字段兼容）。
    expect(result.files.find(f => f.path === 'SKILL.md')).toEqual({ path: 'SKILL.md', content: '# Demo' })
    // svg 走文本通道（不再被当二进制丢弃）。
    expect(result.files.find(f => f.path === 'icon.svg')).toEqual({ path: 'icon.svg', content: '<svg/>' })
    // png 走 base64，且解码字节与原始一致。
    const logo = result.files.find(f => f.path === 'assets/logo.png')
    expect(logo?.encoding).toBe('base64')
    expect(b64ToBytes(logo!.content)).toEqual(png)
    expect(result.skipped).toEqual([])
    // 预算按解码后真实字节计入（不是 base64 串长度）。
    expect(result.totalBytes).toBe('# Demo'.length + '<svg/>'.length + png.length)
  })

  it('skips an oversized binary by reported size without reading bytes', async () => {
    const fs = makeFsBin(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('big.png', '/skill/big.png'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        // 二进制单文件上限是整包预算 20MB；超过它才算 too-large。
        '/skill/big.png': { kind: 'image', size: MAX_SKILL_BUNDLE_BYTES + 1 },
      },
      {}, // 没提供 bytes：若误读 readBinaryFile 会 success:false，这里应在读之前就跳过
    )

    const result = await collectSkillFiles('/skill', fs)
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([{ path: 'big.png', reason: 'too-large' }])
  })

  it('collects a binary asset larger than the 2MB text cap (up to the 20MB bundle cap)', async () => {
    // 3MB 字体：文本通道会被 2MB 截断丢弃，二进制通道应放行（关键回归：导入的大资源可再发布）。
    const big = new Array(MAX_SKILL_FILE_BYTES + 1024).fill(7)
    const fs = makeFsBin(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('font.ttf', '/skill/font.ttf'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/font.ttf': { kind: 'binary', size: big.length },
      },
      {
        '/skill/font.ttf': { bytes: big },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    const font = result.files.find(f => f.path === 'font.ttf')
    expect(font?.encoding).toBe('base64')
    expect(b64ToBytes(font!.content)).toEqual(big)
    expect(result.skipped).toEqual([])
  })

  it('records a read-error when readBinaryFile throws / fails', async () => {
    const fs = makeFsBin(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('boom.png', '/skill/boom.png'),
          dirEntry('gone.png', '/skill/gone.png'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/boom.png': { kind: 'image' },
        '/skill/gone.png': { kind: 'image' },
      },
      {
        '/skill/boom.png': { fail: true },
        '/skill/gone.png': { missing: true },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([
      { path: 'boom.png', reason: 'read-error' },
      { path: 'gone.png', reason: 'read-error' },
    ])
  })

  it('falls back to skip:binary when the fs has no readBinaryFile capability', async () => {
    // 旧 preload（无 readBinaryFile）：二进制保持原「跳过」语义，不报错。
    const fs = makeFs(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('logo.png', '/skill/logo.png'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/logo.png': { kind: 'image' },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md'])
    expect(result.skipped).toEqual([{ path: 'logo.png', reason: 'binary' }])
  })

  it('counts decoded binary bytes against the 20MB bundle budget', async () => {
    // 让单个二进制刚好在 per-file 上限内，但用 readFilePreview.size 触发预算累计。
    const half = Math.floor(MAX_SKILL_FILE_BYTES / 2)
    const bytesA = new Array(half).fill(1)
    const bytesB = new Array(half).fill(2)
    const fs = makeFsBin(
      {
        '/skill': [
          dirEntry('SKILL.md', '/skill/SKILL.md'),
          dirEntry('a.png', '/skill/a.png'),
          dirEntry('b.png', '/skill/b.png'),
        ],
      },
      {
        '/skill/SKILL.md': { content: '# Demo' },
        '/skill/a.png': { kind: 'image', size: half },
        '/skill/b.png': { kind: 'image', size: half },
      },
      {
        '/skill/a.png': { bytes: bytesA },
        '/skill/b.png': { bytes: bytesB },
      },
    )

    const result = await collectSkillFiles('/skill', fs)
    // 两个 half 都收得下（2 * half ≤ 2MB ≤ 20MB），且都标 base64。
    expect(result.files.map(f => f.path)).toEqual(['SKILL.md', 'a.png', 'b.png'])
    expect(result.files.filter(f => f.encoding === 'base64')).toHaveLength(2)
    expect(result.totalBytes).toBe('# Demo'.length + half * 2)
  })
})

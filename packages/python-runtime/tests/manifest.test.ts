import { describe, expect, it } from 'vitest'

import { expectedPlatform, isSafeRelativePath, parseManifest, selectPlatformEntry } from '../src/manifest.js'
import { PythonRuntimeError, type PythonRuntimeManifest } from '../src/types.js'

const SHA = 'a'.repeat(64)

function validManifest(overrides: Partial<PythonRuntimeManifest> = {}): PythonRuntimeManifest {
  return {
    schemaVersion: 2,
    runtimeKind: 'python',
    version: '3.12.13',
    platforms: {
      [expectedPlatform()]: {
        archiveName: 'tabtin-python-runtime.tar.gz',
        sha256: SHA,
        size: 123,
        entrypoint: 'bin/python3',
      },
    },
    ...overrides,
  }
}

describe('isSafeRelativePath', () => {
  it('接受安全相对路径 / 拒绝穿越绝对盘符', () => {
    expect(isSafeRelativePath('bin/python3')).toBe(true)
    expect(isSafeRelativePath('../evil')).toBe(false)
    expect(isSafeRelativePath('/etc/passwd')).toBe(false)
    expect(isSafeRelativePath('C:\\Windows')).toBe(false)
  })
})

describe('parseManifest（v2 combined）', () => {
  it('解析合法 manifest', () => {
    const m = parseManifest(JSON.stringify(validManifest()), 'test')
    expect(m.schemaVersion).toBe(2)
    expect(m.version).toBe('3.12.13')
    expect(m.platforms[expectedPlatform()].entrypoint).toBe('bin/python3')
  })

  it('非 JSON 抛 MANIFEST_INVALID', () => {
    expect(() => parseManifest('nope', 'test')).toThrowError(PythonRuntimeError)
  })

  it('schema v1（旧）被拒', () => {
    const bad = { ...validManifest(), schemaVersion: 1 } as unknown
    expect(() => parseManifest(JSON.stringify(bad), 'test')).toThrow(/schema/)
  })

  it('platforms 为空抛错', () => {
    const bad = validManifest({ platforms: {} })
    expect(() => parseManifest(JSON.stringify(bad), 'test')).toThrow(/为空/)
  })

  it('条目 sha256 非法抛错', () => {
    const bad = validManifest({ platforms: { [expectedPlatform()]: { archiveName: 'y.tgz', sha256: 'xyz', entrypoint: 'bin/python3' } } })
    expect(() => parseManifest(JSON.stringify(bad), 'test')).toThrow(/sha256/)
  })

  it('条目 entrypoint 穿越抛错', () => {
    const bad = validManifest({ platforms: { [expectedPlatform()]: { archiveName: 'y.tgz', sha256: SHA, entrypoint: '../python' } } })
    expect(() => parseManifest(JSON.stringify(bad), 'test')).toThrow(/缺字段或非法/)
  })
})

describe('selectPlatformEntry', () => {
  it('命中本机平台条目', () => {
    const m = validManifest()
    expect(selectPlatformEntry(m)?.entrypoint).toBe('bin/python3')
  })
  it('不含本机平台 → null', () => {
    const m = validManifest({ platforms: { 'solaris-sparc': { archiveName: 'y.tgz', sha256: SHA, entrypoint: 'bin/python3' } } })
    expect(selectPlatformEntry(m)).toBeNull()
  })
})

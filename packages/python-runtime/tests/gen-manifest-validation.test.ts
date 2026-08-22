import { describe, expect, it } from 'vitest'

import {
  archiveNameForPlatform,
  entrypointForPlatform,
  isValidManifestPlatform,
  isValidManifestPlatformEntry,
} from '../../../scripts/electron/package/gen-python-runtime-manifest.mjs'

const SHA = 'a'.repeat(64)

describe('gen-python-runtime-manifest 校验辅助', () => {
  it('archiveNameForPlatform 读 archives 文件名', () => {
    expect(
      archiveNameForPlatform(
        { archives: { 'darwin-arm64': 'tabtin-python-runtime-darwin-arm64.tar.gz' } },
        'darwin-arm64',
      ),
    ).toBe('tabtin-python-runtime-darwin-arm64.tar.gz')
  })

  it('entrypointForPlatform 区分 Windows 与 Unix', () => {
    expect(entrypointForPlatform('darwin-arm64')).toBe('bin/python3')
    expect(entrypointForPlatform('win32-x64')).toBe('python.exe')
  })

  it('isValidManifestPlatformEntry 接受合法条目', () => {
    expect(
      isValidManifestPlatformEntry({
        archiveName: 'tabtin-python-runtime-darwin-x64.tar.gz',
        sha256: SHA,
        size: 123,
        entrypoint: 'bin/python3',
      }),
    ).toBe(true)
  })

  it('isValidManifestPlatformEntry 拒绝非法 sha / 穿越 entrypoint', () => {
    expect(
      isValidManifestPlatformEntry({
        archiveName: 'y.tgz',
        sha256: 'bad',
        size: 1,
        entrypoint: 'bin/python3',
      }),
    ).toBe(false)
    expect(
      isValidManifestPlatformEntry({
        archiveName: 'y.tgz',
        sha256: SHA,
        size: 1,
        entrypoint: '../python',
      }),
    ).toBe(false)
  })

  it('isValidManifestPlatform 要求 schema v2 且含目标平台', () => {
    const manifest = {
      schemaVersion: 2,
      runtimeKind: 'python',
      version: '3.12.13',
      platforms: {
        'darwin-x64': {
          archiveName: 'tabtin-python-runtime-darwin-x64.tar.gz',
          sha256: SHA,
          size: 456,
          entrypoint: 'bin/python3',
        },
      },
    }
    expect(isValidManifestPlatform(manifest, 'darwin-x64')).toBe(true)
    expect(isValidManifestPlatform(manifest, 'darwin-arm64')).toBe(false)
    expect(isValidManifestPlatform({ ...manifest, schemaVersion: 1 }, 'darwin-x64')).toBe(false)
  })
})

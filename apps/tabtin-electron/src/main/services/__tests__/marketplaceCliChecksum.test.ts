import { mkdtemp, writeFile, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'

import {
  listResolvedMarketplaceChecksumKeys,
  normalizeSha256Expected,
  resolveMarketplaceChecksumKey,
  sha256HexOfFile,
  verifyBinarySha256,
} from '../marketplaceCliChecksum'

const execFileAsync = promisify(execFile)

describe('marketplaceCliChecksum', () => {
  it('resolveMarketplaceChecksumKey matches platform/arch maps', () => {
    const maps = {
      platformMap: { darwin: 'darwin', linux: 'linux', win32: 'windows' },
      archMap: { x64: 'amd64', arm64: 'arm64' },
    }
    expect(resolveMarketplaceChecksumKey(maps, 'linux', 'x64')).toBe('linux-amd64')
    expect(resolveMarketplaceChecksumKey(maps, 'win32', 'arm64')).toBe('windows-arm64')
  })

  it('listResolvedMarketplaceChecksumKeys returns six keys for full marketplace App maps', () => {
    const keys = listResolvedMarketplaceChecksumKeys({
      platformMap: { darwin: 'darwin', linux: 'linux', win32: 'windows' },
      archMap: { x64: 'amd64', arm64: 'arm64' },
    })
    expect(keys.sort()).toEqual(
      [
        'darwin-amd64',
        'darwin-arm64',
        'linux-amd64',
        'linux-arm64',
        'windows-amd64',
        'windows-arm64',
      ].sort(),
    )
  })

  it('normalizeSha256Expected strips optional prefix', () => {
    expect(normalizeSha256Expected('sha256:abc')).toBe('abc')
    expect(normalizeSha256Expected('deadbeef')).toBe('deadbeef')
  })

  it('verifyBinarySha256 matches file hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mchk-'))
    const p = join(dir, 'bin')
    try {
      await writeFile(p, Buffer.from('hello-checksum', 'utf-8'))
      const hex = createHash('sha256').update(Buffer.from('hello-checksum', 'utf-8')).digest('hex')
      await verifyBinarySha256(p, `sha256:${hex}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('verifyBinarySha256 rejects bad hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mchk-'))
    const p = join(dir, 'bin')
    try {
      await writeFile(p, Buffer.from('a', 'utf-8'))
      await expect(verifyBinarySha256(p, 'sha256:00'.padEnd(66, '0'))).rejects.toThrow(
        /SHA256 verification failed/,
      )
      await expect(readFile(p).then(() => true, () => false)).resolves.toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * 与 `scripts/marketplace-cli-checksums.ts` / MarketplaceAppInstaller 一致：
   * tar.gz 根目录含目标二进制，解压后对文件做 SHA256。
   */
  it('tar.gz extract then sha256 matches direct binary hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mchk-tar-'))
    try {
      const binName = 'demo-cli'
      const binPath = join(dir, binName)
      await writeFile(binPath, Buffer.from('fake-cli', 'utf-8'))
      const direct = await sha256HexOfFile(binPath)
      const tarPath = join(dir, 'bundle.tar.gz')
      await execFileAsync('tar', ['-czf', tarPath, '-C', dir, binName])

      const extractDir = await mkdtemp(join(tmpdir(), 'mchk-ex-'))
      try {
        await execFileAsync('tar', ['-xzf', tarPath, '-C', extractDir])
        const after = await sha256HexOfFile(join(extractDir, binName))
        expect(after).toBe(direct)
      } finally {
        await rm(extractDir, { recursive: true, force: true })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

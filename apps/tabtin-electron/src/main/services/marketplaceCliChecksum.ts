/**
 * Marketplace CLI checksum helpers — 与 `MarketplaceAppInstaller` 使用同一套键名与哈希语义。
 * 校验对象为解压后的 `cli.binary` 文件（不是 tar.gz 本身）。
 */

import { createHash } from 'crypto'
import { readFile, rm } from 'fs/promises'

export interface MarketplaceCliMaps {
  platformMap: Record<string, string>
  archMap: Record<string, string>
}

/** 与安装器运行时一致：当前 Node 进程对应的 checksum 键 */
export function resolveMarketplaceChecksumKey(
  maps: MarketplaceCliMaps,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const p = maps.platformMap[platform]
  const a = maps.archMap[arch]
  if (!p || !a) return null
  return `${p}-${a}`
}

const NODE_PLATFORM_ARCH_TRIPLES: Array<[NodeJS.Platform, string]> = [
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['win32', 'x64'],
  ['win32', 'arm64'],
]

/** 发布脚本用：列出 manifest 能覆盖的全部 checksum 键（常见六元组与 platformMap/archMap 的交集） */
export function listResolvedMarketplaceChecksumKeys(maps: MarketplaceCliMaps): string[] {
  const keys: string[] = []
  for (const [pl, ar] of NODE_PLATFORM_ARCH_TRIPLES) {
    const k = resolveMarketplaceChecksumKey(maps, pl, ar)
    if (k) keys.push(k)
  }
  return keys
}

export function normalizeSha256Expected(stored: string): string {
  return stored.replace(/^sha256:/i, '').trim()
}

export async function sha256HexOfFile(filePath: string): Promise<string> {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 安装器校验：与 manifest 中 `cli.checksums[key]` 比较（允许 `sha256:` 前缀）。
 * 失败时删除二进制，与历史行为一致。
 */
export async function verifyBinarySha256(filePath: string, expectedStored: string): Promise<void> {
  const expected = normalizeSha256Expected(expectedStored)
  if (!expected) return

  const actual = await sha256HexOfFile(filePath)
  if (actual !== expected) {
    await rm(filePath, { force: true })
    throw new Error(`SHA256 verification failed: expected ${expected}, got ${actual}`)
  }
}

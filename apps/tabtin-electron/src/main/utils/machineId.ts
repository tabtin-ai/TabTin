/**
 * 读取本机稳定硬件标识（不落盘明文到业务路径以外）。
 *
 * - macOS：IOPlatformUUID
 * - Windows：MachineGuid
 * - Linux：/etc/machine-id（或 dbus 回退）
 *
 * 读失败返回 null，由调用方回退到随机 fingerprint（旧行为）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { createLogger } from '../logger'

const log = createLogger('MachineId')

let cached: string | null | undefined

function readDarwinMachineId(): string | null {
  try {
    const out = execFileSync(
      'ioreg',
      ['-rd1', '-c', 'IOPlatformExpertDevice'],
      { encoding: 'utf8', timeout: 5_000 },
    )
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    return match?.[1]?.trim() || null
  } catch (err) {
    log.warn('read darwin machine id failed:', err)
    return null
  }
}

function readWindowsMachineId(): string | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 5_000 },
    )
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)
    return match?.[1]?.trim() || null
  } catch (err) {
    log.warn('read windows machine id failed:', err)
    return null
  }
}

function readLinuxMachineId(): string | null {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // try next
    }
  }
  return null
}

/** 原始机标识（可能含 UUID 形态）；调用方应再 hash 后再上报/落盘。 */
export function getRawMachineId(): string | null {
  if (cached !== undefined) return cached

  const os = platform()
  let value: string | null = null
  if (os === 'darwin') value = readDarwinMachineId()
  else if (os === 'win32') value = readWindowsMachineId()
  else if (os === 'linux') value = readLinuxMachineId()

  cached = value && value.length > 0 ? value : null
  return cached
}

/** 测试用：重置缓存；可注入固定值。 */
export function _resetRawMachineIdCacheForTests(next?: string | null): void {
  cached = next === undefined ? undefined : next
}

/**
 * 主机硬件 / 运行时架构采集（诊断包 meta.json 用）
 *
 * 主进程采集：CPU 型号、Rosetta 状态、进程架构等——渲染进程拿不到 sysctl。
 */

import os from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import type { DiagnosticsHostEnv } from '../../shared/diagnostics-types'

export type { DiagnosticsHostEnv }

function readSysctl(key: string): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', key], { encoding: 'utf8', timeout: 2000 })
    return out.trim() || null
  } catch {
    return null
  }
}

function parseSysctlInt(raw: string | null): number | null {
  if (raw == null || raw === '') return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

export function buildRuntimeLabel(
  platform: string,
  processArch: string,
  macTranslated: number | null,
): string {
  if (platform === 'darwin') {
    if (processArch === 'arm64') return 'apple-silicon-native'
    if (processArch === 'x64' && macTranslated === 1) return 'x64-rosetta-on-apple-silicon'
    if (processArch === 'x64') return 'intel-native'
  }
  if (platform === 'win32') return `windows-${processArch}`
  if (platform === 'linux') return `linux-${processArch}`
  return `${platform}-${processArch}`
}

export function collectHostEnv(execPath: string = process.execPath): DiagnosticsHostEnv {
  const platform = process.platform
  const processArch = process.arch

  let cpuBrand: string | null = null
  if (platform === 'darwin') {
    cpuBrand = readSysctl('machdep.cpu.brand_string')
  }
  if (!cpuBrand) {
    const cpus = os.cpus()
    cpuBrand = cpus.length > 0 ? cpus[0].model.trim() || null : null
  }

  const macTranslated = platform === 'darwin'
    ? parseSysctlInt(readSysctl('sysctl.proc_translated'))
    : null
  const macSupportsArm64 = platform === 'darwin'
    ? parseSysctlInt(readSysctl('hw.optional.arm64'))
    : null
  const osBuild = platform === 'darwin'
    ? readSysctl('kern.osversion')
    : null

  return {
    processArch,
    platform,
    cpuBrand,
    macTranslated,
    macSupportsArm64,
    osBuild,
    execBasename: path.basename(execPath) || 'TabTin',
    runtimeLabel: buildRuntimeLabel(platform, processArch, macTranslated),
  }
}

import { describe, it, expect } from 'vitest'
import { buildRuntimeLabel, collectHostEnv } from '../collect-host-env'

describe('buildRuntimeLabel', () => {
  it('darwin arm64 → apple-silicon-native', () => {
    expect(buildRuntimeLabel('darwin', 'arm64', 0)).toBe('apple-silicon-native')
  })

  it('darwin x64 Rosetta → x64-rosetta-on-apple-silicon', () => {
    expect(buildRuntimeLabel('darwin', 'x64', 1)).toBe('x64-rosetta-on-apple-silicon')
  })

  it('darwin x64 native → intel-native', () => {
    expect(buildRuntimeLabel('darwin', 'x64', 0)).toBe('intel-native')
  })

  it('win32 x64', () => {
    expect(buildRuntimeLabel('win32', 'x64', null)).toBe('windows-x64')
  })
})

describe('collectHostEnv', () => {
  it('返回必需字段且 processArch 与当前进程一致', () => {
    const env = collectHostEnv('/Applications/TabTin.app/Contents/MacOS/TabTin')
    expect(env.processArch).toBe(process.arch)
    expect(env.platform).toBe(process.platform)
    expect(env.execBasename).toBe('TabTin')
    expect(env.runtimeLabel).toMatch(/native|rosetta|windows-|linux-/)
  })
})

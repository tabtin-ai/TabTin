import { describe, expect, it } from 'vitest'
import {
  initHostCapabilityIdentity,
  shouldRewarmAfterCapabilityIdentityInit,
  type HostCapabilityIdentityInitPorts,
} from '../host-capability-identity-init.js'

function createPorts(): HostCapabilityIdentityInitPorts & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    resetCatalog: () => { calls.push('resetCatalog') },
    invalidateAllSkillEnablement: () => { calls.push('invalidateAllSkillEnablement') },
    invalidateCliListingGate: () => { calls.push('invalidateCliListingGate') },
    clearHostTurn: () => { calls.push('clearHostTurn') },
    clearPrewarmPending: () => { calls.push('clearPrewarmPending') },
    invalidateUserPortrait: () => { calls.push('invalidateUserPortrait') },
    logInfo: (message, meta) => { calls.push(`log:${message}:${meta?.reason ?? ''}`) },
  }
}

describe('initHostCapabilityIdentity ', () => {
  it('按固定顺序失效全部常驻能力缓存', () => {
    const ports = createPorts()
    initHostCapabilityIdentity('organization-switch', ports)
    expect(ports.calls.filter((c) => !c.startsWith('log:'))).toEqual([
      'resetCatalog',
      'invalidateAllSkillEnablement',
      'invalidateCliListingGate',
      'clearHostTurn',
      'clearPrewarmPending',
      'invalidateUserPortrait',
    ])
    expect(ports.calls.at(-1)).toBe('log:[CapabilityIdentity] init:organization-switch')
  })

  it('登出后不应再暖；登录 / 切组织 / auth-changed / manual 应再暖', () => {
    expect(shouldRewarmAfterCapabilityIdentityInit('logout')).toBe(false)
    expect(shouldRewarmAfterCapabilityIdentityInit('login')).toBe(true)
    expect(shouldRewarmAfterCapabilityIdentityInit('organization-switch')).toBe(true)
    expect(shouldRewarmAfterCapabilityIdentityInit('auth-changed')).toBe(true)
    expect(shouldRewarmAfterCapabilityIdentityInit('manual')).toBe(true)
  })

  it('logInfo 可选，缺省不抛', () => {
    const ports = createPorts()
    delete (ports as { logInfo?: typeof ports.logInfo }).logInfo
    expect(() => initHostCapabilityIdentity('manual', ports)).not.toThrow()
  })
})

describe('ElectronAgentHost wiring  source contract', () => {
  it('host 暴露 initCapabilityIdentity 并挂 auth / IPC / reset-account-sync', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const hostPath = path.resolve(
      import.meta.dirname,
      '../../ElectronAgentHost.ts',
    )
    const source = fs.readFileSync(hostPath, 'utf8')
    expect(source).toContain('initCapabilityIdentity')
    expect(source).toContain('handleCapabilityIdentityAuthChanged')
    expect(source).toContain('agent-engine:init-capability-identity')
    expect(source).toContain("await this.initCapabilityIdentity('logout')")
    expect(source).toContain('invalidateCliListingGateCache()')
    expect(source).toContain('catalog.reset()')
    expect(source).toContain('prewarm.clearPending()')
    // 新 channel 走 ipc-shim envelope，禁止裸 {success} 被 LEGACY_SHAPE 打回
    expect(source).toContain('ok: true')
    expect(source).toContain('data: { success: true, rewarmed }')
  })
})

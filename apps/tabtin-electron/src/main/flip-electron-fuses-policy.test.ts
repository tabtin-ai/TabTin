import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createFusePolicy,
  resolveFuseProfile,
} = require('../../scripts/flip-electron-fuses.cjs')

describe('flip-electron-fuses profile policy', () => {
  it('locks down preprod and production fuses', () => {
    for (const profile of ['preprod', 'production']) {
      const policy = createFusePolicy({ TABTIN_BUILD_PROFILE: profile })
      expect(policy.profile).toBe(profile)
      expect(policy.runAsNode).toBe(false)
      expect(policy.enableNodeOptionsEnvironmentVariable).toBe(false)
      expect(policy.enableNodeCliInspectArguments).toBe(false)
      expect(policy.enableEmbeddedAsarIntegrityValidation).toBe(true)
      expect(policy.onlyLoadAppFromAsar).toBe(true)
    }
  })

  it('keeps local/development debug fuses profile-scoped', () => {
    expect(createFusePolicy({ TABTIN_BUILD_PROFILE: 'local' }).runAsNode).toBe(true)
    expect(createFusePolicy({ NODE_ENV: 'development' }).enableNodeCliInspectArguments).toBe(true)
    expect(createFusePolicy({ TABTIN_BUILD_PROFILE: 'local', TABTIN_ENABLE_NODE_INSPECT_FUSE: '0' }).enableNodeCliInspectArguments).toBe(false)
  })

  it('resolves explicit fuse profile before runtime/build profile', () => {
    expect(resolveFuseProfile({
      TABTIN_ELECTRON_FUSE_PROFILE: 'production',
      TABTIN_RUNTIME_PROFILE: 'local',
      TABTIN_BUILD_PROFILE: 'local',
    })).toBe('production')
  })
})

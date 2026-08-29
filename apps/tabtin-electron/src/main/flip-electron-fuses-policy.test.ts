import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createFusePolicy,
  createWindowsAsarIntegrityList,
  resolveFuseProfile,
  restoreWindowsAsarIntegrity,
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

  it('restores Windows ASAR integrity after the fuse rewrite', async () => {
    const calls: Array<{ kind: string; value: unknown }> = []
    const asarIntegrity = {
      'resources/app.asar': { algorithm: 'SHA256', hash: 'header-hash' },
    }

    await restoreWindowsAsarIntegrity('/pack/tabtin-community.exe', {
      computeData: async (options: unknown) => {
        calls.push({ kind: 'compute', value: options })
        return asarIntegrity
      },
      writeWindowsAsarIntegrityResource: async (exePath: string, integrity: unknown) => {
        calls.push({ kind: 'write', value: { exePath, integrity } })
      },
    })

    expect(calls).toEqual([
      {
        kind: 'compute',
        value: {
          resourcesPath: '/pack/resources',
          resourcesRelativePath: 'resources',
        },
      },
      {
        kind: 'write',
        value: {
          exePath: '/pack/tabtin-community.exe',
          integrity: asarIntegrity,
        },
      },
    ])

    expect(createWindowsAsarIntegrityList(asarIntegrity)).toEqual([
      {
        file: 'resources\\app.asar',
        alg: 'SHA256',
        value: 'header-hash',
      },
    ])
  })
})

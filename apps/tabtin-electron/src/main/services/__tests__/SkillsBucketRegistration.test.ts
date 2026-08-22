/**
 * SkillsBucketRegistration · W2.2 G1 守护测试
 *
 * 守住的核心约束：
 *   1. registerSkillsPreinstalledBucket() 注册的 bucket id / category / group
 *      必须严格符合 RFC §五（W2.2 G1 表）：
 *        - id = 'skills:preinstalled'
 *        - category = 'semi-cache'
 *        - group = 'business-app'
 *        - requiresConfirmation = 'soft'
 *   2. 没有 `{dataRoot}/users/` 目录时 sizeFn 返回 0 / 0、listFn 返回 []，不抛错
 *   3. 注册函数本身幂等：连续两次调用，第二次会因 BucketAlreadyRegisteredError
 *      被吞掉，仍返回 unregister 函数（不抛到调用方）
 *
 * （硬切）：不再 mock legacy `getPlatformDataRoot` / `resolveSpaceSkillsDir`，
 * 改 mock 新布局唯一 SSoT `getDataRoot` / `resolveUserSkillsDir` / `resolveOrganizationSkillsDir`。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── mocks ────────────────────────────────────────────────────────

vi.mock('@tabtin/shared/storage-paths', () => ({
  getDataRoot: vi.fn(() => '/tmp/__nonexistent_tabtin_dataroot_for_test'),
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveUserSkillsDir: (dataRoot: string, userId: string) =>
    `${dataRoot}/users/${userId}/skills`,
  resolveOrganizationSkillsDir: (dataRoot: string, userId: string, orgId: string) =>
    `${dataRoot}/users/${userId}/organizations/${orgId}/skills`,
}))

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

// ── test ────────────────────────────────────────────────────────

describe('SkillsBucketRegistration', () => {
  beforeEach(async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('registerSkillsPreinstalledBucket 注册的 bucket 字段符合 RFC §五', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerSkillsPreinstalledBucket } = await import(
      '../SkillsBucketRegistration'
    )

    registerSkillsPreinstalledBucket()

    const bucket = sm.getBucket('skills:preinstalled')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('semi-cache')
    expect(bucket?.group).toBe('business-app')
    expect(bucket?.requiresConfirmation).toBe('soft')
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
    expect(typeof bucket?.sizeFn).toBe('function')
    expect(typeof bucket?.listFn).toBe('function')
    expect(typeof bucket?.clearFn).toBe('function')
  })

  it('dataRoot/users 目录不存在时 sizeFn / listFn / clearFn dryRun 都返回 0 不抛错', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerSkillsPreinstalledBucket } = await import(
      '../SkillsBucketRegistration'
    )

    registerSkillsPreinstalledBucket()

    const bucket = sm.getBucket('skills:preinstalled')!
    const size = await bucket.sizeFn()
    expect(size.bytes).toBe(0)
    expect(size.itemCount).toBe(0)

    const list = await bucket.listFn!()
    expect(list).toEqual([])

    const dryRun = await bucket.clearFn!({ dryRun: true })
    expect(dryRun.clearedItemCount).toBe(0)
    expect(dryRun.freedBytes).toBe(0)
  })

  it('连续两次注册：第二次的 BucketAlreadyRegisteredError 被吞掉，调用方不抛错', async () => {
    const { registerSkillsPreinstalledBucket } = await import(
      '../SkillsBucketRegistration'
    )

    expect(() => registerSkillsPreinstalledBucket()).not.toThrow()
    expect(() => registerSkillsPreinstalledBucket()).not.toThrow()
  })
})

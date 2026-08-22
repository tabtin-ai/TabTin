/**
 * W3.3 D-5 §4 · main 守护测试：checkpoint:summary-export bucket。
 *
 * 守住：
 *   1. registerCheckpointSummaryExportBucket 后 bucket 字段符合 D-5 §4
 *      （hideFromList=true，data 类，含 exportFn）
 *   2. checkpointsRoot 不存在时 exportFn 仍产出合法 JSON（projects: []）
 *   3. filename 含 ISO timestamp + 不含 git pack 的 metadata
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// 把 checkpointsRoot 指到一个不存在的临时目录，确保测试不依赖真实磁盘
const TEST_ROOT = path.join(os.tmpdir(), '__nonexistent_tabtin_checkpoints_for_w33_test__')

vi.mock('../../checkpoint/CheckpointService', () => ({
  getCurrentUserCheckpointRoots: vi.fn(() => [{
    organizationId: 'org-test',
    checkpointsRoot: TEST_ROOT,
  }]),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('CheckpointSummaryExport · checkpoint:summary-export', () => {
  beforeEach(async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('注册的 bucket 字段符合 D-5 §4 规范', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerCheckpointSummaryExportBucket } = await import(
      '../CheckpointSummaryExport'
    )

    registerCheckpointSummaryExportBucket()

    const bucket = sm.getBucket('checkpoint:summary-export')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('checkpoint')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.hideFromList).toBe(true)
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
    expect(typeof bucket?.exportFn).toBe('function')
    expect(typeof bucket?.sizeFn).toBe('function')
  })

  it('checkpointsRoot 不存在时 exportFn 产出 totalProjects=0 + 合法 JSON', async () => {
    const sm = await import('@tabtin/storage-manager')
    const { registerCheckpointSummaryExportBucket } = await import(
      '../CheckpointSummaryExport'
    )

    registerCheckpointSummaryExportBucket()
    const bucket = sm.getBucket('checkpoint:summary-export')!
    const exp = await bucket.exportFn!()

    expect(exp.mimeType).toBe('application/json')
    expect(exp.filename).toMatch(
      /^tabtin-checkpoint-summary-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z\.json$/,
    )
    const parsed = JSON.parse(exp.data as string)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      source: 'tabtin-electron',
      bucketId: 'checkpoint:summary-export',
      totalProjects: 0,
      totalCommits: 0,
      totalBytes: 0,
    })
    expect(parsed.scope).toBe('current-user-all-organizations')
    expect(parsed.checkpointRoots).toEqual([{
      organizationId: 'org-test',
      checkpointsRoot: TEST_ROOT,
    }])
    expect(parsed.recentCommitsLimitPerProject).toBe(100)
    expect(Array.isArray(parsed.projects)).toBe(true)
    expect(parsed.projects).toHaveLength(0)
    expect(typeof parsed.exportedAt).toBe('string')
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt)

    // 不应包含 .git pack 数据；payload 应只是 JSON 元信息
    expect(exp.data).not.toContain('PACK')
  })
})

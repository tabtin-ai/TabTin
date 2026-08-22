import { beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearRegistry } from '../../surface/registry.js'
import { SurfaceError } from '../../surface/types.js'
import {
  _cliAlias,
  _isFlatRunInput,
  _normalizeRunInput,
  _resolveSince,
  createImportSurfaces,
  type AgentImportRunner,
  type ImportRunInput,
} from '../import.js'

function mockRunner(overrides: Partial<AgentImportRunner> = {}): AgentImportRunner {
  return {
    detect: vi.fn(async () => ({ sources: [] })),
    scan: vi.fn(async () => ({
      source: 'codex',
      workspaces: [],
      orphanSessions: [],
    })),
    run: vi.fn(async () => ({ jobId: 'j1' })),
    status: vi.fn(async () => ({ state: 'completed' as const, progress: { done: 0, total: 0 } })),
    cancel: vi.fn(async () => ({ cancelled: false })),
    rollback: vi.fn(async () => ({ deletedSessions: 0, deletedMessages: 0 })),
    ...overrides,
  }
}

const ctx = {
  djangoRequest: async () => ({ status: 200, data: {} }),
  spaceId: null as string | null,
}

describe('_resolveSince（CLI --since 30d / UI ISO 公共入口）', () => {
  it('相对天数 → 约 N 天前的 ISO', () => {
    const iso = _resolveSince('30d')
    expect(iso).toBeDefined()
    const deltaDays = (Date.now() - Date.parse(iso!)) / 86_400_000
    expect(deltaDays).toBeGreaterThan(29.9)
    expect(deltaDays).toBeLessThan(30.1)
  })

  it('7d / 90d 都支持', () => {
    const d7 = (Date.now() - Date.parse(_resolveSince('7d')!)) / 86_400_000
    const d90 = (Date.now() - Date.parse(_resolveSince('90d')!)) / 86_400_000
    expect(Math.round(d7)).toBe(7)
    expect(Math.round(d90)).toBe(90)
  })

  it('all / 空 → undefined（全量）', () => {
    expect(_resolveSince('all')).toBeUndefined()
    expect(_resolveSince('')).toBeUndefined()
    expect(_resolveSince(undefined)).toBeUndefined()
  })

  it('已是 ISO → 原样透传（UI 直接算 ISO 的路径）', () => {
    const iso = '2026-07-01T00:00:00.000Z'
    expect(_resolveSince(iso)).toBe(iso)
  })
})

describe('_cliAlias（CLI snake_case → camelCase 顶层归一）', () => {
  it('job → jobId', () => {
    expect(_cliAlias<{ jobId?: string }>({ job: 'j1' }).jobId).toBe('j1')
  })

  it('include_archived → includeArchived', () => {
    expect(_cliAlias<{ includeArchived?: boolean }>({ include_archived: false }).includeArchived).toBe(false)
  })

  it('session_ids → sessionIds', () => {
    expect(_cliAlias<{ sessionIds?: string[] }>({ session_ids: ['a'] }).sessionIds).toEqual(['a'])
  })

  it('已是 camelCase → 不覆盖（UI IPC 路径）', () => {
    expect(_cliAlias<{ jobId?: string }>({ jobId: 'ui', job: 'cli' }).jobId).toBe('ui')
  })

  it('非对象 → 原样', () => {
    expect(_cliAlias<null>(null)).toBeNull()
  })
})

describe('_isFlatRunInput / _normalizeRunInput（CLI 扁平 ↔ UI 结构化）', () => {
  it('扁平 CLI 输入被识别', () => {
    expect(_isFlatRunInput({ source: 'codex', organization: 'o', agent: 'a', device: 'd' })).toBe(true)
  })

  it('结构化 UI 输入不被当扁平', () => {
    expect(_isFlatRunInput({ jobId: 'j', sources: [], options: {} })).toBe(false)
  })

  it('扁平 → 结构化：jobId 生成、sources 单项无 refs、options 组装', () => {
    const out = _normalizeRunInput({
      source: 'codex',
      since: '2026-07-01T00:00:00.000Z',
      redact: false,
      organization: 'org-1',
      agent: 'agent-1',
      device: 'device-1',
    })
    expect(out.jobId).toMatch(/[0-9a-f-]{36}/)
    expect(out.sources).toEqual([{ source: 'codex' }]) // sessionRefs 缺省 → runner 自动 scan
    expect(out.options.targetOrganizationId).toBe('org-1')
    expect(out.options.agentId).toBe('agent-1')
    expect(out.options.deviceId).toBe('device-1')
    expect(out.options.redact).toBe(false)
    expect(out.options.since).toBe('2026-07-01T00:00:00.000Z')
  })

  it('扁平输入带 jobId → 沿用不重新生成', () => {
    const out = _normalizeRunInput({
      source: 'cursor', organization: 'o', agent: 'a', device: 'd', jobId: 'fixed-job',
    })
    expect(out.jobId).toBe('fixed-job')
  })

  it('UI 结构化输入原样返回', () => {
    const ui: ImportRunInput = {
      jobId: 'ui-job',
      sources: [{ source: 'claude_code', sessionRefs: [] }],
      options: { targetOrganizationId: 'o', agentId: 'a', deviceId: 'd' },
    }
    expect(_normalizeRunInput(ui)).toBe(ui)
  })
})

describe('importRun surface 校验（HTTP / IPC 共用）', () => {
  beforeEach(() => {
    _clearRegistry()
  })

  it('拒绝非法 targetOrganizationId（含 ../）', async () => {
    const runner = mockRunner()
    const { importRun } = createImportSurfaces(runner)
    await expect(
      importRun.def.handler(
        {
          jobId: 'j1',
          sources: [{ source: 'codex' }],
          options: {
            targetOrganizationId: '../external-archives/org-a',
            agentId: 'a',
            deviceId: 'd',
          },
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SurfaceError)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('拒绝 sessionRef.source 与分组不一致', async () => {
    const runner = mockRunner()
    const { importRun } = createImportSurfaces(runner)
    await expect(
      importRun.def.handler(
        {
          jobId: 'j1',
          sources: [
            {
              source: 'codex',
              sessionRefs: [
                {
                  source: 'cursor',
                  sourceSessionId: 's1',
                  sourcePath: '/tmp/x.jsonl',
                  title: 't',
                  cwd: null,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  archived: false,
                  subagent: false,
                  layer: 'full',
                },
              ],
            },
          ],
          options: { targetOrganizationId: 'org-1', agentId: 'a', deviceId: 'd' },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('合法选择清单可进入 runner（sourcePath 可由客户端携带，runner 侧丢弃）', async () => {
    const runner = mockRunner()
    const { importRun } = createImportSurfaces(runner)
    await importRun.def.handler(
      {
        jobId: 'j1',
        sources: [
          {
            source: 'codex',
            sessionRefs: [
              {
                source: 'codex',
                sourceSessionId: 's1',
                sourcePath: '/tmp/should-be-ignored-by-runner.jsonl',
                title: 't',
                cwd: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                archived: false,
                subagent: false,
                layer: 'full',
              },
            ],
          },
        ],
        options: { targetOrganizationId: 'org-1', agentId: 'a', deviceId: 'd' },
      },
      ctx,
    )
    expect(runner.run).toHaveBeenCalledOnce()
  })
})

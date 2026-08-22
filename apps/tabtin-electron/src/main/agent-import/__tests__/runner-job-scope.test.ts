import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'

const cliOrgMock = vi.hoisted(() => ({
  getCLIOrganizationId: vi.fn((): string | null => 'org-a'),
}))

const agentImportMocks = vi.hoisted(() => {
  const scan = vi.fn(async () => ({
    source: 'codex',
    workspaces: [] as unknown[],
    orphanSessions: [] as unknown[],
  }))
  const parseSession = vi.fn()
  return {
    scan,
    parseSession,
    detectAll: vi.fn(async () => []),
    assertImportSourcePath: vi.fn(),
    getAdapter: vi.fn(() => ({
      scan,
      parseSession,
    })),
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/tabtin-import-job-scope' },
}))

vi.mock('../../cli/cli-context', () => cliOrgMock)

vi.mock('@tabtin/agent-import', () => ({
  NodeImportIO: class {
    constructor(_dir?: string) {}
  },
  detectAll: agentImportMocks.detectAll,
  getAdapter: agentImportMocks.getAdapter,
  assertImportSourcePath: agentImportMocks.assertImportSourcePath,
}))

import { AgentImportRunnerImpl } from '../runner'
import { readIndex } from '../archive-store'

describe('AgentImportRunnerImpl job org scope', () => {
  let runner: AgentImportRunnerImpl
  const emits: unknown[] = []

  beforeEach(() => {
    emits.length = 0
    fs.rmSync('/tmp/tabtin-import-job-scope', { recursive: true, force: true })
    cliOrgMock.getCLIOrganizationId.mockReturnValue('org-a')
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [] as unknown[],
      orphanSessions: [] as unknown[],
    })
    agentImportMocks.parseSession.mockResolvedValue({
      source: 'codex',
      sourceSessionId: 'source-1',
      sourcePath: '/Users/test/.codex/sessions/source-1.jsonl',
      title: 'Imported Codex Session',
      titleSource: 'native',
      cwd: null,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      layer: 'full',
      lossy: false,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      subagents: [],
      unknownRecords: {},
    })
    runner = new AgentImportRunnerImpl({
      attachmentDir: '/tmp/att',
      emitProgress: (payload, owner) => {
        emits.push({ payload, owner })
      },
    })
  })

  it('每次扫描使用独立 IO，避免上次超时熔断污染后续扫描', async () => {
    await runner.scan({ source: 'codex' })
    await runner.scan({ source: 'codex' })

    const firstIo = agentImportMocks.scan.mock.calls[0]?.[0]
    const secondIo = agentImportMocks.scan.mock.calls[1]?.[0]
    expect(firstIo).toBeDefined()
    expect(secondIo).toBeDefined()
    expect(secondIo).not.toBe(firstIo)
  })

  it('跨组织 status / cancel 当作不存在', async () => {
    await runner.run(
      {
        jobId: 'job-org-a',
        sources: [{ source: 'codex' }],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      {
        djangoRequest: async () => ({ status: 200, data: { data: { spaces: [] } } }),
        spaceId: null,
      },
    )

    // 同组织可读
    cliOrgMock.getCLIOrganizationId.mockReturnValue('org-a')
    const ok = await runner.status({ jobId: 'job-org-a' })
    expect(ok.state).toBe('running')

    // 切到另一组织 → 探活失败
    cliOrgMock.getCLIOrganizationId.mockReturnValue('org-b')
    const denied = await runner.status({ jobId: 'job-org-a' })
    expect(denied.state).toBe('error')
    expect(denied.progress).toEqual({ done: 0, total: 0 })

    const cancelDenied = await runner.cancel({ jobId: 'job-org-a' })
    expect(cancelDenied.cancelled).toBe(false)
  })

  it('IPC owner 写入 job，进度回调带 ownerWebContentsId', async () => {
    runner.noteIpcOwnerWebContentsId(42)
    await runner.run(
      {
        jobId: 'job-owner',
        sources: [{ source: 'codex' }],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      {
        djangoRequest: async () => ({ status: 200, data: { data: { spaces: [] } } }),
        spaceId: null,
      },
    )
    expect(runner.getJobOwnerWebContentsId('job-owner')).toBe(42)
  })

  it('按 jobId rollback 会删除本次导入写入的本机档案和新建 Workspace', async () => {
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [
        {
          cwd: '/tmp/project',
          cwdExists: true,
          sessions: [
            {
              source: 'codex',
              sourceSessionId: 'source-1',
              sourcePath: '/Users/test/.codex/sessions/source-1.jsonl',
              title: 'Imported Codex Session',
              titleSource: 'native',
              cwd: '/tmp/project',
              createdAt: '2026-07-27T00:00:00.000Z',
              updatedAt: '2026-07-27T00:00:00.000Z',
              archived: false,
              subagent: false,
              layer: 'full',
            },
          ],
        },
      ],
      orphanSessions: [],
    })
    agentImportMocks.parseSession.mockResolvedValue({
      source: 'codex',
      sourceSessionId: 'source-1',
      sourcePath: '/Users/test/.codex/sessions/source-1.jsonl',
      title: 'Imported Codex Session',
      titleSource: 'native',
      cwd: '/tmp/project',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      layer: 'full',
      lossy: false,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello' }],
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      subagents: [],
      unknownRecords: {},
    })
    const djangoRequest = vi.fn(async (method: string) => {
      if (method === 'POST') {
        return {
          status: 200,
          data: { data: { id: 'workspace-1', name: 'project' } },
        }
      }
      if (method === 'DELETE') {
        return {
          status: 200,
          data: { data: { deleted: true } },
        }
      }
      return { status: 200, data: { data: { workspaces: [] } } }
    })

    await runner.run(
      {
        jobId: 'job-delete',
        sources: [
          {
            source: 'codex',
            sessionRefs: [
              {
                source: 'codex',
                sourceSessionId: 'source-1',
                sourcePath: 'client-supplied-path-is-ignored',
                title: 'Imported Codex Session',
                cwd: '/tmp/project',
                createdAt: '2026-07-27T00:00:00.000Z',
                updatedAt: '2026-07-27T00:00:00.000Z',
                archived: false,
                subagent: false,
                layer: 'full',
              },
            ],
          },
        ],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      {
        djangoRequest,
        spaceId: null,
      },
    )

    for (let i = 0; i < 20; i += 1) {
      const status = await runner.status({ jobId: 'job-delete' })
      if (status.state === 'completed') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(readIndex('org-a')).toHaveLength(1)
    const res = await runner.rollback({ jobId: 'job-delete' }, { djangoRequest, spaceId: null })

    expect(res).toEqual({ deletedSessions: 1, deletedMessages: 0 })
    expect(djangoRequest).toHaveBeenCalledWith(
      'DELETE',
      '/api/context/workspaces/workspace-1?device_id=dev-1',
    )
    expect(readIndex('org-a')).toEqual([])
  })

  it('本地目录已有工作空间时合流导入，不新建、不拒绝', async () => {
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [
        {
          cwd: '/Users/test/shared-project',
          cwdExists: true,
          sessions: [
            {
              source: 'codex',
              sourceSessionId: 'source-merge',
              sourcePath: '/Users/test/.codex/sessions/source-merge.jsonl',
              title: 'Merge Into Existing',
              titleSource: 'native',
              cwd: '/Users/test/shared-project',
              createdAt: '2026-07-27T00:00:00.000Z',
              updatedAt: '2026-07-27T00:00:00.000Z',
              archived: false,
              subagent: false,
              layer: 'full',
            },
          ],
        },
      ],
      orphanSessions: [],
    })
    agentImportMocks.parseSession.mockResolvedValue({
      source: 'codex',
      sourceSessionId: 'source-merge',
      sourcePath: '/Users/test/.codex/sessions/source-merge.jsonl',
      title: 'Merge Into Existing',
      titleSource: 'native',
      cwd: '/Users/test/shared-project',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      layer: 'full',
      lossy: false,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello from existing cwd' }],
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      subagents: [],
      unknownRecords: {},
    })
    const djangoRequest = vi.fn(async (method: string) => {
      if (method === 'POST') {
        throw new Error('不应新建 Workspace')
      }
      return {
        status: 200,
        data: {
          data: {
            workspaces: [
              {
                id: 'ws-existing',
                name: 'shared-project',
                device_id: 'dev-1',
                working_dir: '/Users/test/shared-project/',
              },
            ],
          },
        },
      }
    })

    await runner.run(
      {
        jobId: 'job-merge-existing',
        sources: [
          {
            source: 'codex',
            sessionRefs: [
              {
                source: 'codex',
                sourceSessionId: 'source-merge',
                sourcePath: 'ignored',
                title: 'Merge Into Existing',
                cwd: '/Users/test/shared-project',
                createdAt: '2026-07-27T00:00:00.000Z',
                updatedAt: '2026-07-27T00:00:00.000Z',
                archived: false,
                subagent: false,
                layer: 'full',
              },
            ],
          },
        ],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      { djangoRequest, spaceId: null },
    )

    for (let i = 0; i < 20; i += 1) {
      const status = await runner.status({ jobId: 'job-merge-existing' })
      if (status.state === 'completed' || status.state === 'error') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const status = await runner.status({ jobId: 'job-merge-existing' })
    expect(status.state).toBe('completed')
    expect(status.report?.visible).toBe(1)
    expect(status.report?.skipped).toBe(0)
    expect(status.report?.failures ?? []).toEqual([])
    expect(djangoRequest).not.toHaveBeenCalledWith(
      'POST',
      expect.anything(),
      expect.anything(),
    )

    const index = readIndex('org-a')
    expect(index).toHaveLength(1)
    expect(index[0]?.workspaceId).toBe('ws-existing')
    expect(index[0]?.sourceSessionId).toBe('source-merge')
  })

  it('外部目录是已有工作空间的子目录时合流到最长父级，不新建 Workspace', async () => {
    const importedCwd = '/Users/test/project/packages/app'
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [
        {
          cwd: importedCwd,
          cwdExists: true,
          sessions: [
            {
              source: 'codex',
              sourceSessionId: 'source-prefix-merge',
              sourcePath: '/Users/test/.codex/sessions/source-prefix-merge.jsonl',
              title: 'Merge Into Longest Parent',
              titleSource: 'native',
              cwd: importedCwd,
              createdAt: '2026-07-27T00:00:00.000Z',
              updatedAt: '2026-07-27T00:00:00.000Z',
              archived: false,
              subagent: false,
              layer: 'full',
            },
          ],
        },
      ],
      orphanSessions: [],
    })
    agentImportMocks.parseSession.mockResolvedValue({
      source: 'codex',
      sourceSessionId: 'source-prefix-merge',
      sourcePath: '/Users/test/.codex/sessions/source-prefix-merge.jsonl',
      title: 'Merge Into Longest Parent',
      titleSource: 'native',
      cwd: importedCwd,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      layer: 'full',
      lossy: false,
      messages: [
        {
          id: 'msg-prefix',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello from nested cwd' }],
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      subagents: [],
      unknownRecords: {},
    })

    const djangoRequest = vi.fn(async (method: string) => {
      if (method === 'POST') throw new Error('不应新建 Workspace')
      return {
        status: 200,
        data: {
          data: {
            workspaces: [
              {
                id: 'ws-project',
                name: 'project',
                device_id: 'dev-1',
                working_dir: '/Users/test/project',
              },
              {
                id: 'ws-packages',
                name: 'packages',
                device_id: 'dev-1',
                working_dir: '/Users/test/project/packages/',
              },
            ],
          },
        },
      }
    })

    await runner.run(
      {
        jobId: 'job-prefix-merge',
        sources: [
          {
            source: 'codex',
            sessionRefs: [
              {
                source: 'codex',
                sourceSessionId: 'source-prefix-merge',
                sourcePath: 'ignored',
                title: 'Merge Into Longest Parent',
                cwd: importedCwd,
                createdAt: '2026-07-27T00:00:00.000Z',
                updatedAt: '2026-07-27T00:00:00.000Z',
                archived: false,
                subagent: false,
                layer: 'full',
              },
            ],
          },
        ],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      { djangoRequest, spaceId: null },
    )

    for (let i = 0; i < 20; i += 1) {
      const status = await runner.status({ jobId: 'job-prefix-merge' })
      if (status.state === 'completed' || status.state === 'error') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const status = await runner.status({ jobId: 'job-prefix-merge' })
    expect(status.state).toBe('completed')
    expect(status.report?.visible).toBe(1)
    expect(status.report?.failures ?? []).toEqual([])
    expect(djangoRequest).not.toHaveBeenCalledWith(
      'POST',
      expect.anything(),
      expect.anything(),
    )

    const index = readIndex('org-a')
    expect(index).toHaveLength(1)
    expect(index[0]?.workspaceId).toBe('ws-packages')
  })

  it('同批子目录排在父目录前时仍先创建父 Workspace，再合流子目录', async () => {
    const parentCwd = '/Users/test/project'
    const childCwd = `${parentCwd}/packages/app`
    const parentRef = {
      source: 'codex' as const,
      sourceSessionId: 'source-parent',
      sourcePath: '/Users/test/.codex/sessions/source-parent.jsonl',
      title: 'Parent Session',
      titleSource: 'native' as const,
      cwd: parentCwd,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      subagent: false,
      layer: 'full' as const,
    }
    const childRef = {
      ...parentRef,
      sourceSessionId: 'source-child',
      sourcePath: '/Users/test/.codex/sessions/source-child.jsonl',
      title: 'Child Session',
      cwd: childCwd,
    }
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [
        { cwd: childCwd, cwdExists: true, sessions: [childRef] },
        { cwd: parentCwd, cwdExists: true, sessions: [parentRef] },
      ],
      orphanSessions: [],
    })
    agentImportMocks.parseSession.mockImplementation(
      async (_io: unknown, ref: { sourceSessionId: string; sourcePath: string; title: string; cwd: string }) => ({
        source: 'codex',
        sourceSessionId: ref.sourceSessionId,
        sourcePath: ref.sourcePath,
        title: ref.title,
        titleSource: 'native',
        cwd: ref.cwd,
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        archived: false,
        layer: 'full',
        lossy: false,
        messages: [
          {
            id: `msg-${ref.sourceSessionId}`,
            role: 'user',
            blocks: [{ type: 'text', text: ref.title }],
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ],
        subagents: [],
        unknownRecords: {},
      }),
    )

    const createdDirs: string[] = []
    const djangoRequest = vi.fn(async (method: string, _path: string, body?: { working_dir?: string }) => {
      if (method === 'POST') {
        const workingDir = body?.working_dir ?? ''
        createdDirs.push(workingDir)
        if (workingDir !== parentCwd) throw new Error(`不应先创建子目录：${workingDir}`)
        return { status: 200, data: { data: { id: 'ws-parent', name: 'project' } } }
      }
      return { status: 200, data: { data: { workspaces: [] } } }
    })

    await runner.run(
      {
        jobId: 'job-parent-first',
        sources: [{ source: 'codex', sessionRefs: [childRef, parentRef] }],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      { djangoRequest, spaceId: null },
    )

    for (let i = 0; i < 20; i += 1) {
      const status = await runner.status({ jobId: 'job-parent-first' })
      if (status.state === 'completed' || status.state === 'error') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const status = await runner.status({ jobId: 'job-parent-first' })
    expect(status.report?.visible).toBe(2)
    expect(status.report?.failures ?? []).toEqual([])
    expect(createdDirs).toEqual([parentCwd])
    expect(readIndex('org-a').map((item) => item.workspaceId)).toEqual(['ws-parent', 'ws-parent'])
  })

  it('创建撞 WORKING_DIR_CONFLICT 时刷新列表合流，rollback 不删已有 Workspace', async () => {
    agentImportMocks.scan.mockResolvedValue({
      source: 'codex',
      workspaces: [
        {
          cwd: '/Users/test/race-project',
          cwdExists: true,
          sessions: [
            {
              source: 'codex',
              sourceSessionId: 'source-race',
              sourcePath: '/Users/test/.codex/sessions/source-race.jsonl',
              title: 'Race Merge',
              titleSource: 'native',
              cwd: '/Users/test/race-project',
              createdAt: '2026-07-27T00:00:00.000Z',
              updatedAt: '2026-07-27T00:00:00.000Z',
              archived: false,
              subagent: false,
              layer: 'full',
            },
          ],
        },
      ],
      orphanSessions: [],
    })
    agentImportMocks.parseSession.mockResolvedValue({
      source: 'codex',
      sourceSessionId: 'source-race',
      sourcePath: '/Users/test/.codex/sessions/source-race.jsonl',
      title: 'Race Merge',
      titleSource: 'native',
      cwd: '/Users/test/race-project',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      archived: false,
      layer: 'full',
      lossy: false,
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello race' }],
          createdAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      subagents: [],
      unknownRecords: {},
    })

    let listCalls = 0
    const djangoRequest = vi.fn(async (method: string) => {
      if (method === 'GET') {
        listCalls += 1
        if (listCalls === 1) {
          return { status: 200, data: { data: { workspaces: [] } } }
        }
        return {
          status: 200,
          data: {
            data: {
              workspaces: [
                {
                  id: 'ws-preexisting',
                  name: 'race-project',
                  device_id: 'dev-1',
                  working_dir: '/Users/test/race-project',
                },
              ],
            },
          },
        }
      }
      if (method === 'POST') {
        return { status: 409, data: { data: { code: 'WORKING_DIR_CONFLICT' } } }
      }
      if (method === 'DELETE') {
        throw new Error('不应删除已有 Workspace')
      }
      return { status: 200, data: { data: {} } }
    })

    await runner.run(
      {
        jobId: 'job-race-409',
        sources: [
          {
            source: 'codex',
            sessionRefs: [
              {
                source: 'codex',
                sourceSessionId: 'source-race',
                sourcePath: 'ignored',
                title: 'Race Merge',
                cwd: '/Users/test/race-project',
                createdAt: '2026-07-27T00:00:00.000Z',
                updatedAt: '2026-07-27T00:00:00.000Z',
                archived: false,
                subagent: false,
                layer: 'full',
              },
            ],
          },
        ],
        options: {
          targetOrganizationId: 'org-a',
          agentId: 'agent-1',
          deviceId: 'dev-1',
        },
      },
      { djangoRequest, spaceId: null },
    )

    for (let i = 0; i < 20; i += 1) {
      const status = await runner.status({ jobId: 'job-race-409' })
      if (status.state === 'completed' || status.state === 'error') break
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const status = await runner.status({ jobId: 'job-race-409' })
    expect(status.state).toBe('completed')
    expect(status.report?.visible).toBe(1)
    expect(status.report?.failures ?? []).toEqual([])
    expect(listCalls).toBeGreaterThanOrEqual(2)
    expect(djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/context/workspaces',
      expect.objectContaining({ working_dir: '/Users/test/race-project' }),
    )

    const index = readIndex('org-a')
    expect(index).toHaveLength(1)
    expect(index[0]?.workspaceId).toBe('ws-preexisting')

    const res = await runner.rollback({ jobId: 'job-race-409' }, { djangoRequest, spaceId: null })
    expect(res).toEqual({ deletedSessions: 1, deletedMessages: 0 })
    expect(djangoRequest).not.toHaveBeenCalledWith(
      'DELETE',
      expect.stringContaining('/api/context/workspaces/'),
    )
    expect(readIndex('org-a')).toEqual([])
  })
})

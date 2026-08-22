/**
 * notifyWorkspacePaths helper · 单根契约行为钉死
 *
 * 验证（见 docs/single-root-space-prd.md §2.2）：
 *   1. spaceId 缺失时不发 IPC（fail-closed）
 *   2. 推送 payload `{ spaceId, workingDir }`，从 useSpaceStore 读 Space/Agent 执行根
 *   3. 无执行根时推空字符串（让 main 端 derive 退化到 sandbox）
 *   4. 多 Space：A 的推送只读 A 的 agent，不污染 B
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const notifyMock = vi.fn()

vi.stubGlobal('window', {
  tabtin: {
    workspace: { notifyPathsChanged: notifyMock },
  },
})

// Mock useSpaceStore 以注入 spaces / agentCache / selectedAgent / loadAgent。
const spaceStoreState = {
  spaces: [] as Array<{
    id: string
    type: 'workspace' | 'organization'
    agent_id?: string | null
    execution_agent_id?: string | null
    working_dir?: string
  }>,
  agentCache: {} as Record<string, { working_dir?: string; name?: string } | undefined>,
  selectedAgent: null as { working_dir?: string; name?: string } | null,
  loadAgent: vi.fn(
    async (_agentId: string): Promise<{ working_dir?: string; name?: string } | null> => null,
  ),
}

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceStoreState,
  },
}))

import { notifyWorkspacePathsForSpace } from '../notifyWorkspacePaths'

function resetSpaceStore() {
  spaceStoreState.spaces = []
  spaceStoreState.agentCache = {}
  spaceStoreState.selectedAgent = null
  spaceStoreState.loadAgent = vi.fn(
    async (_agentId: string): Promise<{ working_dir?: string; name?: string } | null> => null,
  )
}

describe('notifyWorkspacePathsForSpace · 单根契约', () => {
  beforeEach(() => {
    notifyMock.mockClear()
    resetSpaceStore()
  })

  afterEach(() => {
    notifyMock.mockClear()
  })

  it('spaceId 为空字符串 → 不发 IPC（fail-closed）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await notifyWorkspacePathsForSpace('')
    expect(notifyMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('spaceId 有值 + spaces 找不到 → workingDir 推空字符串', async () => {
    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '',
    })
  })

  it('从 useSpaceStore 读 agent.working_dir 推送', async () => {
    spaceStoreState.spaces = [
      { id: 'space-A', type: 'workspace', agent_id: 'agent-1' },
    ]
    spaceStoreState.agentCache = {
      'agent-1': { working_dir: '/Users/me/dev/proj-A' },
    }

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '/Users/me/dev/proj-A',
    })
  })

  it('优先 execution_agent_id 而非 agent_id', async () => {
    spaceStoreState.spaces = [
      {
        id: 'space-A',
        type: 'workspace',
        agent_id: 'agent-owner',
        execution_agent_id: 'agent-exec',
      },
    ]
    spaceStoreState.agentCache = {
      'agent-exec': { working_dir: '/tmp/exec-root' },
      'agent-owner': { working_dir: '/tmp/owner-root' },
    }

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '/tmp/exec-root',
    })
  })

  it('Space 暂无 agent_id 时从 space.working_dir 推送', async () => {
    spaceStoreState.spaces = [
      {
        id: 'space-A',
        type: 'workspace',
        agent_id: null,
        working_dir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
      },
    ]

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: 'C:\\Users\\me\\Downloads\\VoiceSync-Windows-0.3.1',
    })
  })

  it('Agent 已加载但没设 working_dir → 推空字符串（不被 Space fallback 掩盖）', async () => {
    spaceStoreState.spaces = [
      {
        id: 'space-A',
        type: 'workspace',
        agent_id: 'agent-1',
        working_dir: '/tmp/space-fallback',
      },
    ]
    spaceStoreState.agentCache = {
      'agent-1': { working_dir: '' },
    }

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '',
    })
  })

  it('agentCache 缺失 + loadAgent 成功 → 用 loaded agent.working_dir', async () => {
    // 修复用户报告：从侧边栏右键 Agent → 设置 → 授权策略，agentCache 没缓存
    // 这个 Space 的 agent，selectedAgent 是其他 Space 的（甚至 null）。
    // 原状直接退到 selectedAgent 推空 → main 端 workingDir 被清空。
    // 修复后 cache miss 时主动 loadAgent 拉 Django 拿权威 working_dir。
    spaceStoreState.spaces = [
      { id: 'space-A', type: 'workspace', agent_id: 'agent-1' },
    ]
    spaceStoreState.agentCache = {}
    spaceStoreState.selectedAgent = null
    spaceStoreState.loadAgent = vi.fn(async () => ({
      working_dir: '/tmp/from-load-agent',
    }))

    await notifyWorkspacePathsForSpace('space-A')

    expect(spaceStoreState.loadAgent).toHaveBeenCalledWith('agent-1')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '/tmp/from-load-agent',
    })
  })

  it('agentCache 缺失 + loadAgent 失败 → fallback 到 selectedAgent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    spaceStoreState.spaces = [
      { id: 'space-A', type: 'workspace', agent_id: 'agent-1' },
    ]
    spaceStoreState.agentCache = {}
    spaceStoreState.selectedAgent = { working_dir: '/tmp/selected-agent' }
    spaceStoreState.loadAgent = vi.fn(async () => {
      throw new Error('network down')
    })

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-A',
      workingDir: '/tmp/selected-agent',
    })
    warnSpy.mockRestore()
  })

  it('非 bot 类型 Space → workingDir 永远空（不读 agent）', async () => {
    spaceStoreState.spaces = [
      { id: 'space-WT', type: 'organization' },
    ]
    spaceStoreState.selectedAgent = { working_dir: '/should/not/be/used' }

    await notifyWorkspacePathsForSpace('space-WT')
    expect(notifyMock).toHaveBeenCalledWith({
      spaceId: 'space-WT',
      workingDir: '',
    })
  })

  it('多 Space 隔离：A 的 agent 改 working_dir 不影响 B 的推送', async () => {
    spaceStoreState.spaces = [
      { id: 'space-A', type: 'workspace', agent_id: 'agent-A' },
      { id: 'space-B', type: 'workspace', agent_id: 'agent-B' },
    ]
    spaceStoreState.agentCache = {
      'agent-A': { working_dir: '/tmp/A' },
      'agent-B': { working_dir: '/tmp/B' },
    }

    await notifyWorkspacePathsForSpace('space-A')
    expect(notifyMock).toHaveBeenLastCalledWith({
      spaceId: 'space-A',
      workingDir: '/tmp/A',
    })

    await notifyWorkspacePathsForSpace('space-B')
    expect(notifyMock).toHaveBeenLastCalledWith({
      spaceId: 'space-B',
      workingDir: '/tmp/B',
    })
  })
})

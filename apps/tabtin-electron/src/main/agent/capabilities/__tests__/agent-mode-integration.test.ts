/**
 * W1-A 集成回归测试 — 验证 ElectronToolProvider 在不同 agentMode 下暴露给 LLM
 * 的工具集与 system prompt 段符合方案约束。
 *
 * 这是 Wave 1-A 的"产品承诺兑现"测试：用户在 ChatInput 切到 Plan 模式后，
 * 模型实际看到的工具列表 / 提示词必须真的不一样，而不是纯装饰。
 *
 * 测试边界：
 *   - 不依赖 Electron 主进程 API（没有 ipcMain / app.getPath）
 *   - 直接构造 ElectronToolProvider 并断言 getTools() 输出
 *   - 不真正发起 LLM 请求，仅校验工具集 / prompt 段的形状
 *
 * 由于 ElectronToolProvider 通过 `services/local-mcp-agent-tools` 间接拉入
 * main 进程模块（electron-log → electron app），这里通过 vi.mock 隔离它们。
 */

import { describe, it, expect, vi } from 'vitest'

// 必须在 import ElectronToolProvider 之前 mock 所有 main 进程依赖。
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}))
vi.mock('electron-log', () => {
  const noop = () => {}
  const logObj = { info: noop, warn: noop, error: noop, debug: noop }
  return {
    default: {
      transports: { file: { level: 'info' }, console: { level: 'info' } },
      create: () => logObj,
      scope: () => logObj,
      info: noop, warn: noop, error: noop, debug: noop,
    },
  }
})
vi.mock('../../../services/local-mcp-agent-tools', () => ({
  localMcpAgentTools: [
    {
      name: 'mcp_call_tool',
      description: 'call mcp',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true }),
    },
  ],
}))
vi.mock('../../../services/LocalMcpService', () => ({
  getLocalMcpService: () => ({
    listAttachedServers: () => [],
    onToolCacheInvalidated: () => () => {},
  }),
}))

const { ElectronToolProvider } = await import('../ElectronToolProvider')
type AgentModeName = 'ask' | 'agent' | 'plan' | 'study' | 'group'
const { buildSystemPrompt } = await import('@tabtin/agent-prompt')

/**  WP0：默认 agent 模式 ElectronToolProvider 基线工具名（不含 Cap 合并）。 */
export const ELECTRON_TOOL_PROVIDER_AGENT_MODE_BASELINE = [
  'ask_form',
  'ask_user',
  'credential_lookup',
  'credential_retrieve',
  'delete_file',
  'edit_file',
  'glob_search',
  'grep_search',
  'memory_delete',
  'memory_search',
  'memory_write',
  'parse_document',
  'present_to_user',
  'read_file',
  'save_attachment',
  'show_widget',
  'todo',
  'web_search',
  'write_file',
] as const

// ─── ElectronToolProvider 工具集 ─────────────────────────────────────

describe('ElectronToolProvider × agentMode (W1-A)', () => {
  function makeProvider(mode?: AgentModeName, opts?: {
    memoryEnabled?: boolean
    agentId?: string
    hasAttachedMcpServers?: (agentId: string) => boolean
  }) {
    return new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: mode,
      memoryEnabled: opts?.memoryEnabled,
      agentId: opts?.agentId,
      hasAttachedMcpServers: opts?.hasAttachedMcpServers,
    })
  }

  it('agent mode (default) exposes the full tool set — regression baseline', () => {
    const provider = makeProvider('agent')
    const names = provider.getTools().map((t) => t.name).sort()

    expect(names).toEqual([...ELECTRON_TOOL_PROVIDER_AGENT_MODE_BASELINE])
    // Sanity: removed tools must NOT reappear (regression guard).
    for (const removed of [
      'rag_search',
      'mcp_call_tool',
      'ask_choice',
      'ask_question',
      'request_approval',
      'think',
      'summarize_context',
      'retrieve_tool_result',
      'show_flow_view',
    ]) {
      expect(names, `agent mode must not include removed ${removed}`).not.toContain(removed)
    }
  })

  it('#9665 WP2: memoryEnabled=false drops memory_search/write, keeps memory_delete', () => {
    const names = makeProvider('agent', { memoryEnabled: false }).getTools().map((t) => t.name)
    expect(names).not.toContain('memory_search')
    expect(names).not.toContain('memory_write')
    expect(names).toContain('memory_delete')
  })

  it('#9665 WP3: mcp_call_tool only when agent has attached MCP servers', () => {
    const without = makeProvider('agent', {
      agentId: 'agent-1',
      hasAttachedMcpServers: () => false,
    }).getTools().map((t) => t.name)
    expect(without).not.toContain('mcp_call_tool')

    const withMcp = makeProvider('agent', {
      agentId: 'agent-1',
      hasAttachedMcpServers: () => true,
    }).getTools().map((t) => t.name)
    expect(withMcp).toContain('mcp_call_tool')
  })

  it('only exposes Project task orchestration tools with an explicit Project context', () => {
    const projectProvider = new ElectronToolProvider({
      agentMode: 'agent',
      spaceId: 'member-workspace-1',
      projectId: 'project-1',
      apiBaseUrl: 'https://api.example.com/api',
    })
    const workspaceProvider = new ElectronToolProvider({
      agentMode: 'agent',
      isGroupSpace: true,
      spaceId: 'workspace-1',
      apiBaseUrl: 'https://api.example.com/api',
    })

    expect(projectProvider.getTools().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'project_members_list',
      'project_tasks_list',
      'project_tasks_create',
    ]))
    expect(workspaceProvider.getTools().map(tool => tool.name)).not.toContain('project_tasks_create')
  })

  it('omitting agentMode keeps backward-compatible behavior identical to "agent"', () => {
    const explicit = makeProvider('agent').getTools().map((t) => t.name).sort()
    const implicit = makeProvider().getTools().map((t) => t.name).sort()
    expect(implicit).toEqual(explicit)
  })

  it('plan mode keeps canonical write tools visible but annotates them (v3 identity)', () => {
    // **Agent mode Phase 1（2026-05-27）**：filterToolsForMode 退化为 identity。
    // plan 模式仍把 write_file / edit_file / delete_file 暴露给 LLM，但在
    // description 末尾追加 [Plan mode] mode annotation——让模型从工具列表
    // 看见完整能力边界，调用时由 guard 软拒并返回 remediation。
    const tools = makeProvider('plan').getTools()
    for (const name of ['edit_file', 'write_file', 'delete_file']) {
      const t = tools.find((x) => x.name === name)
      expect(t, `plan mode should still include ${name}`).toBeDefined()
      expect(t?.description, `${name} description has [Plan mode] annotation`)
        .toMatch(/\[Plan mode\]/)
    }
  })

  it('plan mode keeps read-only research tools + todo (no annotation on allowed tools)', () => {
    const tools = makeProvider('plan').getTools()
    const names = new Set(tools.map((t) => t.name))
    for (const expected of [
      'ask_user',
      'ask_form',
      'web_search',
      'read_file',
      'parse_document',
      'todo',
      'present_to_user',
    ]) {
      expect(names, `plan mode should include ${expected}`).toContain(expected)
    }
    // plan 模式对 todo 也走 annotate（restricted）——与 ask 同口径，可见但软拒。
    const todoWrite = tools.find((t) => t.name === 'todo')
    expect(todoWrite?.description).toMatch(/\[Plan mode\]/)
    for (const removed of [
      'summarize_context', 'retrieve_tool_result',
      'ask_choice', 'ask_question',
      'rag_search',
    ]) {
      expect(names, `plan mode must NOT include ${removed}`).not.toContain(removed)
    }
  })

  it('ask mode keeps todo visible but annotates it (Agent mode Phase 1 identity)', () => {
    // **Phase 1**：todo / edit_file 在 ask 模式仍出现在工具列表，但 description
    // 带 [Ask mode] annotation；调用时由 guard 软拒。
    const tools = makeProvider('ask').getTools()
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('todo')).toBe(true)
    expect(names.has('edit_file')).toBe(true)
    expect(names.has('web_search')).toBe(true)
    expect(names.has('parse_document')).toBe(true)

    const todoWrite = tools.find((t) => t.name === 'todo')
    const editFile = tools.find((t) => t.name === 'edit_file')
    expect(todoWrite?.description).toMatch(/\[Ask mode\]/)
    expect(editFile?.description).toMatch(/\[Ask mode\]/)
    // web_search / parse_document 是 read-only 允许项，不应带 annotation
    expect(tools.find((t) => t.name === 'web_search')?.description).not.toMatch(/\[Ask mode\]/)
  })

  it('study mode keeps present_to_user for teaching demos (edit_file visible with annotation)', () => {
    const tools = makeProvider('study').getTools()
    const names = new Set(tools.map((t) => t.name))
    expect(names.has('present_to_user')).toBe(true)
    expect(names.has('todo')).toBe(true)
    // Phase 1：edit_file 仍可见，但 description 带 [Study mode] annotation
    expect(names.has('edit_file')).toBe(true)
    const editFile = tools.find((t) => t.name === 'edit_file')
    expect(editFile?.description).toMatch(/\[Study mode\]/)
    // present_to_user 是 study 明确允许，不带 annotation
    expect(tools.find((t) => t.name === 'present_to_user')?.description)
      .not.toMatch(/\[Study mode\]/)
  })

  it('group mode mirrors agent mode tool set (主 agent 调度自由度)', () => {
    const agentNames = makeProvider('agent').getTools().map((t) => t.name).sort()
    const groupNames = makeProvider('group').getTools().map((t) => t.name).sort()
    expect(groupNames).toEqual(agentNames)
  })

  it('exposes the resolved mode for telemetry / debug', () => {
    expect(makeProvider('plan').getAgentMode()).toBe('plan')
    expect(makeProvider().getAgentMode()).toBe('agent')
    expect(makeProvider('ask').getAgentMode()).toBe('ask')
  })

  it('falls back to "agent" for unknown / malformed mode (向后兼容)', () => {
    // 强转 — 验证 resolveAgentModeName 兜底
    const provider = new ElectronToolProvider({
      securityPreset: 'collaborative',
      agentMode: 'xxxx-not-a-mode' as unknown as AgentModeName,
    })
    expect(provider.getAgentMode()).toBe('agent')
  })
})

// ─── system prompt 段注入 ────────────────────────────────────────────

describe('system prompt assembly × agentMode (W1-A)', () => {
  /**
   * 使用 @tabtin/agent-prompt 的 buildSystemPrompt（SSoT），
   * 与 ElectronAgentHost 实际使用的是同一函数。
   */
  function buildPrompt(mode: AgentModeName): string {
    return buildSystemPrompt({ agentMode: mode })
  }

  it('agent mode prompt has the regular <execution> section, no <agent_mode>', () => {
    const prompt = buildPrompt('agent')
    expect(prompt).toContain('<execution>')
    expect(prompt).not.toContain('<agent_mode>')
  })

  it('plan mode prompt injects <agent_mode> with hard "不能" / "禁止" semantics', () => {
    // P1-3 修复（2026-05-27）：2026-05-11 prompt 中文化后断言改为中文匹配
    // （'Plan mode is active' / 'MUST NOT' → '当前处于 Plan 模式' / '不能'）。
    const prompt = buildPrompt('plan')
    expect(prompt).toContain('<agent_mode>')
    expect(prompt).toMatch(/Plan 模式|当前处于 Plan/)
    expect(prompt).toMatch(/不能|绝不|禁止/)
    // 必须提到二件套工具名（plan_exit 已移除）
    expect(prompt).toContain('plan_create')
    expect(prompt).toContain('plan_update_todos')
    expect(prompt).not.toContain('plan_exit')
    // 必须提到 run_terminal_command / mcp_call_tool 等 deny 项
    expect(prompt).toContain('run_terminal_command')
    expect(prompt).toContain('mcp_call_tool')
  })

  it('plan mode prompt skips the generic <execution> section to avoid conflict', () => {
    const prompt = buildPrompt('plan')
    expect(prompt).not.toContain('<execution>')
  })

  it('ask mode prompt forbids writes and todo', () => {
    // P1-3 修复：'Ask mode is active' / 'MUST NOT' 中文化为 '当前处于 Ask 模式' / '不能'。
    const prompt = buildPrompt('ask')
    expect(prompt).toContain('<agent_mode>')
    expect(prompt).toMatch(/Ask 模式|当前处于 Ask/)
    expect(prompt).toMatch(/不能|绝不|禁止/)
    expect(prompt).not.toContain('<execution>')
  })

  it('study mode prompt mentions teaching workflow', () => {
    // P1-3 修复：'Study mode is active' 中文化为 '当前处于 Study 模式'。
    // Phase 2 F2 修复：study.md 重写为双轨（教学展示主路径 + .md/.canvas.tsx 草稿辅助），
    // 旧"不要承诺写入文档、表格或笔记"短语删除；改用新关键词断言教学色彩 + 双轨。
    const prompt = buildPrompt('study')
    expect(prompt).toMatch(/Study 模式|当前处于 Study/)
    expect(prompt).toContain('show_widget')
    expect(prompt).toContain('present_to_user')
    expect(prompt).toMatch(/AI 私教|教学|苏格拉底/)
    expect(prompt).toMatch(/破坏性/)
    expect(prompt).toMatch(/双轨|草稿|教学展示/)
    expect(prompt).not.toMatch(/`tabdoc`|`tabdata`|`tabmemo`/)
  })

  it('group mode prompt emphasises dispatch-not-execute semantics', () => {
    // 产品文案：内部 id 仍为 group，用户侧为 PMO（项目管理者 / Agent 调度）。
    const prompt = buildPrompt('group')
    expect(prompt).toMatch(/PMO 模式|当前处于 PMO/)
    expect(prompt).toContain('调度')
    expect(prompt).not.toMatch(/Mission 编排者|当前处于 Group 模式/)
  })

  it('safety section is preserved in every mode (不会被 agent_mode 覆盖)', () => {
    for (const mode of ['ask', 'agent', 'plan', 'study', 'group'] as AgentModeName[]) {
      const prompt = buildPrompt(mode)
      expect(prompt, `${mode} mode should still include <safety>`).toContain('<safety>')
    }
  })
})

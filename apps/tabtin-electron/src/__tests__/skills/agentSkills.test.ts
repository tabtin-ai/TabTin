import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'https://test.api' },
  API_ENDPOINTS: { SKILLS: { LOCAL_INDEX: '/api/skills/local-index/' } },
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ accessToken: 'test-token' }) },
}))

import { parseFrontmatter, scanAgentSkills } from '../../renderer/src/skills/agentSkills'
import type { AgentDefinition, SkillIndexEntry } from '../../renderer/src/skills/types'

// ---------------------------------------------------------------------------
// BRA-010: parseFrontmatter supports YAML array syntax
// ---------------------------------------------------------------------------

describe('BRA-010: parseFrontmatter YAML array support', () => {
  it('parses inline YAML array [a, b, c]', () => {
    const lines = ['---', 'tool_domains: [rag, browser, tabdata]', '---', 'body']
    const { data, bodyStart } = parseFrontmatter(lines)
    expect(data.tool_domains).toEqual(['rag', 'browser', 'tabdata'])
    expect(bodyStart).toBe(3)
  })

  it('parses inline YAML array with quoted items', () => {
    const lines = ['---', 'tool_domains: ["rag", \'browser\']', '---']
    const { data } = parseFrontmatter(lines)
    expect(data.tool_domains).toEqual(['rag', 'browser'])
  })

  it('parses multi-line YAML array with - prefix', () => {
    const lines = [
      '---',
      'name: test',
      'tool_domains:',
      '  - rag',
      '  - browser',
      '  - tabdata',
      '---',
      'body',
    ]
    const { data, bodyStart } = parseFrontmatter(lines)
    expect(data.name).toBe('test')
    expect(data.tool_domains).toEqual(['rag', 'browser', 'tabdata'])
    expect(bodyStart).toBe(7)
  })

  it('still parses plain string values correctly', () => {
    const lines = ['---', 'name: My Skill', 'version: 1.0.0', '---']
    const { data } = parseFrontmatter(lines)
    expect(data.name).toBe('My Skill')
    expect(data.version).toBe('1.0.0')
  })

  it('parses empty array as empty list', () => {
    const lines = ['---', 'tool_domains: []', '---']
    const { data } = parseFrontmatter(lines)
    expect(data.tool_domains).toEqual([])
  })

  it('returns empty data for content without frontmatter', () => {
    const lines = ['# Just a heading', 'Some text']
    const { data, bodyStart } = parseFrontmatter(lines)
    expect(data).toEqual({})
    expect(bodyStart).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// BRA-004: AgentDefinition type & SkillIndexEntry.agents field
// ---------------------------------------------------------------------------

describe('BRA-004: AgentDefinition type exists and SkillIndexEntry accepts agents', () => {
  it('AgentDefinition has all BLUEPRINT-required fields', () => {
    const agent: AgentDefinition = {
      filename: 'researcher.md',
      name: 'Researcher',
      description: 'A research agent',
      model: 'sonnet-4.6',
      reply_mode: 'auto',
      tool_domains: ['rag', 'browser'],
    }
    expect(agent.name).toBe('Researcher')
    expect(agent.tool_domains).toEqual(['rag', 'browser'])
  })

  it('SkillIndexEntry can carry agents array', () => {
    const entry: SkillIndexEntry = {
      skill_id: 'test-skill',
      name: 'Test',
      source: 'local_agent',
      agents: [
        { filename: 'writer.md', name: 'Writer' },
        { filename: 'reviewer.md', name: 'Reviewer', tool_domains: ['tabdoc'] },
      ],
    }
    expect(entry.agents).toHaveLength(2)
    expect(entry.agents![1].tool_domains).toEqual(['tabdoc'])
  })
})

// ---------------------------------------------------------------------------
// BRA-001: scanAgentSkills discovers agents/ subdirectory
// ---------------------------------------------------------------------------

describe('BRA-001: scanAgentSkills discovers agents/*.md', () => {
  const RESEARCHER_MD = [
    '---',
    'name: Researcher',
    'description: Deep research agent',
    'model: sonnet-4.6',
    'reply_mode: auto',
    'tool_domains: [rag, browser]',
    '---',
    '',
    'Detailed instructions...',
  ].join('\n')

  const SKILL_MD = [
    '---',
    'name: Deep Research',
    'description: Multi-source research skill',
    'version: 2.0.0',
    '---',
  ].join('\n')

  function setupMockFS(skillDirs: Record<string, { skillMd: string; agents?: Record<string, string> }>) {
    const readDir = vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith('/skills')) {
        return {
          success: true,
          entries: Object.keys(skillDirs).map(name => ({
            name,
            path: `/root/skills/${name}`,
            isDirectory: true,
          })),
        }
      }
      for (const [skillName, skill] of Object.entries(skillDirs)) {
        if (path === `/root/skills/${skillName}/agents`) {
          if (!skill.agents) return { success: false }
          return {
            success: true,
            entries: Object.keys(skill.agents).map(name => ({
              name,
              path: `/root/skills/${skillName}/agents/${name}`,
              isDirectory: false,
            })),
          }
        }
      }
      return { success: false }
    })

    const readFilePreview = vi.fn().mockImplementation(async (path: string) => {
      for (const [skillName, skill] of Object.entries(skillDirs)) {
        if (path === `/root/skills/${skillName}/SKILL.md`) {
          return { success: true, data: { kind: 'text', content: skill.skillMd } }
        }
        if (skill.agents) {
          for (const [agentName, agentContent] of Object.entries(skill.agents)) {
            if (path === `/root/skills/${skillName}/agents/${agentName}`) {
              return { success: true, data: { kind: 'text', content: agentContent } }
            }
          }
        }
      }
      return { success: false }
    })

    Object.defineProperty(window, 'tabtin', {
      value: {
        fileSystem: { readDir, readFilePreview },
      },
      writable: true,
      configurable: true,
    })

    return { readDir, readFilePreview }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('discovers agents/*.md and attaches to skill entry', async () => {
    setupMockFS({
      'deep-research': {
        skillMd: SKILL_MD,
        agents: { 'researcher.md': RESEARCHER_MD },
      },
    })

    const skills = await scanAgentSkills('/root')
    expect(skills).toHaveLength(1)
    expect(skills[0].agents).toBeDefined()
    expect(skills[0].agents).toHaveLength(1)

    const agent = skills[0].agents![0]
    expect(agent.filename).toBe('researcher.md')
    expect(agent.name).toBe('Researcher')
    expect(agent.description).toBe('Deep research agent')
    expect(agent.model).toBe('sonnet-4.6')
    expect(agent.reply_mode).toBe('auto')
    expect(agent.tool_domains).toEqual(['rag', 'browser'])
  })

  it('skill without agents/ dir has no agents field', async () => {
    setupMockFS({
      'simple-skill': { skillMd: SKILL_MD },
    })

    const skills = await scanAgentSkills('/root')
    expect(skills).toHaveLength(1)
    expect(skills[0].agents).toBeUndefined()
  })

  it('skips agent files missing required name field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setupMockFS({
      'bad-agents': {
        skillMd: SKILL_MD,
        agents: {
          'no-name.md': '---\ndescription: missing name\n---\n',
          'good.md': '---\nname: GoodAgent\n---\n',
        },
      },
    })

    const skills = await scanAgentSkills('/root')
    expect(skills[0].agents).toHaveLength(1)
    expect(skills[0].agents![0].name).toBe('GoodAgent')
    // createLogger('Skills').warn → console.warn('[Skills]', '…missing required…', { file })
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skills'),
      expect.stringContaining('missing required'),
      expect.objectContaining({ file: expect.stringContaining('no-name.md') }),
    )
    warnSpy.mockRestore()
  })

  it('ignores non-.md files in agents/ directory', async () => {
    setupMockFS({
      'with-misc': {
        skillMd: SKILL_MD,
        agents: {
          'valid.md': '---\nname: Valid\n---\n',
          'readme.txt': 'not an agent definition',
        },
      },
    })

    const readFilePreview = (window as any).tabtin.fileSystem.readFilePreview
    const skills = await scanAgentSkills('/root')
    expect(skills[0].agents).toHaveLength(1)
    expect(skills[0].agents![0].name).toBe('Valid')
    const calledPaths = readFilePreview.mock.calls.map((c: any[]) => c[0])
    expect(calledPaths).not.toContain(expect.stringContaining('readme.txt'))
  })
})

// Wave 1（PRD V3.3 §11.5，2026-05-02）：BRA-016 syncAgentSkills 错误处理测试
// 已删除——草稿不上云路径废弃，本地索引由主进程 LocalSkillRegistry 直接扫描，
// 不再有 ``syncAgentSkills`` 函数 / ``SKILLS_SYNC_ERROR_EVENT`` 事件。

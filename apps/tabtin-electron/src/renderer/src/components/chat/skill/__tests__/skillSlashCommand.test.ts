import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import {
  buildSlashCommandOptions,
  buildSkillSlashCommandOptions,
  buildSlashCommandToken,
  detectSkillSlashQuery,
  detectUnrecognizedLeadingSlashToken,
  parseLeadingBuiltinSlashCommand,
  parseLeadingSkillSlashCommand,
  replaceSkillSlashToken,
  resolveComposerSkillTokenAtomicDeletion,
  resolveComposerSkillTokenHighlight,
  resolveComposerSkillTokenHighlights,
} from '../skillSlashCommand'

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: overrides.skill_id ?? overrides.slug ?? 'skill-1',
    skill_key: overrides.skill_key ?? `user:${overrides.slug ?? 'skill-1'}`,
    slug: overrides.slug,
    name: overrides.name ?? overrides.slug ?? 'Skill One',
    source: overrides.source ?? 'user',
    installed: overrides.installed ?? true,
    enabled: overrides.enabled,
    // ：斜杠可用需 Agent 子开关；测试默认视为已启用
    agent_enabled: overrides.agent_enabled ?? true,
    description: overrides.description,
    display_name: overrides.display_name,
    ...overrides,
  }
}

describe('skillSlashCommand', () => {
  it('adds and parses builtin /compact independently from Skill commands', () => {
    const options = buildSlashCommandOptions([], 'compact')
    expect(options.map(option => `${option.kind}:${option.token}`)).toEqual(['builtin:/compact'])

    const parsed = parseLeadingBuiltinSlashCommand('/compact 重点保留接口设计', options)
    expect(parsed?.option.command).toBe('compact')
    expect(parsed?.args).toBe('重点保留接口设计')
  })

  it('builds slash tokens from slug and canonical key', () => {
    expect(buildSlashCommandToken(skill({ slug: 'meeting-notes' }))).toBe('/meeting-notes')
    expect(buildSlashCommandToken(skill({ slug: undefined, skill_key: 'app:office/weekly-report' }))).toBe('/weekly-report')
    expect(buildSlashCommandToken(skill({ slug: 'bad slug' }))).toBeNull()
  })

  it('filters unavailable skills and searches by token/name/description', () => {
    const options = buildSkillSlashCommandOptions([
      skill({ slug: 'meeting-notes', name: 'Meeting Notes', description: 'turn meeting into actions' }),
      skill({ slug: 'disabled-skill', enabled: false }),
      skill({ slug: 'agent-disabled', agent_enabled: false }),
      skill({ slug: 'not-carried', agent_enabled: undefined, installed: false }),
      skill({ slug: 'missing-key', skill_key: undefined }),
    ], 'meeting')

    expect(options.map(o => o.token)).toEqual(['/meeting-notes'])
    expect(options[0].canonicalKey).toBe('user:meeting-notes')
  })

  it('includes a locally discovered device skill without an explicit carry link', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'local-discovered',
        skill_key: 'device:local-discovered',
        source: 'device',
        agent_enabled: undefined,
      }),
    ], '', { isDefaultAgent: true })

    expect(options.map(option => option.token)).toEqual(['/local-discovered'])
  })

  it('hides unassigned builtin catalog skills from other personas', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'table-operator',
        skill_key: 'app:tabdata/table-operator',
        source: 'app',
        distribution: 'builtin',
        agent_enabled: undefined,
      }),
      skill({
        slug: 'device-operations',
        skill_key: 'platform:device/operations',
        source: 'platform',
        agent_enabled: false,
      }),
    ], '', { isDefaultAgent: false })

    expect(options).toEqual([])
  })

  it('includes explicitly carried builtin catalog skills for other personas', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'tabcode-operator',
        skill_key: 'app:tabcode/tabcode-operator',
        source: 'app',
        distribution: 'builtin',
        agent_enabled: true,
      }),
      skill({
        slug: 'terminal-operator',
        skill_key: 'app:terminal/terminal-operator',
        source: 'app',
        distribution: 'builtin',
        agent_enabled: true,
      }),
    ], '', { isDefaultAgent: false })

    expect(options.map(option => option.token)).toEqual([
      '/tabcode-operator',
      '/terminal-operator',
    ])
  })

  it('keeps unassigned device skills out of other personas slash menus', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'local-discovered',
        skill_key: 'device:local-discovered',
        source: 'device',
        agent_enabled: undefined,
      }),
    ], '', { isDefaultAgent: false })

    expect(options).toEqual([])
  })

  it('includes an explicitly assigned device skill for other personas', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'local-assigned',
        skill_key: 'device:local-assigned',
        source: 'device',
        agent_enabled: true,
      }),
    ], '', { isDefaultAgent: false })

    expect(options.map(option => option.token)).toEqual(['/local-assigned'])
  })

  it('keeps an explicitly disabled locally discovered device skill out of slash commands', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'local-disabled',
        skill_key: 'device:local-disabled',
        source: 'device',
        agent_enabled: false,
      }),
    ])

    expect(options).toEqual([])
  })

  it('only includes workspace skills carried by the current Agent', () => {
    const available = buildSkillSlashCommandOptions([
      skill({
        slug: 'gitnexus-cli',
        skill_key: 'workspace:.cursor/skills/gitnexus-cli',
        source: 'workspace',
        agent_enabled: true,
        meta: { from_workspace_scan: true },
      }),
      skill({
        slug: 'always-on-ws',
        skill_key: 'workspace:.cursor/skills/always-on-ws',
        source: 'workspace',
        agent_enabled: false,
        meta: { from_workspace_scan: true },
      }),
      skill({
        slug: 'default-on',
        skill_key: 'workspace:.agents/skills/default-on',
        source: 'workspace',
        agent_enabled: undefined,
        meta: { from_workspace_scan: true },
      }),
    ])
    expect(available.map(o => o.token)).toEqual(['/gitnexus-cli'])
  })

  it('detects unrecognized leading slash tokens for send-time guard ', () => {
    const options = buildSlashCommandOptions([
      skill({ slug: 'meeting-notes', skill_key: 'app:office/meeting-notes' }),
    ])
    expect(detectUnrecognizedLeadingSlashToken('/lark-approval 帮我审批', options)).toBe('/lark-approval')
    expect(detectUnrecognizedLeadingSlashToken('/meeting-notes summarize', options)).toBeNull()
    expect(detectUnrecognizedLeadingSlashToken('/compact focus api', options)).toBeNull()
    expect(detectUnrecognizedLeadingSlashToken('普通消息 /looks-like', options)).toBeNull()
  })

  it('keeps builtin visualization skill leaf names without leaking path namespaces', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: undefined,
        skill_id: 'visualization/tabtin-widget',
        skill_key: 'platform:visualization/tabtin-widget',
        name: 'tabtin-widget',
        source: 'platform',
      }),
      skill({
        slug: undefined,
        skill_id: 'visualization/resource-link',
        skill_key: 'platform:visualization/resource-link',
        name: 'resource-link',
        source: 'platform',
      }),
    ])

    expect(options.map(o => o.token)).toEqual(['/resource-link', '/tabtin-widget'])
  })

  it('deduplicates repeated entries for the same canonical skill key', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: undefined,
        skill_id: 'visualization/tabtin-widget',
        skill_key: 'platform:visualization/tabtin-widget',
        name: 'tabtin-widget',
        source: 'platform',
      }),
      skill({
        slug: 'tabtin-widget',
        skill_id: 'tabtin-widget',
        skill_key: 'platform:visualization/tabtin-widget',
        name: 'tabtin-widget',
        source: 'platform',
      }),
    ])

    expect(options.map(o => o.token)).toEqual(['/tabtin-widget'])
    expect(options[0].canonicalKey).toBe('platform:visualization/tabtin-widget')
  })

  it('keeps a later duplicate when the first canonical entry cannot build a slash token', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'bad slug',
        skill_id: 'visualization/tabtin-widget',
        skill_key: 'platform:visualization/tabtin-widget',
        name: 'tabtin-widget',
        source: 'platform',
      }),
      skill({
        slug: 'tabtin-widget',
        skill_id: 'tabtin-widget',
        skill_key: 'platform:visualization/tabtin-widget',
        name: 'tabtin-widget',
        source: 'platform',
      }),
    ])

    expect(options.map(o => o.token)).toEqual(['/tabtin-widget'])
  })

  it('lets builtin skills keep the clean slash token when a user skill has the same slug', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'resource-link',
        skill_key: 'user:resource-link',
        name: 'Custom Resource Link',
        source: 'user',
      }),
      skill({
        slug: undefined,
        skill_id: 'visualization/resource-link',
        skill_key: 'platform:visualization/resource-link',
        name: 'resource-link',
        source: 'platform',
      }),
    ])

    expect(options.map(o => `${o.token}:${o.canonicalKey}`)).toEqual([
      '/resource-link:platform:visualization/resource-link',
      '/user-resource-link:user:resource-link',
    ])
  })

  it('keeps skills with duplicate operation tokens by adding namespace to lower priority commands', () => {
    const options = buildSkillSlashCommandOptions([
      skill({ slug: undefined, skill_key: 'platform:device/operations', name: 'Device Operations', source: 'platform' }),
      skill({ slug: undefined, skill_key: 'platform:mcp/operations', name: 'MCP Operations', source: 'platform' }),
      skill({ slug: undefined, skill_id: 'tabslide/operations', skill_key: 'app:tabslide/operations', name: 'TabSlide Operations', source: 'app', app_id: 'tabslide' }),
    ])

    expect(options.map(o => o.token)).toEqual([
      '/mcp-operations',
      '/operations',
      '/tabslide-operations',
    ])
    expect(new Set(options.map(o => o.canonicalKey)).size).toBe(3)
  })

  it('searches duplicate-token skills by both base and final slash tokens', () => {
    const skills = [
      skill({ slug: undefined, skill_key: 'platform:device/operations', name: 'Device Operations', source: 'platform' }),
      skill({ slug: undefined, skill_key: 'platform:mcp/operations', name: 'MCP Operations', source: 'platform' }),
      skill({ slug: undefined, skill_id: 'tabslide/operations', skill_key: 'app:tabslide/operations', name: 'TabSlide Operations', source: 'app', app_id: 'tabslide' }),
    ]

    expect(buildSkillSlashCommandOptions(skills, 'operations').map(o => o.token)).toEqual([
      '/operations',
      '/mcp-operations',
      '/tabslide-operations',
    ])
    expect(buildSkillSlashCommandOptions(skills, 'mcp-operations').map(o => o.token)).toEqual(['/mcp-operations'])
  })

  it('detects slash query only at token boundaries', () => {
    expect(detectSkillSlashQuery('/meet', 5)).toEqual({ query: 'meet', anchorPos: 0 })
    expect(detectSkillSlashQuery('please /meet', 12)).toEqual({ query: 'meet', anchorPos: 7 })
    expect(detectSkillSlashQuery('path/to/file', 12)).toBeNull()
    expect(detectSkillSlashQuery('@field', 6)).toBeNull()
  })

  it('replaces the active slash token while preserving trailing text', () => {
    const [option] = buildSkillSlashCommandOptions([skill({ slug: 'meeting-notes' })])
    const next = replaceSkillSlashToken('/meet follow up', 0, 'meet', option)

    expect(next.value).toBe('/meeting-notes follow up')
    expect(next.cursorPos).toBe('/meeting-notes '.length)
  })

  it('parses a leading slash command into a structured Skill selection', () => {
    const options = buildSkillSlashCommandOptions([
      skill({ slug: 'meeting-notes', skill_key: 'app:office/meeting-notes' }),
    ])

    const parsed = parseLeadingSkillSlashCommand('/meeting-notes summarize today', options)
    expect(parsed?.option.canonicalKey).toBe('app:office/meeting-notes')
    expect(parsed?.args).toBe('summarize today')

  })

  it('builds clean slash tokens for Personal Plugin skills', () => {
    const skills = [
      skill({
        slug: 'systematic-debugging',
        skill_id: 'systematic-debugging',
        skill_key: 'user:systematic-debugging',
        name: 'systematic-debugging',
        display_name: 'Systematic Debugging',
        source: 'user',
        meta: { personal_plugin_id: 'superpowers' },
      }),
    ]
    const options = buildSkillSlashCommandOptions(skills, 'debug')

    expect(options.map(o => `${o.token}:${o.canonicalKey}`)).toEqual([
      '/systematic-debugging:user:systematic-debugging',
    ])
    expect(buildSkillSlashCommandOptions(skills, 'supe').map(o => o.token)).toEqual(['/systematic-debugging'])
    expect(buildSkillSlashCommandOptions(skills, 'superpower').map(o => o.token)).toEqual(['/systematic-debugging'])
  })

  it('短查询按命令前缀命中并排前，不靠 description 噪音淹没', () => {
    const skills = [
      skill({
        slug: 'browser-operator',
        skill_key: 'app:tabweb/browser-operator',
        name: 'Browser Operator',
        description: 'the best tool for tabs and tables',
      }),
      skill({
        slug: 'table-operator',
        skill_key: 'app:tabdata/table-operator',
        name: 'Table Operator',
        description: 'Operate tabular data',
      }),
      skill({
        slug: 'tabdoc-operator',
        skill_key: 'app:tabdoc/tabdoc-operator',
        name: 'TabDoc Operator',
        description: 'Create documents',
      }),
    ]

    // 1 个字母就要命中 table / tabdoc；description 里带 t 的 browser 不应进列表
    expect(buildSkillSlashCommandOptions(skills, 't').map(o => o.token)).toEqual([
      '/tabdoc-operator',
      '/table-operator',
    ])
    expect(buildSkillSlashCommandOptions(skills, 'ta').map(o => o.token)).toEqual([
      '/tabdoc-operator',
      '/table-operator',
    ])
    // 第 4 字母前也应稳定命中 table（不是等到 tabl 才出现）
    expect(buildSkillSlashCommandOptions(skills, 'tab').map(o => o.token)).toEqual([
      '/tabdoc-operator',
      '/table-operator',
    ])
    expect(buildSkillSlashCommandOptions(skills, 'tabl').map(o => o.token)).toEqual([
      '/table-operator',
    ])
  })

  it('resolveComposerSkillTokenHighlights 高亮全部已确认的已知 token', () => {
    const options = buildSlashCommandOptions([
      skill({ slug: 'canvas', skill_key: 'app:tabwhiteboard/canvas' }),
      skill({ slug: 'browser-operator', skill_key: 'app:tabweb/browser-operator' }),
    ])

    expect(resolveComposerSkillTokenHighlights('/can', options)).toEqual([])
    expect(resolveComposerSkillTokenHighlights('/unknown hello', options)).toEqual([])
    // 非空白紧贴的 /token 不算（避免 path/to 误伤）；空白后的已知 token 要高亮
    expect(resolveComposerSkillTokenHighlights('请用/canvas 画图', options)).toEqual([])

    const mid = resolveComposerSkillTokenHighlights('请用 /canvas 画图', options)
    expect(mid).toHaveLength(1)
    expect(mid[0]).toMatchObject({ token: '/canvas', start: '请用 '.length })

    const committed = resolveComposerSkillTokenHighlight('/canvas 帮我画个图', options)
    expect(committed).toMatchObject({
      start: 0,
      end: '/canvas'.length,
      token: '/canvas',
    })
    expect(committed?.option.slug).toBe('canvas')

    const onlyToken = resolveComposerSkillTokenHighlight('/canvas', options)
    expect(onlyToken?.token).toBe('/canvas')

    const withLeadingSpace = resolveComposerSkillTokenHighlight('  /canvas ', options)
    expect(withLeadingSpace).toMatchObject({ start: 2, end: 2 + '/canvas'.length, token: '/canvas' })

    const multi = resolveComposerSkillTokenHighlights(
      '/canvas 先画 /browser-operator 再打开',
      options,
    )
    expect(multi.map(item => item.token)).toEqual(['/canvas', '/browser-operator'])
    expect(multi[1]?.start).toBe('/canvas 先画 '.length)
  })

  it('resolveComposerSkillTokenAtomicDeletion 把 pill 当整块删除', () => {
    const options = buildSlashCommandOptions([
      skill({ slug: 'canvas', skill_key: 'app:tabwhiteboard/canvas' }),
      skill({ slug: 'browser-operator', skill_key: 'app:tabweb/browser-operator' }),
    ])
    const value = '/canvas 帮我画个图'
    const unitEnd = '/canvas '.length

    expect(resolveComposerSkillTokenAtomicDeletion({
      value,
      selectionStart: unitEnd,
      selectionEnd: unitEnd,
      key: 'Backspace',
      options,
    })).toEqual({ value: '帮我画个图', cursorPos: 0 })

    expect(resolveComposerSkillTokenAtomicDeletion({
      value,
      selectionStart: 3,
      selectionEnd: 3,
      key: 'Backspace',
      options,
    })).toEqual({ value: '帮我画个图', cursorPos: 0 })

    expect(resolveComposerSkillTokenAtomicDeletion({
      value,
      selectionStart: 0,
      selectionEnd: 0,
      key: 'Delete',
      options,
    })).toEqual({ value: '帮我画个图', cursorPos: 0 })

    expect(resolveComposerSkillTokenAtomicDeletion({
      value,
      selectionStart: 4,
      selectionEnd: unitEnd + 2,
      key: 'Backspace',
      options,
    })).toEqual({ value: '画个图', cursorPos: 0 })

    // 光标在普通正文里：不拦截
    expect(resolveComposerSkillTokenAtomicDeletion({
      value,
      selectionStart: unitEnd + 1,
      selectionEnd: unitEnd + 1,
      key: 'Backspace',
      options,
    })).toBeNull()

    const multi = '/canvas 先画 /browser-operator 再打开'
    const secondStart = '/canvas 先画 '.length
    const secondUnitEnd = secondStart + '/browser-operator '.length
    expect(resolveComposerSkillTokenAtomicDeletion({
      value: multi,
      selectionStart: secondUnitEnd,
      selectionEnd: secondUnitEnd,
      key: 'Backspace',
      options,
    })).toEqual({ value: '/canvas 先画 再打开', cursorPos: secondStart })
  })
})

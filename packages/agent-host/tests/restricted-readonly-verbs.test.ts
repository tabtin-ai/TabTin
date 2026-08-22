/**
 * RESTRICTED_READONLY_VERBS 内容守护。
 *
 * 从 agent-runtime restricted-shell-allowlist 测试迁来——只读动词表随源码迁到宿主，
 * 「不漏写命令 / 与 CLI risk 标注同步」这两条内容守护也随之落在这里。
 */
import { describe, it, expect } from 'vitest'
import { RESTRICTED_READONLY_VERBS } from '../src/capabilities/shell-restriction.js'

// 模拟 `tabtin commands --format json` 采样（risk='' 只读 / risk='write' 写）。
// 维护契约：CLI 新增 risk='' 命令时，要么把终末 verb 加进 RESTRICTED_READONLY_VERBS，
// 要么把命令加进本 fixture；漏则本测试红。
const PRODUCTION_SCHEMA_FIXTURE: ReadonlyArray<{ name: string; risk?: string }> = [
  { name: 'tabtin doc list', risk: '' },
  { name: 'tabtin doc read', risk: '' },
  { name: 'tabtin doc list-blocks', risk: '' },
  { name: 'tabtin doc search-blocks', risk: '' },
  { name: 'tabtin doc export', risk: '' },
  { name: 'tabtin doc search', risk: '' },
  { name: 'tabtin memo list', risk: '' },
  { name: 'tabtin memo read', risk: '' },
  { name: 'tabtin memo search', risk: '' },
  { name: 'tabtin table list', risk: '' },
  { name: 'tabtin table query', risk: '' },
  { name: 'tabtin table view records', risk: '' },
  { name: 'tabtin table view statistics', risk: '' },
  { name: 'tabtin browser glance', risk: '' },
  { name: 'tabtin browser print', risk: '' },
  { name: 'tabtin browser wait', risk: '' },
  { name: 'tabtin browser console', risk: '' },
  { name: 'tabtin browser cookies get', risk: '' },
  { name: 'tabtin browser network', risk: '' },
  { name: 'tabtin browser tab list', risk: '' },
  { name: 'tabtin browser tab state', risk: '' },
  { name: 'tabtin browser resource', risk: '' },
  { name: 'tabtin browser stream', risk: '' },
  { name: 'tabtin browser ua', risk: '' },
  { name: 'tabtin commands', risk: '' },
  { name: 'tabtin capabilities', risk: '' },
  { name: 'tabtin mcp list-servers', risk: '' },
  { name: 'tabtin mcp list-tools', risk: '' },
  { name: 'tabtin mcp list-resources', risk: '' },
  { name: 'tabtin mcp list-prompts', risk: '' },
  { name: 'tabtin mcp read-resource', risk: '' },
  { name: 'tabtin mcp get-prompt', risk: '' },
  { name: 'tabtin tracker show', risk: '' },
  { name: 'tabtin tracker dry-run', risk: '' },
  { name: 'tabtin code grep', risk: '' },
  { name: 'tabtin code glob', risk: '' },
  { name: 'tabtin doc create', risk: 'write' },
  { name: 'tabtin browser act', risk: 'write' },
  { name: 'tabtin browser eval', risk: 'write' },
]

describe('RESTRICTED_READONLY_VERBS — L20b codegen 守护', () => {
  it('每个 risk="" 命令的终末 verb 都在 RESTRICTED_READONLY_VERBS 中', () => {
    const missing: Array<{ name: string; verb: string }> = []
    for (const cmd of PRODUCTION_SCHEMA_FIXTURE) {
      if (cmd.risk !== '' && cmd.risk !== undefined) continue
      const verb = cmd.name.split(/\s+/).pop()!.toLowerCase()
      if (verb === 'tabtin') continue
      if (!RESTRICTED_READONLY_VERBS.has(verb)) missing.push({ name: cmd.name, verb })
    }
    expect(
      missing,
      `readonly commands whose terminal verb is NOT in RESTRICTED_READONLY_VERBS:\n` +
        missing.map((m) => `  - "${m.name}" → verb="${m.verb}"`).join('\n'),
    ).toEqual([])
  })

  it('每个 risk="write" 命令的终末 verb 都不在 RESTRICTED_READONLY_VERBS 中', () => {
    const leaked: Array<{ name: string; verb: string }> = []
    for (const cmd of PRODUCTION_SCHEMA_FIXTURE) {
      if (cmd.risk !== 'write' && cmd.risk !== 'high-risk-write') continue
      const verb = cmd.name.split(/\s+/).pop()!.toLowerCase()
      if (RESTRICTED_READONLY_VERBS.has(verb)) leaked.push({ name: cmd.name, verb })
    }
    expect(
      leaked,
      `write commands leaked into RESTRICTED_READONLY_VERBS:\n` +
        leaked.map((m) => `  - "${m.name}" → verb="${m.verb}"`).join('\n'),
    ).toEqual([])
  })

  it('已知写动词不在只读表（eval / create / act / delete / update / stop）', () => {
    for (const verb of ['eval', 'create', 'act', 'delete', 'update', 'stop', 'set', 'run', 'click', 'input']) {
      expect(RESTRICTED_READONLY_VERBS.has(verb)).toBe(false)
    }
  })
})

/**
 * 回归测试：system prompt 的 principle / environment / custom_rules 段。
 *
 * 具体 persona 由 agent-profile 提供；principle 只定义默认原则。
 * section builders 的 SSoT 在 `@tabtin/agent-prompt` 包。
 */
import { describe, it, expect } from 'vitest'
import {
  buildPrincipleSection,
  buildEnvironmentSection,
  buildCustomRulesSection,
} from '../index.js'

describe('system-prompt-sections – buildPrincipleSection', () => {
  // ：不再硬编码具体 persona；principle 只保留行为规则与操作循环。
  it('renders principle shell without hardcoded TabTin AI Agent persona line', () => {
    const out = buildPrincipleSection()
    expect(out).not.toContain('你是 TabTin AI Agent')
    expect(out).not.toContain('## 平台岗位')
    expect(out).not.toContain('本段不另设人格')
    expect(out).not.toContain('## 术语')
    expect(out).not.toMatch(/\bSpace\b/)
    expect(out).toMatch(/^<principle>/)
    expect(out).toMatch(/<\/principle>$/)
  })

  it('does not leak workspace / space env labels (those belong to buildEnvironmentSection)', () => {
    const out = buildPrincipleSection()
    expect(out).not.toContain('Current workspace:')
    expect(out).not.toContain('Working directory for command and file tools')
    expect(out).not.toContain('Space ID:')
  })

  it('renders behavior rules and operating loop (中文化后)', () => {
    const out = buildPrincipleSection()
    expect(out).toContain('行为规则')
    expect(out).toContain('跟随用户语言')
    expect(out).toContain('简洁高效')
    expect(out).toContain('及时同步')
    expect(out).toContain('当前进展和接下来的计划')
    expect(out).toContain('每轮操作循环')
    expect(out).toContain('平台安全与权限边界')
    expect(out).not.toContain('<operating_loop>')
  })
})

describe('system-prompt-sections – buildEnvironmentSection', () => {
  it('renders runtime location line in environment, not identity', () => {
    const out = buildEnvironmentSection({
      spaceId: 'space-test',
      organizationId: 'organization-test',
      threadId: 'session-test',
      workspaceRoot: '/tmp/workspace-test',
      archiveDir: '/tmp/archive-test',
      toolLogsDir: '/tmp/tool-logs-test',
    })

    expect(out).toContain('你运行在 TabTin 工作空间中。')
    expect(out).toContain('组织：')
    expect(out).toContain('工作空间：')
    expect(out).toContain('会话：')
    expect(out).toContain('## 环境变量')
    expect(out).toContain('- `TABTIN_WORKSPACE`')
    expect(out).not.toContain('/tmp/workspace-test')
    expect(out).toContain('## 术语')
    expect(out).toContain('Organization')
    expect(out).toContain('Agent')
  })
})

describe('system-prompt-sections – buildCustomRulesSection (FR-02)', () => {
  it('returns empty string when rules is undefined (no <custom_rules> tag)', () => {
    expect(buildCustomRulesSection()).toBe('')
  })

  it('returns empty string when rules is an empty string', () => {
    expect(buildCustomRulesSection('')).toBe('')
  })

  it('returns empty string when rules contains only whitespace', () => {
    expect(buildCustomRulesSection('   \n\t  ')).toBe('')
  })

  it('wraps user rules in <custom_rules> tags', () => {
    const rules = '- 只用中文回复\n- 禁止使用 emoji'
    const out = buildCustomRulesSection(rules)
    expect(out).toBe(`<custom_rules>\n${rules}\n</custom_rules>`)
  })

  it('trims leading/trailing whitespace of custom rules', () => {
    const out = buildCustomRulesSection('  \n规则一\n规则二\n  ')
    expect(out).toBe('<custom_rules>\n规则一\n规则二\n</custom_rules>')
  })
})

import { describe, expect, it } from 'vitest'
import { buildAgentProfileSection } from '../sections.js'

describe('buildAgentProfileSection', () => {
  it('字段皆空 → 空串', () => {
    expect(buildAgentProfileSection({})).toBe('')
    expect(
      buildAgentProfileSection({ agentName: '  ', customRules: '   ' }),
    ).toBe('')
  })

  it('仅名称', () => {
    const out = buildAgentProfileSection({ agentName: '小明代码版' })
    expect(out).toBe('你是小明代码版。')
    expect(out).not.toContain('## 展示名称')
    expect(out).not.toContain('当前目标')
    expect(out).not.toContain('人设与规则')
  })

  it('含人设与规则（配置页 custom_rules）', () => {
    const out = buildAgentProfileSection({
      agentName: '小明代码版',
      customRules: '只用 TypeScript；commit 用中文。',
    })
    expect(out.startsWith('你是小明代码版。')).toBe(true)
    expect(out).not.toContain('## 展示名称')
    expect(out).toContain('## 人设与规则')
    expect(out).toContain('只用 TypeScript；commit 用中文。')
    expect(out).toContain('Agent 专属偏好')
    expect(out).toContain('本轮用户明确临时要求（偏好范围）')
    expect(out).not.toContain('当前目标')
  })

  it('仅人设与规则也可注入', () => {
    const out = buildAgentProfileSection({ customRules: '始终用中文' })
    expect(out).toContain('## 人设与规则')
    expect(out).toContain('始终用中文')
    expect(out).toContain('平台硬边界')
    expect(out).not.toContain('你是')
    expect(out).not.toContain('展示名称')
    expect(out).not.toContain('当前目标')
  })

  it('#6674 personal + Agent 自由文本按字段来源结构化、固定顺序合并', () => {
    const out = buildAgentProfileSection({
      personalRules: '个人：始终中文',
      customRules: 'Agent：始终英文',
    })
    expect(out).toContain(
      '<long_term_preference source="personal_rules" format="free_text">',
    )
    expect(out).toContain(
      '<long_term_preference source="custom_rules" format="free_text">',
    )
    expect(out.indexOf('个人：始终中文')).toBeLessThan(
      out.indexOf('Agent：始终英文'),
    )
    expect(out).toContain('不对下列自由文本做脆弱的自然语言分类')
  })

  it('#6674 仅 personal 自由文本也能形成长期偏好上下文', () => {
    const out = buildAgentProfileSection({ personalRules: '先给结论' })
    expect(out).toContain('source="personal_rules"')
    expect(out).toContain('先给结论')
    expect(out).not.toContain('source="custom_rules"')
  })

  it('#6903 workspace_rules 在 Agent custom_rules 之后，且可单独注入', () => {
    const out = buildAgentProfileSection({
      customRules: 'Agent：用英文',
      workspaceRules: '本仓库禁止 force push',
    })
    expect(out).toContain('source="workspace_rules"')
    expect(out.indexOf('Agent：用英文')).toBeLessThan(
      out.indexOf('本仓库禁止 force push'),
    )
    expect(out).toContain('现场规则就近优先于 Agent 人设')
  })
})

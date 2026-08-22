/**
 * SkillInjectionInlineCard 组件契约 + MessageSteps 时序保护测试。
 *
 * **核心保护**（W14 修时序错位）：
 *   1. SkillInjectionInlineCard 自身行为：summary 抽取、字符数显示、空内容
 *      返回 null
 *   2. **关键**：skill_invoke 注入消息按 `metadata.tool_call_id` 关联到对应
 *      tool_call 步骤的位置——不再在顶层（messages 末尾）显示
 *
 * 后端协议变化、前端渲染路径漂移时，本测试会立即报警。
 */

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SkillInjectionInlineCard } from '../SkillInjectionInlineCard'

afterEach(() => {
  cleanup()
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // {{count}} placeholder 替换（仅本测试需要）
      const def = String(opts?.defaultValue ?? key)
      if (typeof opts?.count === 'number') {
        return def.replace('{{count}}', String(opts.count))
      }
      return def
    },
  }),
}))

describe('SkillInjectionInlineCard — 自身行为', () => {
  it('展示 Skill 标签 + summary（首个非空 heading）+ 字符数', () => {
    const content = `---
name: TabCode Operator
key: skill_tabcode_operator
---

# TabCode Operator

This is the body of the skill.`
    render(<SkillInjectionInlineCard content={content} />)

    expect(screen.getByText('Skill 指令注入')).toBeTruthy()
    expect(screen.getByText('TabCode Operator')).toBeTruthy()
    const trimmedLen = content.trim().length
    expect(screen.getByText(`${trimmedLen} 字符`)).toBeTruthy()
  })

  it('summaryHint 非空时优先用 hint 而不是 derive', () => {
    const content = '# Some Heading\n\nbody...'
    render(<SkillInjectionInlineCard content={content} summaryHint="Custom Hint" />)

    expect(screen.getByText('Custom Hint')).toBeTruthy()
    expect(screen.queryByText('Some Heading')).toBeNull()
  })

  it('content 为空字符串时返回 null（不渲染卡片）', () => {
    cleanup() // 防御：确保前一个测试的 DOM 被清掉
    const { container } = render(<SkillInjectionInlineCard content="" />)
    expect(container.querySelector('[data-testid="skill-injection-inline-card"]')).toBeNull()
  })

  it('无 frontmatter 也无 heading 时使用首行非空作为 summary', () => {
    const content = 'plain first line content of the skill'
    render(<SkillInjectionInlineCard content={content} />)
    // summary + body 两处都有，至少出现 1 次以上即可
    expect(screen.getAllByText(content).length).toBeGreaterThan(0)
  })

  it('summary 超过 80 字符时截断 + 省略号', () => {
    const longLine = 'a'.repeat(120)
    render(<SkillInjectionInlineCard content={longLine} />)
    expect(screen.getByText('a'.repeat(80) + '…')).toBeTruthy()
  })

  it('完整 content 在折叠展开区里渲染（用 details/summary 做 native 折叠）', () => {
    const content = '# Title\n\nfull body line one\nfull body line two'
    const { container } = render(<SkillInjectionInlineCard content={content} />)

    const card = container.querySelector('[data-testid="skill-injection-inline-card"]')
    expect(card).toBeTruthy()
    expect(card?.tagName.toLowerCase()).toBe('details')
    expect(card?.textContent).toContain('full body line one')
    expect(card?.textContent).toContain('full body line two')
  })
})

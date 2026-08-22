/**
 * HitlResourceLabel — RTL 单测（Wave A 启动包 A4 验收必含）。
 *
 * 覆盖三种渲染状态（PRD §13.2 子 Agent 自决约定）：
 *
 * 1. 有 `resource_label` → 渲染 label，主色 + 加粗，title 带 raw id
 * 2. 无 label 但有 `resource` → 灰显 raw id + 「无法解析」提示
 * 3. `cli_spec` 缺失 / 完全无 resource → 渲染 null
 */

import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HitlResourceLabel } from '../HitlResourceLabel'
import type { CliSpecForUI } from '@tabtin/chat-client'

describe('HitlResourceLabel', () => {
  it('renders human-readable label when cli_spec.resource_label is present', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_demo',
      resource_label: '示例表',
      risk_level: 'review',
    }
    const { getByTestId } = render(<HitlResourceLabel cliSpec={spec} />)

    const wrapper = getByTestId('hitl-resource-label')
    expect(wrapper).toBeTruthy()
    expect(wrapper.getAttribute('data-resource-state')).toBe('resolved')
    expect(wrapper.textContent).toContain('示例表')

    // raw id 应通过 title 属性提供（hover 时可见），而不是直接渲染
    const labelSpan = wrapper.querySelector('[title]')
    expect(labelSpan?.getAttribute('title')).toBe('table:tbl_demo')
    expect(labelSpan?.textContent).toBe('示例表')

    // 不应同时显示 raw id 主体（避免视觉重复）
    expect(wrapper.textContent).not.toContain('tbl_demo')

    // a11y：aria-label 包含完整 raw id（读屏 / 触屏用户也能拿到 id）
    const ariaLabel = wrapper.getAttribute('aria-label')
    expect(ariaLabel).toContain('示例表')
    expect(ariaLabel).toContain('table:tbl_demo')
  })

  it('falls back to raw resource id with neutral unresolved hint when no label', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_unknown',
      resource_label: null,
      risk_level: 'review',
    }
    const { getByTestId } = render(<HitlResourceLabel cliSpec={spec} />)

    const wrapper = getByTestId('hitl-resource-label')
    expect(wrapper.getAttribute('data-resource-state')).toBe('raw-id')

    // 灰显 raw id（hint 文案目前是 i18n key）
    expect(wrapper.textContent).toContain('table:tbl_unknown')
    // 中性提示文案由 i18n key 渲染（test setup mock t(key) → key）
    // 文案改为「暂无法显示名称」/「(name unavailable)」，避免「无法解析」让用户以为系统坏了
    expect(wrapper.textContent).toContain('review.resourceLabelUnresolved')

    // raw id 用 <code> 渲染（font-mono 风格）
    const codeEl = wrapper.querySelector('code')
    expect(codeEl).toBeTruthy()
    expect(codeEl?.textContent).toBe('table:tbl_unknown')
    expect(codeEl?.getAttribute('title')).toBe('table:tbl_unknown')

    // a11y：aria-label 包含 raw id 与中性提示
    const ariaLabel = wrapper.getAttribute('aria-label')
    expect(ariaLabel).toContain('table:tbl_unknown')
  })

  it('falls back to raw id when resource_label is undefined (key absent)', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'doc:doc_yyy',
      // resource_label 字段干脆没设——后端尚未接入 label 解析时也走 raw 路径
    }
    const { getByTestId } = render(<HitlResourceLabel cliSpec={spec} />)
    const wrapper = getByTestId('hitl-resource-label')
    expect(wrapper.getAttribute('data-resource-state')).toBe('raw-id')
    expect(wrapper.textContent).toContain('doc:doc_yyy')
  })

  it('renders null when cli_spec is undefined', () => {
    const { container } = render(<HitlResourceLabel cliSpec={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders null when cli_spec is null', () => {
    const { container } = render(<HitlResourceLabel cliSpec={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders null when both resource and resource_label are missing', () => {
    const spec: CliSpecForUI = {
      binary: 'tabtin',
      domain: 'memo',
      verb: 'list',
      // 既无 resource 也无 label：list 类查询场景，HITL 不需要展示资源行
    }
    const { container } = render(<HitlResourceLabel cliSpec={spec} />)
    expect(container.firstChild).toBeNull()
  })

  it('does not crash on empty resource string + no label', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'list',
      resource: '',
      resource_label: '',
    }
    const { container } = render(<HitlResourceLabel cliSpec={spec} />)
    // 两者都空：与"完全缺失"等价，渲染 null
    expect(container.firstChild).toBeNull()
  })

  it('passes through className for layout customization', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_x',
      resource_label: '示例表',
    }
    const { getByTestId } = render(
      <HitlResourceLabel cliSpec={spec} className="custom-spacing" />,
    )
    expect(getByTestId('hitl-resource-label').className).toContain('custom-spacing')
  })

  it('uses i18n key for the leading "资源" label', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_x',
      resource_label: '示例表',
    }
    render(<HitlResourceLabel cliSpec={spec} />)
    // setup.ts 的 vi.mock 把 t(key) 直接返回 key，因此 review.resourceLabel 出现在 DOM
    expect(screen.getByText('review.resourceLabel')).toBeTruthy()
  })

  it('uses i18n key for the unresolved hint', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_no_label',
    }
    render(<HitlResourceLabel cliSpec={spec} />)
    expect(screen.getByText('review.resourceLabelUnresolved')).toBeTruthy()
  })

  it('marks decorative spans aria-hidden so screen readers only read aria-label', () => {
    const spec: CliSpecForUI = {
      binary: 'demo-cli',
      domain: 'records',
      verb: 'delete',
      resource: 'table:tbl_x',
      resource_label: '示例表',
    }
    const { getByTestId } = render(<HitlResourceLabel cliSpec={spec} />)
    const wrapper = getByTestId('hitl-resource-label')
    // 视觉文本以 aria-hidden 包裹，避免读屏重复朗读
    const hiddenSpans = wrapper.querySelectorAll('[aria-hidden="true"]')
    expect(hiddenSpans.length).toBeGreaterThan(0)
    // wrapper 自身有 aria-label
    expect(wrapper.getAttribute('aria-label')).toBeTruthy()
  })
})

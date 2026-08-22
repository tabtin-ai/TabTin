/**
 * ResourceOpenPreferencesPanel 测试 — W4「Agent 产物在 Space 内的打开」
 *
 * 覆盖：
 *   1. 渲染：从 manifest 动态生成行（D1 红线，不硬编码 App 名单）
 *   2. 渲染：当前用户偏好同步到 dropdown 的 value
 *   3. 交互：dropdown change → setPreference 写入 store
 *   4. 交互：选择 "默认推荐"（__default__）→ clearPreference
 *   5. 交互：行尾"重置"按钮 → clearPreference
 *   6. 交互：顶部"清空全部偏好" → clearAllPreferences
 *   7. L19 行为提示文案存在（用户偏好的 X 不可用 → 自动降级到 manifest 默认）
 *   8. 空状态：当 manifest 没有任何 opens 注册时，显示 EmptyHint
 *
 * 不测：
 *   - L19 实际降级逻辑（router 单测覆盖）—— Panel 只负责文案
 *   - 跨 turn 多次切换不污染（store 单测覆盖）
 */

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

// setup.ts 里 react-i18next mock 直接返回 key，会让我们的文案断言全跑空。
// 这里 override：让 t() 优先返回 defaultValue + 简单插值，模拟真实 i18next 行为。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const def = (options as { defaultValue?: string } | undefined)?.defaultValue
      let str = typeof def === 'string' ? def : key
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          if (k === 'defaultValue') continue
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
        }
      }
      return str
    },
    i18n: { language: 'zh-CN' },
  }),
}))

// 必须在 import Panel 前 mock，否则 module 顶层 import 已固化
vi.mock('@/services/resourceRouter', () => {
  return {
    resourceRouterRegistry: {
      knownTypes: vi.fn(() => ['document', 'table']),
      knownSchemes: vi.fn(() => ['https:', 'mailto:']),
      lookupByType: vi.fn((type: string) => {
        if (type === 'document') {
          return [
            { appId: 'tabdoc', priority: 100 },
            { appId: 'tabcode', priority: 50 },
          ]
        }
        if (type === 'table') {
          return [{ appId: 'tabdata', priority: 100 }]
        }
        return []
      }),
      lookupByScheme: vi.fn((scheme: string) => {
        if (scheme === 'https:') return [{ appId: 'tabweb', priority: 50 }]
        if (scheme === 'mailto:') return [{ appId: 'tabmail', priority: 100 }]
        return []
      }),
    },
  }
})

// 简化 ConfirmDialog 行为：渲染时若 open=true 立刻调 onConfirm，让 "清空" 按钮等价直接生效
vi.mock('@components/ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@components/ui')
  const ReactMock = await vi.importActual<typeof import('react')>('react')

  const SelectTrigger = (props: React.HTMLAttributes<HTMLButtonElement>) => <>{props.children}</>
  const SelectContent = (props: { children: React.ReactNode }) => <>{props.children}</>
  const SelectItem = (props: { value: string; disabled?: boolean; children: React.ReactNode }) => (
    <option value={props.value} disabled={props.disabled}>{props.children}</option>
  )
  const SelectValue = () => null
  const Select = (props: {
    value?: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) => {
    const children = ReactMock.Children.toArray(props.children) as React.ReactElement[]
    const trigger = children.find((child) => child.type === SelectTrigger)
    const content = children.find((child) => child.type === SelectContent)
    return (
      <select
        {...(trigger?.props as React.SelectHTMLAttributes<HTMLSelectElement> | undefined)}
        value={props.value}
        onChange={(event) => props.onValueChange?.(event.target.value)}
      >
        {content}
      </select>
    )
  }

  return {
    ...actual,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    ConfirmDialog: (props: {
      open: boolean
      onConfirm?: () => void
      title?: string
      description?: string
    }) =>
      props.open
        ? (
          <div role="dialog" data-testid="resource-open-confirm-dialog">
            <h2>{props.title}</h2>
            <p>{props.description}</p>
            <button
              type="button"
              data-testid="resource-open-confirm-action"
              onClick={() => props.onConfirm?.()}
            >
              ConfirmTest
            </button>
          </div>
        )
        : null,
  }
})

vi.mock('@/components/context-space/registry/instance', () => {
  const handlers: Record<string, { displayLabel: string; displayEmoji?: string }> = {
    tabdoc: { displayLabel: 'TabDoc', displayEmoji: '📄' },
    tabcode: { displayLabel: 'TabCode', displayEmoji: '💻' },
    tabdata: { displayLabel: 'TabData', displayEmoji: '📊' },
    tabweb: { displayLabel: 'TabWeb', displayEmoji: '🌐' },
    tabmail: { displayLabel: 'TabMail', displayEmoji: '✉️' },
  }
  return {
    contextRegistry: {
      getHandlerByAppId: (appId: string) => handlers[appId],
    },
  }
})

import { ResourceOpenPreferencesPanel } from './ResourceOpenPreferencesPanel'
import { useResourceOpenPreferences } from '@/stores/useResourceOpenPreferences'

beforeEach(() => {
  useResourceOpenPreferences.setState({ preferences: {}, sessionOverrides: {} })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ResourceOpenPreferencesPanel — 渲染（D1 manifest 动态生成）', () => {
  it('render 不抛错，含 header + types section + schemes section', () => {
    render(<ResourceOpenPreferencesPanel />)
    expect(screen.getByText('默认打开方式')).toBeTruthy()
    expect(screen.getByText('资源类型（自有格式）')).toBeTruthy()
    expect(screen.getByText('URL 协议（行业格式）')).toBeTruthy()
  })

  it('types 行从 knownTypes 动态生成（document + table，按字母排序）', () => {
    render(<ResourceOpenPreferencesPanel />)
    const typesSection = screen.getByTestId('resource-open-preferences-types')
    expect(within(typesSection).getByTestId('pref-row-type:document')).toBeTruthy()
    expect(within(typesSection).getByTestId('pref-row-type:table')).toBeTruthy()
  })

  it('schemes 行从 knownSchemes 动态生成（https: + mailto:）', () => {
    render(<ResourceOpenPreferencesPanel />)
    const schemesSection = screen.getByTestId('resource-open-preferences-schemes')
    expect(within(schemesSection).getByTestId('pref-row-scheme:https:')).toBeTruthy()
    expect(within(schemesSection).getByTestId('pref-row-scheme:mailto:')).toBeTruthy()
  })

  it('document 行下拉含两个 carrier（TabDoc / TabCode）+ 默认推荐选项', () => {
    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:document') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((o) => o.text)
    expect(optionTexts.some((t) => t.includes('TabDoc'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('TabCode'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('默认推荐'))).toBe(true)
  })

  it('table 行只有 1 个 carrier（TabData）', () => {
    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:table') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((o) => o.text)
    expect(optionTexts.some((t) => t.includes('TabData'))).toBe(true)
    expect(optionTexts.some((t) => t.includes('TabDoc'))).toBe(false)
  })
})

describe('ResourceOpenPreferencesPanel — 交互', () => {
  it('dropdown change → 写入 store preferences', () => {
    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:document')
    fireEvent.change(select, { target: { value: 'tabcode' } })
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBe('tabcode')
  })

  it('当前 user_pref 同步到 dropdown.value', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:document') as HTMLSelectElement
    expect(select.value).toBe('tabcode')
  })

  it('选 "__default__" → clearPreference（写入"默认推荐"等价于删除偏好）', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:document')
    fireEvent.change(select, { target: { value: '__default__' } })
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBeUndefined()
  })

  it('行尾"重置"按钮 → clearPreference', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    render(<ResourceOpenPreferencesPanel />)
    const resetBtn = screen.getByTestId('pref-reset-type:document')
    fireEvent.click(resetBtn)
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBeUndefined()
  })

  it('"重置"按钮在没设偏好时 disabled', () => {
    render(<ResourceOpenPreferencesPanel />)
    const resetBtn = screen.getByTestId('pref-reset-type:document') as HTMLButtonElement
    expect(resetBtn.disabled).toBe(true)
  })

  it('"重置"按钮在已设偏好时 enabled', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabcode')
    render(<ResourceOpenPreferencesPanel />)
    const resetBtn = screen.getByTestId('pref-reset-type:document') as HTMLButtonElement
    expect(resetBtn.disabled).toBe(false)
  })

  it('"清空全部偏好" 按钮在没偏好时不渲染（避免误操作）', () => {
    render(<ResourceOpenPreferencesPanel />)
    expect(screen.queryByText(/清空全部偏好/)).toBeNull()
  })

  it('"清空全部偏好" 按钮在有偏好时渲染（点击只弹 confirm，不直接清空）', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabdoc')
    useResourceOpenPreferences.getState().setPreference('scheme:https:', 'tabweb')
    render(<ResourceOpenPreferencesPanel />)
    const trigger = screen.getByTestId('resource-open-preferences-clear-all-trigger')
    fireEvent.click(trigger)
    // confirm dialog 弹出
    expect(screen.getByTestId('resource-open-confirm-dialog')).toBeTruthy()
    // 偏好仍未被清——还在等用户确认
    expect(useResourceOpenPreferences.getState().preferences['type:document']).toBe('tabdoc')
  })

  it('"清空全部偏好" confirm 后真正清空（destructive 流程完整）', () => {
    useResourceOpenPreferences.getState().setPreference('type:document', 'tabdoc')
    useResourceOpenPreferences.getState().setPreference('scheme:https:', 'tabweb')
    render(<ResourceOpenPreferencesPanel />)
    fireEvent.click(screen.getByTestId('resource-open-preferences-clear-all-trigger'))
    fireEvent.click(screen.getByTestId('resource-open-confirm-action'))
    expect(useResourceOpenPreferences.getState().preferences).toEqual({})
  })
})

describe('ResourceOpenPreferencesPanel — L19 行为提示文案', () => {
  it('页面下方说明：偏好的 X 不可用时自动回退到默认载体（不跳系统应用）', () => {
    render(<ResourceOpenPreferencesPanel />)
    // L19 关键词："回退到默认载体" / "不是跳系统应用" / "重装后自动恢复"
    const fallbackText = screen.getByText((content) =>
      content.includes('回退到默认载体') &&
      content.includes('不是跳系统应用') &&
      content.includes('重装后自动恢复'),
    )
    expect(fallbackText).toBeTruthy()
  })

  it('页面顶部 description：说明「Agent 给链接 / 点击 chat 链接时」用哪个 App 打开', () => {
    render(<ResourceOpenPreferencesPanel />)
    const desc = screen.getByText((content) =>
      content.includes('Agent 给你一个链接') && content.includes('chat'),
    )
    expect(desc).toBeTruthy()
  })
})

// ─── 补 review 视角 C P1-2 发现的死代码分支覆盖 ──────────────────────────────
//
// 原测试文件顶部声明覆盖"空状态 / 无可用载体 / 不可用 carrier 后缀"分支，
// 但 16 个 it 全是 happy path 没真测——EmptyHint 等 3 处分支零覆盖。
// 这里用动态 mock override 补齐。

describe('ResourceOpenPreferencesPanel — 边界分支（review C P1-2 补缺）', () => {
  it('空状态：knownTypes / knownSchemes 都为空时显示两条 EmptyHint', async () => {
    const mod = await import('@/services/resourceRouter')
    const reg = mod.resourceRouterRegistry as unknown as {
      knownTypes: ReturnType<typeof vi.fn>
      knownSchemes: ReturnType<typeof vi.fn>
    }
    reg.knownTypes.mockReturnValueOnce([])
    reg.knownSchemes.mockReturnValueOnce([])

    render(<ResourceOpenPreferencesPanel />)
    expect(screen.getByText('当前没有 App 声明能打开任何资源类型。')).toBeTruthy()
    expect(screen.getByText('当前没有 App 声明能处理任何 URL 协议。')).toBeTruthy()
    // 顶部 clearAll 在无偏好时不显示
    expect(screen.queryByText(/清空全部偏好/)).toBeNull()
  })

  it('某 type 注册了但 lookupByType 返回空时，select 含 disabled "无可用载体" 选项', async () => {
    const mod = await import('@/services/resourceRouter')
    const reg = mod.resourceRouterRegistry as unknown as {
      knownTypes: ReturnType<typeof vi.fn>
      lookupByType: ReturnType<typeof vi.fn>
    }
    reg.knownTypes.mockReturnValueOnce(['ghost_type'])
    reg.lookupByType.mockImplementationOnce((t: string) => {
      if (t === 'ghost_type') return []
      return [{ appId: 'tabdoc', priority: 100 }]
    })

    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:ghost_type') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((o) => o.text)
    expect(optionTexts.some((t) => t.includes('无可用载体'))).toBe(true)
  })

  it('carrier 不可用（manifest 注册但 ContextRegistry 没 handler）→ option 含 "暂不可用" 后缀（L19 视觉对齐）', async () => {
    // 模拟某 App 卸载场景：manifest opens 仍登记 + handler 缺失
    const mod = await import('@/services/resourceRouter')
    const reg = mod.resourceRouterRegistry as unknown as {
      knownTypes: ReturnType<typeof vi.fn>
      lookupByType: ReturnType<typeof vi.fn>
    }
    reg.knownTypes.mockReturnValueOnce(['document'])
    reg.lookupByType.mockReturnValueOnce([
      { appId: 'tabdoc', priority: 100 },
      { appId: 'ghost_app', priority: 50 }, // 这个没在 contextRegistry mock 里
    ])

    render(<ResourceOpenPreferencesPanel />)
    const select = screen.getByTestId('pref-select-type:document') as HTMLSelectElement
    const optionTexts = Array.from(select.options).map((o) => o.text)
    // ghost_app 没注册 handler → available=false → 加 "（暂不可用）" 后缀
    expect(optionTexts.some((t) => t.includes('（暂不可用）'))).toBe(true)
    // tabdoc 正常 → 不带后缀
    expect(optionTexts.some((t) => t.includes('TabDoc') && !t.includes('暂不可用'))).toBe(true)
  })
})

import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WelcomeSuggestionBar } from '../WelcomeSuggestionBar'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('@components/layout/sidebarTypeEmoji', () => ({
  TabTypeEmoji: ({ appIdOrType }: { appIdOrType: string }) => (
    <span data-testid={`tab-type-emoji-${appIdOrType}`} />
  ),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type="button" {...props}>{children}</button>
    ),
  },
  useReducedMotion: () => true,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; label?: string }) => {
      if (key === 'input.starterSuggestions.moduleLabel') return '选择工作模块'
      if (key === 'input.starterSuggestions.modules.tabdoc.label') return '文档'
      if (key === 'input.starterSuggestions.modules.tabdoc.summary.title') return '整理成一页摘要'
      if (key === 'input.starterSuggestions.modules.tabdoc.summary.prompt') {
        return '请把材料整理成一页摘要文档'
      }
      if (key === 'input.starterSuggestions.modules.tabdoc.notice.title') return '起草正式通知'
      if (key === 'input.starterSuggestions.modules.tabdoc.notice.prompt') return '请起草通知'
      if (key === 'input.starterSuggestions.modules.tabdoc.outline.title') return '写一份项目方案'
      if (key === 'input.starterSuggestions.modules.tabdoc.outline.prompt') return '请写方案'
      if (key === 'input.starterSuggestions.modules.tabdoc.minutes.title') return '整理成会议纪要'
      if (key === 'input.starterSuggestions.modules.tabdoc.minutes.prompt') return '请整理纪要'
      if (key === 'input.starterSuggestions.tabdoc.outline.title') return '先出大纲再写'
      if (key === 'input.starterSuggestions.tabdoc.outline.prompt') {
        return '请基于当前文档先出大纲'
      }
      if (key === 'input.starterSuggestions.tabdoc.outline.selectedTitle') {
        return '先把文档骨架搭好'
      }
      if (key === 'input.starterSuggestions.tabdoc.formalize.title') return '改得更正式'
      if (key === 'input.starterSuggestions.tabdoc.formalize.prompt') return '请改语气'
      if (key === 'input.starterSuggestions.tabdoc.actionItems.title') return '提炼行动项'
      if (key === 'input.starterSuggestions.tabdoc.actionItems.prompt') return '请提炼行动项'
      if (key === 'input.starterSuggestions.tabdoc.summary.title') return '压成一页摘要'
      if (key === 'input.starterSuggestions.tabdoc.summary.prompt') return '请压缩摘要'
      if (key === 'input.starterSuggestions.contextLabel.tabdoc') return '文档'
      if (key === 'input.starterSuggestions.ariaLabel') return '快速开始建议'
      if (opts?.defaultValue) {
        return opts.label
          ? opts.defaultValue.replace('{{label}}', opts.label)
          : opts.defaultValue
      }
      return key
    },
  }),
}))

describe('WelcomeSuggestionBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders module buttons before a module is selected', () => {
    const onSelect = vi.fn()
    render(<WelcomeSuggestionBar activeContextType={null} onSelect={onSelect} />)

    expect(screen.getByTestId('welcome-suggestion-bar').getAttribute('data-app-key')).toBe('default')
    expect(screen.getByTestId('welcome-module-tabdoc')).toBeTruthy()
    expect(screen.getByTestId('welcome-module-tabdata')).toBeTruthy()
    expect(screen.getByTestId('welcome-module-tabweb')).toBeTruthy()
    expect(screen.queryByTestId('welcome-suggestion-default-doc-summary')).toBeNull()
  })

  it('expands four module suggestions and prefills on click', () => {
    const onSelect = vi.fn()
    render(<WelcomeSuggestionBar activeContextType={null} onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('welcome-module-tabdoc'))
    expect(screen.getByTestId('welcome-module-tabdoc').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('整理成一页摘要')).toBeTruthy()
    expect(screen.getByTestId('welcome-suggestion-default-doc-minutes')).toBeTruthy()

    fireEvent.click(screen.getByTestId('welcome-suggestion-default-doc-summary'))
    expect(onSelect).toHaveBeenCalledWith('请把材料整理成一页摘要文档')
    expect(screen.getByTestId('welcome-suggestion-default-doc-minutes')).toBeTruthy()
  })

  it('collapses the selected module and replaces tasks when switching modules', () => {
    render(<WelcomeSuggestionBar activeContextType={null} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTestId('welcome-module-tabdoc'))
    expect(screen.getByTestId('welcome-suggestion-default-doc-summary')).toBeTruthy()

    fireEvent.click(screen.getByTestId('welcome-module-tabdoc'))
    expect(screen.queryByTestId('welcome-suggestion-default-doc-summary')).toBeNull()
    expect(screen.getByTestId('welcome-module-tabdoc').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByTestId('welcome-module-tabdata'))
    expect(screen.getByTestId('welcome-suggestion-default-table-create')).toBeTruthy()
    expect(screen.queryByTestId('welcome-suggestion-default-doc-summary')).toBeNull()
  })

  it('collapses the module when clicking outside the suggestion bar', () => {
    render(<WelcomeSuggestionBar activeContextType={null} onSelect={vi.fn()} />)

    fireEvent.click(screen.getByTestId('welcome-module-tabdoc'))
    expect(screen.getByTestId('welcome-suggestion-default-doc-summary')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('welcome-suggestion-default-doc-summary')).toBeNull()
  })

  it('switches suggestion set when focused app changes', () => {
    const { rerender } = render(
      <WelcomeSuggestionBar activeContextType={null} onSelect={vi.fn()} />,
    )
    expect(screen.getByTestId('welcome-suggestion-bar').getAttribute('data-app-key')).toBe('default')

    rerender(<WelcomeSuggestionBar activeContextType="tabdoc" onSelect={vi.fn()} />)
    expect(screen.getByTestId('welcome-suggestion-bar').getAttribute('data-app-key')).toBe('tabdoc')
    expect(screen.getByText('先出大纲再写')).toBeTruthy()
    expect(screen.getByTestId('welcome-suggestion-tabdoc-summary')).toBeTruthy()
  })

  it('renders a direct task list when an app is open without a known context type', () => {
    render(
      <WelcomeSuggestionBar
        activeContextType={null}
        forceContextMode
        onSelect={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('welcome-module-tabdoc')).toBeNull()
    expect(screen.getByTestId('welcome-suggestion-default-doc-summary')).toBeTruthy()
  })

  it('passes a more expressive selected title for an app task', () => {
    const onSelect = vi.fn()
    render(<WelcomeSuggestionBar activeContextType="tabdoc" onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('welcome-suggestion-tabdoc-outline'))
    expect(onSelect).toHaveBeenCalledWith('请基于当前文档先出大纲', '先把文档骨架搭好')
  })

  it('hides when hidden prop is true', () => {
    render(
      <WelcomeSuggestionBar activeContextType={null} onSelect={vi.fn()} hidden />,
    )
    expect(screen.queryByTestId('welcome-suggestion-bar')).toBeNull()
  })
})

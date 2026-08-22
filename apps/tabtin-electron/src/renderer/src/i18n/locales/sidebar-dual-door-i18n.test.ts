import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const localesDir = dirname(fileURLToPath(import.meta.url))

function readSidebarLocale(locale: 'zh-CN' | 'en-US'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(localesDir, locale, 'sidebar.json'), 'utf8'),
  ) as Record<string, unknown>
}

function readTabchatLocale(locale: 'zh-CN' | 'en-US'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(localesDir, locale, 'tabchat.json'), 'utf8'),
  ) as Record<string, unknown>
}

function readJsonLocale(locale: 'zh-CN' | 'en-US', file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(localesDir, locale, file), 'utf8'),
  ) as Record<string, unknown>
}

describe('sidebar dual-door tab i18n ', () => {
  it('中英文都提供任务门 / 应用门 / 消息 tab 文案，且英文不是中文原文', () => {
    const zh = readSidebarLocale('zh-CN')
    const en = readSidebarLocale('en-US')

    expect(zh.tabConversations).toBe('任务')
    expect(zh.tabDesktop).toBe('应用')
    expect(zh.tabMessages).toBe('消息')

    expect(en.tabConversations).toBe('Tasks')
    expect(en.tabDesktop).toBe('Apps')
    expect(en.tabMessages).toBe('Messages')

    for (const key of ['tabConversations', 'tabDesktop', 'tabMessages'] as const) {
      expect(en[key]).not.toBe(zh[key])
    }
  })

  it('消息门「最近消息」分组标题有中英文词条', () => {
    const zh = readTabchatLocale('zh-CN')
    const en = readTabchatLocale('en-US')

    expect(zh.recentConversations).toBe('最近消息')
    expect(en.recentConversations).toBe('Recent messages')
    expect(en.recentConversations).not.toBe(zh.recentConversations)
  })

  it('表格 / 文档 / 自动化页副标题有中英文词条', () => {
    const zhHome = (readJsonLocale('zh-CN', 'context.json').home ?? {}) as Record<string, unknown>
    const enHome = (readJsonLocale('en-US', 'context.json').home ?? {}) as Record<string, unknown>
    const zhSubtitle = (zhHome.appHomeSubtitle ?? {}) as Record<string, string>
    const enSubtitle = (enHome.appHomeSubtitle ?? {}) as Record<string, string>

    expect(zhSubtitle.tabdata).toContain('表格')
    expect(zhSubtitle.tabdoc).toContain('文档')
    expect(enSubtitle.tabdata).toBe('Manage tables and structured data in this Workspace')
    expect(enSubtitle.tabdoc).toBe(
      'Manage documents, drafts, and collaborative content in this Workspace',
    )
    expect(enSubtitle.tabdata).not.toBe(zhSubtitle.tabdata)
    expect(enSubtitle.tabdoc).not.toBe(zhSubtitle.tabdoc)

    const zhTrackerHome = (readJsonLocale('zh-CN', 'tabtracker.json').home ?? {}) as Record<
      string,
      string
    >
    const enTrackerHome = (readJsonLocale('en-US', 'tabtracker.json').home ?? {}) as Record<
      string,
      string
    >
    expect(zhTrackerHome.subtitle).toContain('自动化')
    expect(enTrackerHome.subtitle).toBe(
      'Create and manage Agent automation tasks that run on a schedule',
    )
    expect(enTrackerHome.subtitle).not.toBe(zhTrackerHome.subtitle)
  })
})

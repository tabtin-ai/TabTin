/**
 * Wave 5b S3 — SaveBlacklistSection 单测。
 *
 * 覆盖：
 *   1. 列表渲染：拉到 entries 后正确展示 domain + 添加时间
 *   2. 删除流程：点删除按钮 → ConfirmDialog 弹出 → 确认 → 调 mutation
 *   3. 空状态：entries=[] 时显示友好提示
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

// 用 vi.hoisted 让 mock 实例随 vi.mock factory 一起 hoist 到模块顶部。
// 直接闭包引用 outer const 会触发 "Cannot access 'X' before initialization"。
const hoisted = vi.hoisted(() => ({
  useSaveBlacklistQuery: vi.fn(),
  mutateAsync: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('@/hooks/queries/credentials', () => ({
  useSaveBlacklistQuery: () => hoisted.useSaveBlacklistQuery(),
  useDeleteSaveBlacklistEntryMutation: () => ({
    mutateAsync: hoisted.mutateAsync,
    isPending: false,
  }),
}))

// 镜像 zh-CN/settings.json 里 credentialVault.saveBlacklist.* 的关键文案，
// 让 t(key) 返回真实 UI 文字，避免测试断言里写 "key 名" 这种脆弱写法。
const ZH_DICT: Record<string, string> = {
  'credentialVault.saveBlacklist.title': '已屏蔽保存提示的网站',
  'credentialVault.saveBlacklist.subtitle':
    '这些网站登录后不会弹「保存密码？」提示。移除后下次登录会重新询问是否保存。',
  'credentialVault.saveBlacklist.loading': '加载中...',
  'credentialVault.saveBlacklist.loadFailed': '加载屏蔽列表失败',
  'credentialVault.saveBlacklist.empty': '还没有屏蔽的网站',
  'credentialVault.saveBlacklist.addedAt': '添加于 {{date}}',
  'credentialVault.saveBlacklist.removeAction': '移除',
  'credentialVault.saveBlacklist.removeConfirmTitle': '恢复保存提示？',
  'credentialVault.saveBlacklist.removeConfirmDesc':
    '移除后下次在 {{domain}} 登录时，会重新弹出「保存密码？」提示。',
  'credentialVault.saveBlacklist.removeSuccess': '已恢复对 {{domain}} 的保存提示',
  'credentialVault.saveBlacklist.removeFailed': '移除失败，请稍后重试',
}

function interpolate(s: string, opts: Record<string, unknown> = {}): string {
  let out = s
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'defaultValue') continue
    out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
  }
  return out
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      const dict = ZH_DICT[key]
      if (dict !== undefined) return interpolate(dict, opts)
      if (opts?.defaultValue) return interpolate(opts.defaultValue as string, opts)
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ConfirmDialog: ({ open, title, description, onConfirm, onOpenChange }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <div data-testid="confirm-title">{title}</div>
        <div data-testid="confirm-desc">{description}</div>
        <button data-testid="confirm-yes" onClick={onConfirm}>Yes</button>
        <button data-testid="confirm-no" onClick={() => onOpenChange?.(false)}>No</button>
      </div>
    ) : null,
  toast: (...args: any[]) => hoisted.toast(...args),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

vi.mock('../../../SettingsSectionCard', () => ({
  SettingsSectionCard: ({ children, title, subtitle }: any) => (
    <section>
      <h3>{title}</h3>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  ManagementCardListSkeleton: () => <div data-testid="skeleton" />,
}))

vi.mock('../../../settingsUi', () => ({
  SETTINGS_HOVER_ACTION: 'mock-hover-action',
  SETTINGS_HINT: 'mock-settings-hint',
  SETTINGS_TEXT_MICRO: 'mock-settings-micro',
}))

import { SaveBlacklistSection } from '../SaveBlacklistSection'

const mockUseSaveBlacklistQuery = hoisted.useSaveBlacklistQuery
const mockMutateAsync = hoisted.mutateAsync
const mockToast = hoisted.toast

describe('SaveBlacklistSection', () => {
  beforeEach(() => {
    mockUseSaveBlacklistQuery.mockReset()
    mockMutateAsync.mockReset()
    mockToast.mockReset()
  })

  it('Scenario 1：渲染屏蔽条目列表', () => {
    mockUseSaveBlacklistQuery.mockReturnValue({
      data: [
        {
          id: 'b1',
          domain: 'example.com',
          created_at: '2026-04-26T10:00:00Z',
        },
        {
          id: 'b2',
          domain: 'github.com',
          created_at: '2026-04-25T08:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    })

    render(<SaveBlacklistSection />)
    expect(screen.getByText('example.com')).toBeTruthy()
    expect(screen.getByText('github.com')).toBeTruthy()
  })

  it('Scenario 2：空状态显示友好提示', () => {
    mockUseSaveBlacklistQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    })

    render(<SaveBlacklistSection />)
    expect(screen.getByText('还没有屏蔽的网站')).toBeTruthy()
  })

  it('Scenario 3：删除流程：点击 → 确认 → mutation 调用', async () => {
    mockUseSaveBlacklistQuery.mockReturnValue({
      data: [
        {
          id: 'b1',
          domain: 'example.com',
          created_at: '2026-04-26T10:00:00Z',
        },
      ],
      isLoading: false,
      error: null,
    })
    mockMutateAsync.mockResolvedValue('example.com')

    render(<SaveBlacklistSection />)

    // 点删除按钮
    const removeBtn = screen.getAllByText('移除')[0]
    fireEvent.click(removeBtn)

    // ConfirmDialog 出现
    expect(screen.getByTestId('confirm-dialog')).toBeTruthy()
    expect(screen.getByTestId('confirm-desc').textContent).toContain('example.com')

    // 确认
    fireEvent.click(screen.getByTestId('confirm-yes'))

    // 等 mutation
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockMutateAsync).toHaveBeenCalledWith('example.com')
  })

  it('Loading 状态展示骨架屏（不阻塞布局）', () => {
    mockUseSaveBlacklistQuery.mockReturnValue({
      data: [],
      isLoading: true,
      error: null,
    })

    render(<SaveBlacklistSection />)
    // 加载态走 ManagementCardListSkeleton（mock 成 data-testid="skeleton"）
    expect(screen.getByTestId('skeleton')).toBeTruthy()
  })

  it('Error 状态触发 toast 通知（不阻塞列表渲染）', () => {
    // 不再让 jsx 文案出现，改成走 toast 通知（更像产品实际行为）。
    mockUseSaveBlacklistQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error('boom'),
    })

    render(<SaveBlacklistSection />)
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '加载屏蔽列表失败',
        variant: 'destructive',
      }),
    )
  })
})

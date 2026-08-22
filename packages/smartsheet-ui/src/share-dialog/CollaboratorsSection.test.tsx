import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceType, SearchedUser } from './types'

const mocks = vi.hoisted(() => ({
  invite: vi.fn(),
  toast: vi.fn(),
  results: [] as Array<{
    id: string
    nickname: string
    username: string
    avatar: string
  }>,
  hasMore: false,
  lastQuery: '',
}))

vi.mock('./hooks/useCollaborators', () => ({
  useCollaborators: () => ({
    owner: {
      user_id: 'owner-1',
      nickname: 'Owner',
      email: 'owner@example.com',
    },
    collaborators: [
      {
        user_id: 'existing-1',
        nickname: 'Existing',
        email: 'existing@example.com',
        permission: 'viewer',
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    invite: mocks.invite,
    updatePermission: vi.fn(),
    remove: vi.fn(),
  }),
}))

vi.mock('./hooks/useMemberSearch', () => ({
  useMemberSearch: (_organizationId: string, query: string) => {
    mocks.lastQuery = query
    return {
      results: mocks.results,
      loading: false,
      loadingMore: false,
      hasMore: mocks.hasMore,
      loadMore: vi.fn(),
    }
  },
}))

vi.mock('../components/toast/use-toast', () => ({ toast: mocks.toast }))

vi.mock('../components/popover', async () => {
  const ReactModule = await import('react')
  const OpenContext = ReactModule.createContext(false)
  return {
    Popover: ({ open, children }: { open: boolean; children: React.ReactNode }) => <OpenContext.Provider value={open}>{children}</OpenContext.Provider>,
    PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    PopoverContent: ({ children, onScroll }: { children: React.ReactNode; onScroll?: React.UIEventHandler<HTMLDivElement> }) => (ReactModule.useContext(OpenContext) ? <div onScroll={onScroll}>{children}</div> : null),
  }
})

import { CollaboratorsSection, DEFAULT_COLLABORATOR_PERMISSION, MAX_COLLABORATOR_INVITE_COUNT, summarizeSelectedUsers } from './CollaboratorsSection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function user(id: string, nickname = id): SearchedUser {
  return { id, nickname, username: `${id}-username`, avatar: '' }
}

function translate(_key: string, options?: Record<string, unknown>): string {
  let value = String(options?.defaultValue ?? _key)
  for (const [key, replacement] of Object.entries(options ?? {})) {
    value = value.replaceAll(`{{${key}}}`, String(replacement))
  }
  return value
}

function renderSection(resourceType: ResourceType = 'table', resourceId = 'resource-1') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const render = (nextType = resourceType, nextId = resourceId) => {
    act(() => {
      root.render(<CollaboratorsSection resourceType={nextType} resourceId={nextId} organizationId="organization-1" canManage t={translate} />)
    })
  }
  render()

  return {
    container,
    render,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function findButton(label: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.trim() === label) ?? null
}

function findButtonContaining(label: string): HTMLButtonElement | null {
  return Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.includes(label)) ?? null
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[placeholder="搜索或浏览同事…"]')
  expect(input).not.toBeNull()
  return input as HTMLInputElement
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CollaboratorsSection', () => {
  beforeEach(() => {
    mocks.results = []
    mocks.hasMore = false
    mocks.lastQuery = ''
    mocks.invite.mockReset().mockResolvedValue({ notified: 0, skipped: [] })
    mocks.toast.mockReset()
    document.body.innerHTML = ''
  })

  it('defaults new collaborator invitations to viewer', () => {
    expect(DEFAULT_COLLABORATOR_PERMISSION).toBe('viewer')
  })

  it('summarizes the first three selected members and the remaining count', () => {
    expect(summarizeSelectedUsers([user('1', '甲'), user('2', '乙'), user('3', '丙'), user('4', '丁')])).toBe('甲、乙、丙，另 1 人')
  })

  it('selects multiple eligible members, removes one, and submits one batch request', async () => {
    mocks.results = [user('owner-1'), user('existing-1'), user('alice', 'Alice'), user('bob', 'Bob'), user('carol', 'Carol'), user('dana', 'Dana')]
    mocks.invite.mockResolvedValue({ notified: 3, skipped: [] })
    const { container, cleanup } = renderSection('doc')

    try {
      click(searchInput(container))
      const candidates = Array.from(document.body.querySelectorAll('button[aria-pressed]'))
      expect(candidates).toHaveLength(4)

      click(findButtonContaining('Alice'))
      click(findButtonContaining('Bob'))
      click(findButtonContaining('Carol'))
      click(findButtonContaining('Dana'))
      expect(container.textContent).toContain('已选：Alice、Bob、Carol，另 1 人')

      click(container.querySelector('button[aria-label="取消选择 Bob"]'))
      expect(container.textContent).toContain('已选：Alice、Carol、Dana')

      await act(async () => {
        findButton('邀请')?.click()
        await Promise.resolve()
      })
      expect(mocks.invite).toHaveBeenCalledTimes(1)
      expect(mocks.invite).toHaveBeenCalledWith(['alice', 'carol', 'dana'], 'viewer')
    } finally {
      cleanup()
    }
  })

  it('selects only the currently filtered, loaded results and explains unloaded members', () => {
    mocks.results = [user('designer-1', 'Design One'), user('designer-2', 'Design Two')]
    mocks.hasMore = true
    const { container, cleanup } = renderSection('table')

    try {
      const input = searchInput(container)
      click(input)
      setInputValue(input, 'design')
      expect(mocks.lastQuery).toBe('design')
      click(findButton('全选当前结果'))

      expect(container.textContent).toContain('已选：Design One、Design Two')
      expect(document.body.textContent).toContain('全选仅作用于当前已加载结果')
      expect(container.textContent).toContain('新加入组织的成员不会自动获得权限')
    } finally {
      cleanup()
    }
  })

  it('caps select-current-results at 50 and gives an explicit limit warning', () => {
    mocks.results = Array.from({ length: 55 }, (_, index) => user(`member-${index + 1}`))
    const { container, cleanup } = renderSection('table')

    try {
      click(searchInput(container))
      click(findButton('全选当前结果'))

      expect(container.textContent).toContain(`50/${MAX_COLLABORATOR_INVITE_COUNT}`)
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '一次最多选择 50 位成员',
          description: expect.stringContaining('当前结果超过上限'),
        }),
      )
    } finally {
      cleanup()
    }
  })

  it('keeps partial-failure feedback after a batch invitation', async () => {
    mocks.results = [user('alice', 'Alice'), user('bob', 'Bob')]
    mocks.invite.mockResolvedValue({
      notified: 1,
      skipped: [{ user_id: 'bob', reason: 'not_in_organization' }],
    })
    const { container, cleanup } = renderSection('doc')

    try {
      click(searchInput(container))
      click(findButton('全选当前结果'))

      await act(async () => {
        findButton('邀请')?.click()
        await Promise.resolve()
      })

      expect(mocks.invite).toHaveBeenCalledWith(['alice', 'bob'], 'viewer')
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: '部分邀请未成功', variant: 'destructive' }),
      )
    } finally {
      cleanup()
    }
  })

  it('clears a pending selection when switching resources', () => {
    mocks.results = [user('alice', 'Alice')]
    const { container, render, cleanup } = renderSection('doc', 'doc-1')

    try {
      click(searchInput(container))
      click(findButtonContaining('Alice'))
      expect(container.textContent).toContain('已选：Alice')

      render('doc', 'doc-2')
      expect(container.textContent).not.toContain('已选：Alice')
      expect(findButton('邀请')?.disabled).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('keeps TabFile on the existing single-select interaction', async () => {
    mocks.results = [user('alice', 'Alice'), user('bob', 'Bob')]
    mocks.invite.mockResolvedValue({ notified: 1, skipped: [] })
    const { container, cleanup } = renderSection('file')

    try {
      click(searchInput(container))
      expect(findButton('全选当前结果')).toBeNull()
      click(findButtonContaining('Alice'))

      expect(searchInput(container).value).toBe('Alice')
      expect(document.body.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
      expect(container.textContent).not.toContain('新加入组织的成员不会自动获得权限')
      expect(container.textContent).toContain('分享文件')
      expect(container.textContent).toContain('接收者只能查看和下载该文件')
      expect(container.textContent).not.toContain('邀请协作者')
      expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(0)

      await act(async () => {
        findButton('分享')?.click()
        await Promise.resolve()
      })
      expect(mocks.invite).toHaveBeenCalledWith(['alice'], 'viewer')
    } finally {
      cleanup()
    }
  })
})

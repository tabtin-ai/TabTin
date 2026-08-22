/**
 * Wave 3 G6 — SavePasswordBar.tsx 单测
 *
 * 覆盖：
 *   - 三种 mode（save / update / new-account）渲染不同标题
 *   - 用户点保存 → 调 saveConfirm({tabId})（renderer 不传 password，符合安全设计）
 *   - 用户点"不为此网站保存" → 调 saveDismiss({domain})
 *   - 用户点 X 按钮 → 立即关闭（不调 IPC）
 *   - 缺 tabId/domain 的非法 payload 被丢弃
 */
import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { SavePasswordBar } from './SavePasswordBar'

type Listener = (payload: any) => void

interface MockTabtinAPI {
  credentialVault: {
    onSavePrompt: ReturnType<typeof vi.fn>
    saveConfirm: ReturnType<typeof vi.fn>
    saveDismiss: ReturnType<typeof vi.fn>
  }
}

let listeners: Listener[] = []

function setupTabtinMock(): MockTabtinAPI {
  listeners = []
  const mock: MockTabtinAPI = {
    credentialVault: {
      onSavePrompt: vi.fn((cb: Listener) => {
        listeners.push(cb)
        return () => {
          listeners = listeners.filter((l) => l !== cb)
        }
      }),
      saveConfirm: vi.fn(async () => ({ success: true, mode: 'save' })),
      saveDismiss: vi.fn(async () => ({ success: true })),
    },
  }
  Object.defineProperty(window, 'tabtin', {
    value: mock,
    writable: true,
    configurable: true,
  })
  return mock
}

function emit(payload: any) {
  act(() => {
    for (const l of listeners) l(payload)
  })
}

describe('SavePasswordBar', () => {
  beforeEach(() => {
    setupTabtinMock()
  })

  it('未收到 prompt → 不渲染任何内容', () => {
    const { container } = render(<SavePasswordBar />)
    expect(container.firstChild).toBeNull()
  })

  it('收到 mode=save → 渲染标题包含 saveTitle key', () => {
    render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'save',
      domain: 'example.com',
      url: 'https://example.com/dashboard',
      username: 'alice',
    })
    expect(screen.getByText(/savePasswordBar.saveTitle/)).toBeTruthy()
    expect(screen.getByText('alice')).toBeTruthy()
  })

  it('收到 mode=update → 标题包含 updateTitle key', () => {
    render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'update',
      domain: 'github.com',
      url: 'https://github.com/dashboard',
      username: 'bob',
      credentialId: 'cred-99',
    })
    expect(screen.getByText(/savePasswordBar.updateTitle/)).toBeTruthy()
  })

  it('收到 mode=new-account → 标题包含 newAccountTitle + 列出已有 username', () => {
    render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'new-account',
      domain: 'twitter.com',
      url: 'https://twitter.com/home',
      username: 'charlie',
      existingUsernames: ['alice', 'bob'],
    })
    expect(screen.getByText(/savePasswordBar.newAccountTitle/)).toBeTruthy()
    expect(screen.getByText(/alice, bob/)).toBeTruthy()
  })

  it('点保存按钮 → 调 saveConfirm({tabId}) 且不传 password', async () => {
    const tabtin = setupTabtinMock()
    const { container } = render(<SavePasswordBar />)
    emit({
      tabId: 'tab-99',
      mode: 'save',
      domain: 'example.com',
      url: 'https://example.com/login',
      username: 'alice',
    })
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(saveBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(saveBtn)
    })
    expect(tabtin.credentialVault.saveConfirm).toHaveBeenCalledTimes(1)
    expect(tabtin.credentialVault.saveConfirm).toHaveBeenCalledWith({ tabId: 'tab-99' })
    // 安全断言：renderer 调用不带 password
    const callArgs = tabtin.credentialVault.saveConfirm.mock.calls[0][0]
    expect(callArgs).not.toHaveProperty('password')
  })

  it('点"不为此网站保存" → 5s 后才调 saveDismiss（延迟写零代价撤销）', async () => {
    // Wave 3 修正版 Review 视角 2 P0-2 自修：handleNever 改为延迟 5s 真写。
    // 期望：点完按钮**不立即**调 saveDismiss；用 fake timer 推进 5s 后才调一次。
    vi.useFakeTimers()
    try {
      const tabtin = setupTabtinMock()
      const { container } = render(<SavePasswordBar />)
      emit({
        tabId: 'tab-1',
        mode: 'save',
        domain: 'banned.com',
        url: 'https://banned.com/login',
        username: 'alice',
      })
      const neverBtn = container.querySelector('[data-action="never"]') as HTMLButtonElement
      expect(neverBtn).toBeTruthy()
      await act(async () => {
        fireEvent.click(neverBtn)
      })
      // 立即检查：不应该已经写过后端
      expect(tabtin.credentialVault.saveDismiss).not.toHaveBeenCalled()
      // 推进 5s 触发 timer
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })
      expect(tabtin.credentialVault.saveDismiss).toHaveBeenCalledTimes(1)
      expect(tabtin.credentialVault.saveDismiss).toHaveBeenCalledWith({ domain: 'banned.com' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('点"不为此网站保存"后 4s 推进（未到 5s）→ saveDismiss 仍未触发', async () => {
    // Wave 3 修正版 Review 视角 2 P0-2 自修：撤销窗口期内不打后端，保证
    // 用户即便错过 UI 撤销按钮也不会消耗 API 配额。
    vi.useFakeTimers()
    try {
      const tabtin = setupTabtinMock()
      const { container } = render(<SavePasswordBar />)
      emit({
        tabId: 'tab-1',
        mode: 'save',
        domain: 'never.example.com',
        url: 'https://never.example.com/login',
        username: 'alice',
      })
      const neverBtn = container.querySelector('[data-action="never"]') as HTMLButtonElement
      await act(async () => {
        fireEvent.click(neverBtn)
      })
      // 推进 4s（不到 UNDISMISS_WINDOW_MS=5s）
      await act(async () => {
        vi.advanceTimersByTime(4000)
      })
      // saveDismiss 不应被调（pending timer 未到期）
      expect(tabtin.credentialVault.saveDismiss).not.toHaveBeenCalled()
      // 再推进 1.5s（累计 5.5s）→ pending timer 触发
      await act(async () => {
        vi.advanceTimersByTime(1500)
      })
      expect(tabtin.credentialVault.saveDismiss).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('点 X 关闭按钮 → 不调任何 IPC，立即消失', async () => {
    const tabtin = setupTabtinMock()
    const { container } = render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'save',
      domain: 'example.com',
      url: 'https://example.com/login',
      username: 'alice',
    })
    const dismissBtn = container.querySelector('[data-action="dismiss"]') as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(dismissBtn)
    })
    expect(tabtin.credentialVault.saveConfirm).not.toHaveBeenCalled()
    expect(tabtin.credentialVault.saveDismiss).not.toHaveBeenCalled()
    expect(container.querySelector('[data-component="SavePasswordBar"]')).toBeNull()
  })

  it('收到 invalid payload (缺 tabId) → 丢弃不渲染', () => {
    render(<SavePasswordBar />)
    emit({
      mode: 'save',
      domain: 'example.com',
      url: 'https://example.com/login',
      username: 'alice',
    })
    expect(screen.queryByText(/savePasswordBar.saveTitle/)).toBeNull()
  })

  it('收到 invalid payload (缺 domain) → 丢弃不渲染', () => {
    render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'save',
      url: 'https://example.com/login',
      username: 'alice',
    })
    expect(screen.queryByText(/savePasswordBar.saveTitle/)).toBeNull()
  })

  it('saveConfirm 失败 → 显示 error feedback', async () => {
    const tabtin = setupTabtinMock()
    tabtin.credentialVault.saveConfirm = vi.fn(async () => ({ success: false, error: 'backend down' }))
    const { container } = render(<SavePasswordBar />)
    emit({
      tabId: 'tab-1',
      mode: 'save',
      domain: 'example.com',
      url: 'https://example.com/login',
      username: 'alice',
    })
    const saveBtn = container.querySelector('[data-action="save"]') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
    })
    expect(await screen.findByText('backend down')).toBeTruthy()
  })
})

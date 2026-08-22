/**
 * ClearConfirmDialog 守护测试 — 确保 4 档 Affordance 严格按 D-4 实现：
 *
 *   - L1：不渲染对话框，立即调 onClear（兜底场景才进 dialog，进了也立即关）
 *   - L2：单按钮直接确认（无输入校验）
 *   - L3-soft：必须输入正确 displayName 才 enable 确认按钮
 *   - L3-hard：除输入名字外，必须勾选 checkbox 才 enable
 *   - L4：除输入名字 + 勾选 checkbox 外，确认时显示进度条
 *
 * 这些是 D-4 的红线，任何回归 == 用户可能误删 data。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ClearConfirmDialog } from '../ClearConfirmDialog'
import type { BucketDescriptor } from '../types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [k: string]: unknown }) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
    i18n: { language: 'zh-CN' },
  }),
}))

function makeDescriptor(
  overrides: Partial<BucketDescriptor> = {},
): BucketDescriptor {
  return {
    id: 'test:bucket',
    category: 'data',
    group: 'business-app',
    displayName: '测试桶',
    description: '一句话说明',
    requiresConfirmation: 'soft',
    hideFromList: false,
    capabilities: { canList: false, canClear: true, canExport: false },
    warnings: ['会丢一些东西'],
    ...overrides,
  }
}

describe('ClearConfirmDialog (W3.2 D-4 守护)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('L1：cache + none 不渲染对话框，立即调 onClear 并关闭', async () => {
    const onClear = vi.fn().mockResolvedValue({
      id: 'cache:test',
      dryRun: false,
      clearedItemCount: 1,
      freedBytes: 100,
    })
    const onOpenChange = vi.fn()
    const cacheDescriptor = makeDescriptor({
      id: 'cache:test',
      category: 'cache',
      group: 'cache',
      requiresConfirmation: 'none',
      warnings: undefined,
    })

    const { container } = render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        descriptor={cacheDescriptor}
        onClear={onClear}
      />,
    )

    // L1 不应有任何对话框 DOM 渲染
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(
      container.querySelector('[data-testid^="clear-confirm-dialog-"]'),
    ).toBeNull()

    // 但 onClear 应被立即调用（useEffect 兜底）
    await waitFor(() => {
      expect(onClear).toHaveBeenCalledWith('cache:test')
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it('L2：semi-cache + soft 单按钮直接确认（无输入）', async () => {
    const onClear = vi.fn().mockResolvedValue({
      id: 'semi:test',
      dryRun: false,
      clearedItemCount: 1,
      freedBytes: 100,
    })
    const semiDescriptor = makeDescriptor({
      id: 'semi:test',
      category: 'semi-cache',
      group: 'cache',
      requiresConfirmation: 'soft',
      warnings: undefined,
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={semiDescriptor}
        onClear={onClear}
      />,
    )

    const dialog = await screen.findByTestId('clear-confirm-dialog-L2')
    expect(dialog).toBeTruthy()

    // L2 没有名称输入框
    expect(
      screen.queryByTestId('clear-confirm-name-input'),
    ).toBeNull()
    // 也没有 checkbox
    expect(screen.queryByTestId('clear-confirm-acknowledge')).toBeNull()

    // 确认按钮直接可用
    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)

    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(onClear).toHaveBeenCalledWith('semi:test')
    })
  })

  it('L3-soft：「填充」将 displayName 写入输入框并启用确认', async () => {
    const onClear = vi.fn().mockResolvedValue({
      id: 'data:soft',
      dryRun: false,
      clearedItemCount: 1,
      freedBytes: 100,
    })
    const dataDescriptor = makeDescriptor({
      id: 'data:soft',
      category: 'data',
      requiresConfirmation: 'soft',
      displayName: 'work-for-TabTin · 项目操作快照',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={onClear}
      />,
    )

    await screen.findByTestId('clear-confirm-dialog-L3-soft')
    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    expect(screen.getByTestId('clear-confirm-fill-name')).toBeTruthy()

    fireEvent.click(screen.getByTestId('clear-confirm-fill-name'))
    expect(input.value).toBe('work-for-TabTin · 项目操作快照')
    expect(confirmBtn.disabled).toBe(false)

    fireEvent.click(confirmBtn)
    await waitFor(() => {
      expect(onClear).toHaveBeenCalledWith('data:soft')
    })
  })

  it('L3-soft：showNameFill=false 时不展示「填充」', async () => {
    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={makeDescriptor({
          id: 'data:soft',
          category: 'data',
          requiresConfirmation: 'soft',
          displayName: '测试桶',
        })}
        onClear={vi.fn()}
        showNameFill={false}
      />,
    )
    await screen.findByTestId('clear-confirm-dialog-L3-soft')
    expect(screen.queryByTestId('clear-confirm-fill-name')).toBeNull()
  })

  it('L3-soft：data + soft 必须输入完整 displayName 才 enable 确认按钮', () => {
    const onClear = vi.fn()
    const dataDescriptor = makeDescriptor({
      id: 'data:soft',
      category: 'data',
      requiresConfirmation: 'soft',
      displayName: '测试桶',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={onClear}
      />,
    )

    expect(screen.getByTestId('clear-confirm-dialog-L3-soft')).toBeTruthy()

    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement

    // 初始 disabled
    expect(confirmBtn.disabled).toBe(true)

    // 输入部分名字 — 仍 disabled
    fireEvent.change(input, { target: { value: '测试' } })
    expect(confirmBtn.disabled).toBe(true)

    // 输入完整名字 — 应 enabled
    fireEvent.change(input, { target: { value: '测试桶' } })
    expect(confirmBtn.disabled).toBe(false)
  })

  it('L3-soft：大小写 + 前后空白容错（trim + lowercase 比较）', () => {
    const dataDescriptor = makeDescriptor({
      id: 'data:soft',
      category: 'data',
      requiresConfirmation: 'soft',
      displayName: 'Voice Hotwords',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )

    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement

    fireEvent.change(input, { target: { value: '  voice hotwords  ' } })
    expect(confirmBtn.disabled).toBe(false)
  })

  it('L3-hard：必须输入 displayName + 勾选 checkbox 才 enable', async () => {
    const dataDescriptor = makeDescriptor({
      id: 'data:hard',
      category: 'data',
      group: 'business-app',
      requiresConfirmation: 'hard',
      displayName: '关键资产',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )

    expect(screen.getByTestId('clear-confirm-dialog-L3-hard')).toBeTruthy()

    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    const checkbox = screen.getByTestId('clear-confirm-acknowledge')

    expect(confirmBtn.disabled).toBe(true)

    // 只输入名字 — 还差 checkbox
    fireEvent.change(input, { target: { value: '关键资产' } })
    expect(confirmBtn.disabled).toBe(true)

    // 只勾选 checkbox（无名字）— 也 disabled
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(checkbox)
    expect(confirmBtn.disabled).toBe(true)

    // 两者齐 — enabled
    fireEvent.change(input, { target: { value: '关键资产' } })
    if (checkbox.getAttribute('data-state') !== 'checked') {
      fireEvent.click(checkbox)
    }
    await waitFor(() => {
      expect(checkbox.getAttribute('data-state')).toBe('checked')
    })
    await waitFor(() => {
      expect(confirmBtn.disabled).toBe(false)
    })
  })

  it('L4：login 组 + hard → 走最严格档（含 checkbox）', () => {
    const dataDescriptor = makeDescriptor({
      id: 'login:auth',
      category: 'data',
      group: 'login',
      requiresConfirmation: 'hard',
      displayName: '登录态',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )

    // L4 dialog 应该被渲染（不是 L3-hard）
    expect(screen.getByTestId('clear-confirm-dialog-L4')).toBeTruthy()

    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)

    // L4 同样有 input + checkbox
    expect(screen.getByTestId('clear-confirm-name-input')).toBeTruthy()
    expect(screen.getByTestId('clear-confirm-acknowledge')).toBeTruthy()
  })

  it('L4：system 组 + hard → 走最严格档', () => {
    const dataDescriptor = makeDescriptor({
      id: 'system:fingerprint',
      category: 'data',
      group: 'system',
      requiresConfirmation: 'hard',
      displayName: '设备 fingerprint',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )

    expect(screen.getByTestId('clear-confirm-dialog-L4')).toBeTruthy()
  })

  it('warnings 列表正确渲染', () => {
    const dataDescriptor = makeDescriptor({
      warnings: ['丢失 A', '丢失 B', '丢失 C'],
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )

    expect(screen.getByText('丢失 A')).toBeTruthy()
    expect(screen.getByText('丢失 B')).toBeTruthy()
    expect(screen.getByText('丢失 C')).toBeTruthy()
  })

  it('R2-M5：result.errors 非空时不静默关闭，显示部分失败列表 + 切换按钮为「我已了解」', async () => {
    const onClear = vi.fn().mockResolvedValue({
      id: 'data:partial',
      dryRun: false,
      clearedItemCount: 3,
      freedBytes: 1024,
      errors: ['bucket A 清失败：权限不足', 'bucket B 清失败：正在使用'],
    })
    const onOpenChange = vi.fn()
    const onCleared = vi.fn()
    const dataDescriptor = makeDescriptor({
      id: 'data:partial',
      category: 'data',
      requiresConfirmation: 'soft',
      displayName: '部分失败测试',
    })

    render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        descriptor={dataDescriptor}
        onClear={onClear}
        onCleared={onCleared}
      />,
    )

    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '部分失败测试' } })
    const confirmBtn = screen.getByTestId('clear-confirm-confirm') as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
    fireEvent.click(confirmBtn)

    // 等到 onClear 被调用
    await waitFor(() => {
      expect(onClear).toHaveBeenCalledWith('data:partial')
    })

    // 部分失败列表应渲染
    await waitFor(() => {
      expect(
        screen.getByTestId('clear-confirm-partial-errors'),
      ).toBeTruthy()
    })

    // 错误条目应可见
    expect(screen.getByText('bucket A 清失败：权限不足')).toBeTruthy()
    expect(screen.getByText('bucket B 清失败：正在使用')).toBeTruthy()

    // 不应自动关闭对话框（onOpenChange 不应被调到 false）
    const closeCalls = onOpenChange.mock.calls.filter((args) => args[0] === false)
    expect(closeCalls.length).toBe(0)

    // onCleared 不应被调（因为部分失败，不算"成功完成"）
    expect(onCleared).not.toHaveBeenCalled()

    // 应出现"我已了解"按钮
    expect(
      screen.getByTestId('clear-confirm-acknowledge-partial'),
    ).toBeTruthy()
  })

  it('打开时重置输入状态（避免上次残留）', () => {
    const dataDescriptor = makeDescriptor({
      id: 'data:reset',
      category: 'data',
      requiresConfirmation: 'soft',
      displayName: '重置测试',
    })

    const { rerender } = render(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )
    const input = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '重置测试' } })
    expect(input.value).toBe('重置测试')

    // 关闭 → 重新打开
    rerender(
      <ClearConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )
    rerender(
      <ClearConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        descriptor={dataDescriptor}
        onClear={vi.fn()}
      />,
    )
    const inputAfter = screen.getByTestId('clear-confirm-name-input') as HTMLInputElement
    expect(inputAfter.value).toBe('')
  })
})

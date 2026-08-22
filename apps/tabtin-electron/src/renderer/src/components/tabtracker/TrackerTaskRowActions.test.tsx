import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TrackerTask } from '@/services/trackerApi'

const { deleteTask, patchTaskFromWS, setDialogState, toastSuccess, triggerTask } = vi.hoisted(() => ({
  deleteTask: vi.fn(),
  patchTaskFromWS: vi.fn(),
  setDialogState: vi.fn(),
  toastSuccess: vi.fn(),
  triggerTask: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: (selector: (state: unknown) => unknown) => selector({
    deleteTask,
    patchTaskFromWS,
    setDialogState,
  }),
}))

vi.mock('@/services/trackerApi', () => ({
  activateTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  triggerTask,
}))

vi.mock('@/services/invalidateTrackerAfterTrigger', () => ({
  invalidateTrackerAfterTrigger: vi.fn(),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  Switch: ({ onCheckedChange: _onCheckedChange, ...props }: {
    onCheckedChange?: (checked: boolean) => void
  } & React.ComponentProps<'button'>) => <button {...props} />,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onSelect, ...props }: {
    children: React.ReactNode
    onSelect?: () => void
  } & React.ComponentProps<'button'>) => (
    <button {...props} onClick={onSelect}>{children}</button>
  ),
  ConfirmDialog: ({ open, title, description, confirmText, onConfirm }: {
    open: boolean
    title?: string
    description?: string
    confirmText?: string
    onConfirm: () => void | Promise<void>
  }) => open ? (
    <div role="dialog">
      <div>{title}</div>
      <div>{description}</div>
      <button type="button" onClick={() => void onConfirm()}>{confirmText}</button>
    </div>
  ) : null,
  toast: {
    success: toastSuccess,
    error: vi.fn(),
  },
}))

import { TrackerTaskRowActions } from './TrackerTaskRowActions'

const task: TrackerTask = {
  id: 'task-1',
  name: '每日新闻',
  description: '',
  status: 'active',
  trigger_type: 'cron',
  trigger_config: { cron_expression: '0 9 * * *' },
  skill_key: 'agent',
  total_runs: 2,
  success_runs: 2,
  fail_runs: 0,
  last_run_at: null,
  next_run_at: '2026-08-13T01:00:00Z',
  created_at: '2026-08-12T01:00:00Z',
  updated_at: '2026-08-12T01:00:00Z',
}

describe('TrackerTaskRowActions', () => {
  beforeEach(() => {
    deleteTask.mockReset().mockResolvedValue(true)
    patchTaskFromWS.mockReset()
    setDialogState.mockReset()
    toastSuccess.mockReset()
    triggerTask.mockReset().mockResolvedValue({})
  })

  it('列表更多菜单允许确认删除定时任务', async () => {
    render(<TrackerTaskRowActions task={task} />)

    fireEvent.click(screen.getByText('detail.actions.delete'))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('detail.actions.confirmDeleteTitle')).toBeTruthy()
    expect(screen.getByText('detail.actions.confirmDeleteHint')).toBeTruthy()

    fireEvent.click(screen.getByText('detail.actions.confirmDelete'))

    await waitFor(() => {
      expect(deleteTask).toHaveBeenCalledWith('task-1')
      expect(toastSuccess).toHaveBeenCalledWith('detail.actions.deleted')
    })
  })

  it('暂停任务仍允许立即执行且不会先恢复自动调度', async () => {
    render(<TrackerTaskRowActions task={{ ...task, status: 'paused' }} />)

    fireEvent.click(screen.getByText('detail.actions.trigger'))

    await waitFor(() => {
      expect(triggerTask).toHaveBeenCalledWith('task-1')
      expect(patchTaskFromWS).not.toHaveBeenCalled()
      expect(toastSuccess).toHaveBeenCalledWith('detail.actions.triggered')
    })
  })
})

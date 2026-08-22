import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesPanel } from './ChangesPanel'
import type { ChangeFile } from './useGitWorkflowData'

const mocks = vi.hoisted(() => ({
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  discardFiles: vi.fn(),
  runGitAction: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'gitFlow.confirmDiscard') return `confirm discard ${String(options?.path ?? '')}`
      if (key === 'gitFlow.confirmDiscardUntracked') {
        return `confirm delete untracked ${String(options?.path ?? '')}`
      }
      if (key === 'gitFlow.confirmDiscardMany') {
        return `confirm discard many ${String(options?.count ?? '')}`
      }
      if (key === 'gitFlow.confirmDiscardUntrackedMany') {
        return `confirm delete untracked many ${String(options?.count ?? '')}`
      }
      if (key === 'gitFlow.openConflictFile') return `open conflict ${String(options?.path ?? '')}`
      if (key === 'gitFlow.viewFileDiff') return `view ${String(options?.path ?? '')}`
      return key
    },
  }),
}))

vi.mock('../TabCodeConfirmDialog', () => ({
  TabCodeConfirmDialog: ({
    open,
    description,
    onConfirm,
  }: {
    open: boolean
    description: string
    onConfirm: () => void
  }) => (open ? (
    <div>
      <span>{description}</span>
      <button type="button" onClick={onConfirm}>confirm-discard</button>
    </div>
  ) : null),
}))

function makeFile(partial: Partial<ChangeFile> & Pick<ChangeFile, 'path'>): ChangeFile {
  return {
    status: 'M',
    staged: false,
    unstaged: true,
    partiallyStaged: false,
    added: 1,
    deleted: 0,
    untracked: false,
    conflict: false,
    ...partial,
  }
}

function renderPanel(files: ChangeFile[], onSelectChangeFile = vi.fn()) {
  mocks.runGitAction.mockImplementation(async (_key, action) => {
    await action()
    return true
  })
  return render(
    <ChangesPanel
      rootPath="/repo"
      files={files}
      isLoading={false}
      actionKey={null}
      runGitAction={mocks.runGitAction}
      inlineDiff={false}
      onSelectChangeFile={onSelectChangeFile}
    />,
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      git: {
        stageFiles: mocks.stageFiles,
        unstageFiles: mocks.unstageFiles,
        discardFiles: mocks.discardFiles,
      },
    },
  })
  mocks.stageFiles.mockResolvedValue({ success: true })
  mocks.unstageFiles.mockResolvedValue({ success: true })
  mocks.discardFiles.mockResolvedValue({ success: true })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChangesPanel', () => {
  it('平铺三区：无 checkbox、无目录分组标题，部分暂存双入口', () => {
    renderPanel([
      makeFile({ path: 'conflict.ts', status: 'U', conflict: true, staged: false, unstaged: false }),
      makeFile({ path: 'src/staged.ts', staged: true, unstaged: false }),
      makeFile({
        path: 'apps/partial.ts',
        staged: true,
        unstaged: true,
        partiallyStaged: true,
      }),
      makeFile({ path: 'dirty.ts', staged: false, unstaged: true }),
    ])

    expect(screen.getByText('gitFlow.conflictsSection')).toBeTruthy()
    expect(screen.getByText('gitFlow.stagedFiles')).toBeTruthy()
    expect(screen.getByText('gitFlow.unstagedFiles')).toBeTruthy()

    // 无复选框
    expect(screen.queryByLabelText('gitFlow.toggleStage')).toBeNull()
    expect(screen.queryByText('checkbox')).toBeNull()

    // 无目录分组标题（旧实现会显示 "src/" / "(根目录)"）
    expect(screen.queryByText('src/')).toBeNull()
    expect(screen.queryByText('(根目录)')).toBeNull()

    const stagedSection = screen.getByText('gitFlow.stagedFiles').closest('section')
    const unstagedSection = screen.getByText('gitFlow.unstagedFiles').closest('section')
    expect(stagedSection).toBeTruthy()
    expect(unstagedSection).toBeTruthy()

    // 文件名在前、目录淡色
    expect(within(stagedSection as HTMLElement).getByText('partial.ts')).toBeTruthy()
    expect(within(stagedSection as HTMLElement).getByText('apps')).toBeTruthy()
    expect(within(unstagedSection as HTMLElement).getByText('partial.ts')).toBeTruthy()
    expect(screen.getByLabelText('open conflict conflict.ts')).toBeTruthy()
  })

  it('行级图标：暂存 / 取消暂存 / Discard 二次确认；未跟踪也可丢弃', async () => {
    renderPanel([
      makeFile({ path: 'src/a.ts', staged: false, unstaged: true }),
      makeFile({ path: 'new.ts', status: '?', untracked: true, staged: false, unstaged: true }),
      makeFile({ path: 'b.ts', staged: true, unstaged: false }),
    ])

    const discardButtons = screen.getAllByLabelText('gitFlow.discardChanges')
    expect(discardButtons).toHaveLength(2)

    fireEvent.click(discardButtons[0]!)
    expect(screen.getByText('confirm discard src/a.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'confirm-discard' }))
    await waitFor(() => expect(mocks.discardFiles).toHaveBeenCalledWith('/repo', ['src/a.ts']))

    fireEvent.click(screen.getAllByLabelText('gitFlow.discardChanges')[1]!)
    expect(screen.getByText('confirm delete untracked new.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'confirm-discard' }))
    await waitFor(() => expect(mocks.discardFiles).toHaveBeenCalledWith('/repo', ['new.ts']))

    const aRow = screen.getByLabelText('view src/a.ts').parentElement as HTMLElement
    fireEvent.click(within(aRow).getByLabelText('gitFlow.stageFile'))
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledWith('/repo', ['src/a.ts']))

    const bRow = screen.getByLabelText('view b.ts').parentElement as HTMLElement
    fireEvent.click(within(bRow).getByLabelText('gitFlow.unstageFile'))
    await waitFor(() => expect(mocks.unstageFiles).toHaveBeenCalledWith('/repo', ['b.ts']))
  })

  it('行操作默认 hidden、悬浮占流；未跟踪显示绿色 U；分区计数为胶囊', () => {
    const { container } = renderPanel([
      makeFile({ path: 'new.ts', status: '?', untracked: true, staged: false, unstaged: true }),
      makeFile({ path: 'b.ts', staged: true, unstaged: false }),
    ])

    const actionWraps = container.querySelectorAll('[data-testid="change-row-actions"]')
    expect(actionWraps.length).toBeGreaterThan(0)
    actionWraps.forEach((el) => {
      expect(el.className.split(/\s+/)).toContain('hidden')
      expect(el.className).toContain('group-hover/row:flex')
      expect(el.className).not.toContain('absolute')
    })

    const untrackedBadge = screen.getByTitle('未跟踪')
    expect(untrackedBadge.textContent).toBe('U')
    expect(untrackedBadge.className).toContain('text-muted-foreground')

    const stagedHeader = screen.getByText('gitFlow.stagedFiles').closest('div')
    expect(stagedHeader).toBeTruthy()
    const countPill = within(stagedHeader as HTMLElement).getByText('1')
    expect(countPill.className).toContain('rounded-full')
    expect(countPill.className).toContain('bg-primary/15')
    expect(countPill.className).toContain('text-primary-text')
  })

  it('冲突文件点击打开编辑器，标记已解决会 stage', async () => {
    const onSelect = vi.fn()
    renderPanel(
      [makeFile({ path: 'conflict.ts', status: 'U', conflict: true, staged: false, unstaged: false })],
      onSelect,
    )

    fireEvent.click(screen.getByLabelText('open conflict conflict.ts'))
    expect(onSelect).toHaveBeenCalledWith('/repo/conflict.ts', undefined)

    fireEvent.click(screen.getByLabelText('gitFlow.markResolved'))
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledWith('/repo', ['conflict.ts']))
  })

  it('单击选中高亮；Shift 同分区连续选后批量暂存', async () => {
    const onSelect = vi.fn()
    renderPanel(
      [
        makeFile({ path: 'a.ts', staged: false, unstaged: true }),
        makeFile({ path: 'b.ts', staged: false, unstaged: true }),
        makeFile({ path: 'c.ts', staged: false, unstaged: true }),
        makeFile({ path: 's.ts', staged: true, unstaged: false }),
      ],
      onSelect,
    )

    fireEvent.click(screen.getByLabelText('view a.ts'))
    expect(onSelect).toHaveBeenCalledWith('/repo/a.ts', 'unstaged')
    const aButton = screen.getByLabelText('view a.ts')
    expect(aButton.getAttribute('aria-selected')).toBe('true')
    expect(aButton.parentElement?.getAttribute('data-selected')).toBe('true')
    expect(aButton.parentElement?.className).toContain('surface-row-active')

    fireEvent.click(screen.getByLabelText('view c.ts'), { shiftKey: true })
    // Shift 不打开 Diff
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('view b.ts').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('view c.ts').getAttribute('aria-selected')).toBe('true')
    // 跨分区：staged 不应被 Shift 扩选
    expect(screen.getByLabelText('view s.ts').getAttribute('aria-selected')).not.toBe('true')

    const bRow = screen.getByLabelText('view b.ts').parentElement as HTMLElement
    fireEvent.click(within(bRow).getByLabelText('gitFlow.stageFile'))
    await waitFor(() => {
      expect(mocks.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts', 'c.ts'])
    })
  })

  it('Cmd 点选切换；点未选中行的 Stage 仍单文件', async () => {
    renderPanel([
      makeFile({ path: 'a.ts', staged: false, unstaged: true }),
      makeFile({ path: 'b.ts', staged: false, unstaged: true }),
      makeFile({ path: 'c.ts', staged: false, unstaged: true }),
    ])

    fireEvent.click(screen.getByLabelText('view a.ts'))
    fireEvent.click(screen.getByLabelText('view c.ts'), { metaKey: true })
    expect(screen.getByLabelText('view a.ts').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('view c.ts').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText('view b.ts').getAttribute('aria-selected')).not.toBe('true')

    // 点未选中的 b 的 Stage → 只 stage b
    const bRow = screen.getByLabelText('view b.ts').parentElement as HTMLElement
    fireEvent.click(within(bRow).getByLabelText('gitFlow.stageFile'))
    await waitFor(() => expect(mocks.stageFiles).toHaveBeenCalledWith('/repo', ['b.ts']))
  })

  it('多选后取消暂存与丢弃可批量', async () => {
    renderPanel([
      makeFile({ path: 's1.ts', staged: true, unstaged: false }),
      makeFile({ path: 's2.ts', staged: true, unstaged: false }),
      makeFile({ path: 'u1.ts', staged: false, unstaged: true }),
      makeFile({ path: 'u2.ts', staged: false, unstaged: true }),
    ])

    fireEvent.click(screen.getByLabelText('view s1.ts'))
    fireEvent.click(screen.getByLabelText('view s2.ts'), { shiftKey: true })
    const s1Row = screen.getByLabelText('view s1.ts').parentElement as HTMLElement
    fireEvent.click(within(s1Row).getByLabelText('gitFlow.unstageFile'))
    await waitFor(() => {
      expect(mocks.unstageFiles).toHaveBeenCalledWith('/repo', ['s1.ts', 's2.ts'])
    })

    fireEvent.click(screen.getByLabelText('view u1.ts'))
    fireEvent.click(screen.getByLabelText('view u2.ts'), { shiftKey: true })
    const u1Row = screen.getByLabelText('view u1.ts').parentElement as HTMLElement
    fireEvent.click(within(u1Row).getByLabelText('gitFlow.discardChanges'))
    expect(screen.getByText('confirm discard many 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'confirm-discard' }))
    await waitFor(() => {
      expect(mocks.discardFiles).toHaveBeenCalledWith('/repo', ['u1.ts', 'u2.ts'])
    })
  })

  it('删除文件只给文件名加删除线，目录路径不加', () => {
    renderPanel([
      makeFile({ path: 'src/gone.ts', status: 'D', staged: false, unstaged: true }),
      makeFile({ path: 'src/keep.ts', status: 'M', staged: false, unstaged: true }),
    ])

    const goneName = screen.getByText('gone.ts')
    expect(goneName.className).toContain('line-through')
    expect(goneName.className).toContain('text-muted-foreground')

    const keepName = screen.getByText('keep.ts')
    expect(keepName.className).not.toContain('line-through')

    const goneDir = goneName.parentElement?.querySelector('.text-micro')
    expect(goneDir?.textContent).toBe('src')
    expect(goneDir?.className).not.toContain('line-through')
  })
})

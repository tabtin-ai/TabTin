import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requestTaskFocus: vi.fn(),
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: vi.fn(),
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({
      requestTaskFocus: mocks.requestTaskFocus,
    }),
  },
}))

import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { focusProjectTask } from '../focusProjectTask'

describe('focusProjectTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('进入 Project 并写入 pending task focus', () => {
    focusProjectTask({ projectId: 'proj-1', taskId: 'task-1' })

    expect(enterTeamSpaceProject).toHaveBeenCalledWith('proj-1')
    expect(mocks.requestTaskFocus).toHaveBeenCalledWith('proj-1', 'task-1')
  })
})

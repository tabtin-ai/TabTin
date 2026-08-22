/**
 * 进入 Project 并定位到指定任务（无执行 session 时走任务详情，与 ProjectTasksPane 一致）。
 */
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'

export function focusProjectTask(input: {
  projectId: string
  taskId: string
}): void {
  enterTeamSpaceProject(input.projectId)
  useProjectWorkspaceSelectionStore.getState().requestTaskFocus(input.projectId, input.taskId)
}

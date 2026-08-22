import { describe, expect, it } from 'vitest'
import { shouldInjectProjectTaskSkill } from '../../runtime/project-task-skill-gate'

const projectSkill = 'app:tabtin-project/tabtin-project'

describe('Electron Project Task runtime gate', () => {
  it('非 Project Task skill 始终保留在普通 prompt skill index 中', () => {
    expect(shouldInjectProjectTaskSkill('platform:device/operations', {
      appType: 'chat',
    })).toBe(true)
    expect(shouldInjectProjectTaskSkill('app:tabdoc/tabdoc-operator', null)).toBe(true)
  })

  it('只把带权威 project/task 锚点的 app context 视为 Project Skill 执行上下文', () => {
    expect(shouldInjectProjectTaskSkill(projectSkill, {
      appType: 'project_task',
      appMeta: { project_id: 'project-1', task_id: 'task-1' },
    })).toBe(true)

    // project_id + task_id 是权威锚点；视觉 appType 可随导航变化。
    expect(shouldInjectProjectTaskSkill(projectSkill, {
      appType: 'project_tasks',
      appMeta: { project_id: 'project-1', task_id: 'task-1' },
    })).toBe(true)
    // 普通聊天没有权威锚点，不能把 tabtin-project 放进 prompt。
    expect(shouldInjectProjectTaskSkill(projectSkill, { appType: 'chat' })).toBe(false)
    expect(shouldInjectProjectTaskSkill(projectSkill, {
      appType: 'project_task', appMeta: { project_id: 'project-1' },
    })).toBe(false)
    expect(shouldInjectProjectTaskSkill(projectSkill, {
      appType: 'project_task',
      appMeta: { project_id: 'project-1; rm -rf /', task_id: 'task-1' },
    })).toBe(false)
  })
})

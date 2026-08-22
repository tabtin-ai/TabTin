import { describe, expect, it } from 'vitest'
import { SYSTEM_SECTION_NAMES } from '@tabtin/agent-runtime/engine'
import {
  buildProjectTaskContextHook,
  resolveProjectTaskRuntimeContext,
} from '../src/hooks/project-task-context-hook.js'

describe('Project Task runtime context hook', () => {
  it('权威锚点优先：有 project_id+task_id 即解析，不依赖视觉 appType', () => {
    expect(resolveProjectTaskRuntimeContext({
      appType: 'project_task',
      appMeta: { project_id: 'project-1', task_id: 'task-1' },
    })).toEqual({ projectId: 'project-1', taskId: 'task-1' })
    // R2-1：视觉 Focus 已切到 tabdoc/chat，服务端权威仍写入 appMeta 锚点
    expect(resolveProjectTaskRuntimeContext({
      appType: 'tabdoc',
      appMeta: {
        project_id: 'project-1',
        task_id: 'task-1',
        current_doc_id: 'doc-1',
      },
    })).toEqual({ projectId: 'project-1', taskId: 'task-1' })
    expect(resolveProjectTaskRuntimeContext({
      appType: 'chat',
      appMeta: { project_id: 'project-1', task_id: 'task-1' },
    })).toEqual({ projectId: 'project-1', taskId: 'task-1' })
    expect(resolveProjectTaskRuntimeContext({
      appType: 'project_tasks',
      appMeta: { project_id: 'project-1', task_id: 'task-1' },
    })).toEqual({ projectId: 'project-1', taskId: 'task-1' })
    expect(resolveProjectTaskRuntimeContext({
      appType: 'project_task',
      appMeta: { project_id: 'project-1' },
    })).toBeNull()
    expect(resolveProjectTaskRuntimeContext({
      appType: 'chat',
      appMeta: null,
    })).toBeNull()
  })

  it('以 JSON system section 提供 project/task ID', async () => {
    const hook = buildProjectTaskContextHook({
      getAppContext: async () => ({
        appType: 'project_task',
        appMeta: { project_id: 'project-1', task_id: 'task-1' },
      }),
      getProjectTaskSkillContent: async () => '先读取 Task，再呈递同一资源。',
    })
    const sections: Array<{ name: string; content: string }> = []
    await hook.beforeModel!({
      iteration: 0,
      state: {} as never,
      appendSystemSection: (name, content) => sections.push({ name, content }),
    } as never)

    expect(sections).toEqual([{
      name: SYSTEM_SECTION_NAMES.project_task_context,
      content: expect.stringContaining('"project_id":"project-1"'),
    }])
    expect(sections[0]!.content).toContain('"task_id":"task-1"')
    expect(sections[0]!.content).toContain('<project_task_workflow>')
    expect(sections[0]!.content).toContain('先读取 Task，再呈递同一资源。')
  })

  it('拒绝不能安全作为 CLI 参数的 ID', () => {
    expect(resolveProjectTaskRuntimeContext({
      appType: 'project_task',
      appMeta: { project_id: 'project-1; rm -rf /', task_id: 'task-1' },
    })).toBeNull()
    expect(resolveProjectTaskRuntimeContext({
      appType: 'project_task',
      appMeta: { project_id: 'p'.repeat(257), task_id: 'task-1' },
    })).toBeNull()
  })

  it('普通聊天不产生 system section', async () => {
    const hook = buildProjectTaskContextHook({
      getAppContext: async () => ({ appType: 'chat', appMeta: null }),
    })
    const appendSystemSection = () => { throw new Error('must not inject') }
    await hook.beforeModel!({
      iteration: 0,
      state: {} as never,
      appendSystemSection,
    } as never)
  })

  it('视觉 chat Focus + 权威锚点仍注入 system section', async () => {
    const hook = buildProjectTaskContextHook({
      getAppContext: async () => ({
        appType: 'chat',
        appMeta: { project_id: 'project-1', task_id: 'task-1' },
      }),
    })
    const sections: Array<{ name: string; content: string }> = []
    await hook.beforeModel!({
      iteration: 0,
      state: {} as never,
      appendSystemSection: (name, content) => sections.push({ name, content }),
    } as never)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe(SYSTEM_SECTION_NAMES.project_task_context)
    expect(sections[0]!.content).toContain('"project_id":"project-1"')
  })
})
